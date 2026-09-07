use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use crate::constants::{
    BPS_DENOMINATOR, FEE_SETTLEMENT_SEED, FEE_VAULT_AUTHORITY_SEED, MINT_AUTHORITY_SEED,
    PROTOCOL_CONFIG_SEED, PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    SCHEMA_VERSION, SECONDS_PER_YEAR, TVL_ACCRUAL_SEED,
};
use crate::errors::SsrError;
use crate::events::{FeeVaultCredited, ManagerFeeAccrualSource};
use crate::fee_math::split_configured_bps;
use super::common::init_fee_settlement_if_needed;
use crate::state::{FeeSettlement, ProtocolConfig, Reserve, TvlAccrual};

/// Permissionless, matching the reference protocol's own `distributeFees`
/// being callable by anyone (RESERVE_REFERENCE_ANALYSIS.md section 8) --
/// settlement is pure accounting plus a mint the Reserve's own fee config
/// authorizes, so there is no reason to gate who can trigger it. This is
/// the ONLY instruction that ever actually SETTLES (mints BOTH shares to
/// the shared fee vault -- see `FeeSettlement`/`redeem_fee_vault_shares.rs`,
/// 2026-08-21 pass) the Annualized TVL fee -- see `checkpoint_tvl_accrual`'s
/// doc comment for why mint/redeem/seed only ever cheaply CHECKPOINT the
/// time-weighted accumulator, never settle.
///
/// 2026-08-14 pass (see docs/project/DECISION_LOG.md): replaced the earlier
/// linear "days since last snapshot x latest supply" approximation with a
/// genuine time-weighted average, backed by `TvlAccrual`'s cumulative
/// accumulator (`state/tvl_accrual.rs`). `api/devnet/accrue-fees-cron.ts`'s
/// weekly keeper calls this permissionlessly for every known Reserve; a
/// normal mint/redeem/seed opportunistically checkpoints the accumulator for
/// free but never replaces that weekly fallback (see this instruction's own
/// settlement gate below, which only this instruction ever crosses).
#[derive(Accounts)]
pub struct AccrueFees<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
    )]
    pub reserve_token_mint: Account<'info, SplMint>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached bump.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// Lazily created on this Reserve's very first `accrue_fees`/checkpoint
    /// call (every Reserve that existed before this pass has none yet) --
    /// see `checkpoint_tvl_accrual`'s doc comment for the exact
    /// initialization semantics.
    #[account(
        init_if_needed,
        payer = payer,
        space = TvlAccrual::SPACE,
        seeds = [TVL_ACCRUAL_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub tvl_accrual: Account<'info, TvlAccrual>,

    /// USDC fee-settlement pipeline (2026-08-21 pass, see
    /// docs/project/DECISION_LOG.md): BOTH the Protocol's and the Manager's
    /// settled TVL-fee shares now crystallize together into this shared fee
    /// vault (replacing the old instant-mint-to-treasury / pending-counter
    /// destinations). `init_if_needed` on this Reserve's very first-ever fee
    /// crystallization.
    #[account(
        init_if_needed,
        payer = payer,
        space = FeeSettlement::SPACE,
        seeds = [FEE_SETTLEMENT_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub fee_settlement: Account<'info, FeeSettlement>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = fee_vault_authority,
    )]
    pub fee_vault: Account<'info, SplTokenAccount>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached bump.
    #[account(
        seeds = [FEE_VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub fee_vault_authority: UncheckedAccount<'info>,

    /// Permissionless caller (typically the weekly keeper's own wallet, or
    /// anyone else who chooses to poke a settlement early): fronts this
    /// call's one-time rent for `tvl_accrual`/`fee_settlement`/`fee_vault`
    /// if any doesn't exist yet. Never a fund-custody role -- settlement
    /// only ever moves the Reserve's OWN already-accrued fee, nothing of
    /// this wallet's own.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'info, AccrueFees<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let supply = ctx.accounts.reserve_token_mint.supply;
    let reserve_key = ctx.accounts.reserve.key();

    checkpoint_tvl_accrual(
        &mut ctx.accounts.tvl_accrual,
        reserve_key,
        ctx.bumps.tvl_accrual,
        supply,
        now,
    )?;

    // No-op settlement: either this account was just created above (its
    // `last_settled_ts` starts at `now`, so nothing has elapsed yet) or a
    // previous call already settled everything up to `now`. Either way,
    // there's genuinely nothing new to bill -- not an error, since the
    // weekly keeper and opportunistic mint/redeem/seed checkpoints call this
    // path freely with zero risk of double-charging.
    let elapsed_since_settlement = now
        .checked_sub(ctx.accounts.tvl_accrual.last_settled_ts)
        .ok_or(error!(SsrError::MathUnderflow))?;
    if elapsed_since_settlement <= 0 || ctx.accounts.tvl_accrual.period_supply_seconds == 0 {
        return Ok(());
    }

    let configured_bps = ctx.accounts.reserve.fee_config.annual_tvl_fee_bps;
    let (protocol_bps, manager_bps) =
        split_configured_bps(configured_bps, PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS);
    let effective_total_bps = (protocol_bps as u128) + (manager_bps as u128);

    let period_supply_seconds = ctx.accounts.tvl_accrual.period_supply_seconds;
    // "time-weighted average TVL during the period x annualized fee rate x
    // elapsed seconds / 31,536,000" -- period_supply_seconds already IS
    // avg_supply * elapsed_seconds (that's what the accumulator sums), so
    // multiplying by the rate and dividing by SECONDS_PER_YEAR here is
    // exactly that formula; the elapsed-seconds terms cancel algebraically.
    let numerator = period_supply_seconds
        .checked_mul(effective_total_bps)
        .ok_or(error!(SsrError::MathOverflow))?;
    let denominator = (BPS_DENOMINATOR as u128)
        .checked_mul(SECONDS_PER_YEAR)
        .ok_or(error!(SsrError::MathOverflow))?;
    // Ceiling division -- fees round in the protocol's favor throughout
    // (DEC-0009 / RESERVE_REFERENCE_ANALYSIS.md section 14).
    let total_fee_shares_u128 = numerator
        .checked_add(denominator - 1)
        .ok_or(error!(SsrError::MathOverflow))?
        / denominator;
    let total_fee_shares =
        u64::try_from(total_fee_shares_u128).map_err(|_| error!(SsrError::MathOverflow))?;

    let (protocol_fee_shares, manager_fee_shares) =
        crate::fee_math::split_total_fee(total_fee_shares, protocol_bps, manager_bps)?;

    {
        let tvl_accrual = &mut ctx.accounts.tvl_accrual;
        tvl_accrual.period_supply_seconds = 0;
        tvl_accrual.last_settled_ts = now;
    }
    // Kept in sync purely so existing telemetry/UI reads of this legacy
    // field (e.g. discovery.ts's `lastFeeAccrualTs`, used to find dormant
    // Reserves) remain accurate -- never read for control flow here.
    ctx.accounts.reserve.fee_config.last_fee_accrual_ts = now;

    if total_fee_shares > 0 {
        let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
        let mint_authority_seeds: &[&[u8]] = &[
            MINT_AUTHORITY_SEED,
            reserve_key.as_ref(),
            &[mint_authority_bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.fee_vault.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token::mint_to(cpi_ctx, total_fee_shares)?;

        init_fee_settlement_if_needed(
            &mut ctx.accounts.fee_settlement,
            reserve_key,
            ctx.bumps.fee_settlement,
            ctx.program_id,
        )?;
        let fee_settlement = &mut ctx.accounts.fee_settlement;
        fee_settlement.protocol_shares_in_vault = fee_settlement
            .protocol_shares_in_vault
            .checked_add(protocol_fee_shares)
            .ok_or(error!(SsrError::MathOverflow))?;
        fee_settlement.manager_shares_in_vault = fee_settlement
            .manager_shares_in_vault
            .checked_add(manager_fee_shares)
            .ok_or(error!(SsrError::MathOverflow))?;

        emit!(FeeVaultCredited {
            reserve: reserve_key,
            protocol_shares: protocol_fee_shares,
            manager_shares: manager_fee_shares,
            source: ManagerFeeAccrualSource::AnnualTvlFee,
            ts: now,
        });
    }

    Ok(())
}

/// Brings `tvl_accrual.period_supply_seconds` current as of `now`, given the
/// Reserve Token supply AS IT STOOD immediately before whatever change (if
/// any) this call is piggybacking on -- i.e. the supply that was actually in
/// effect for the just-elapsed interval (mirrors the pre-transaction-supply
/// convention every mint/redeem/seed call site already uses). Called by
/// EVERY mint/redeem/seed (cheap: pure arithmetic, no CPI, no settlement) so
/// the accumulator tracks reality continuously as TVL changes; only the
/// standalone `accrue_fees` instruction (above) ever actually bills against
/// it.
///
/// Lazily initializes the account on its very first call for a Reserve
/// (every Reserve that existed before this pass has none yet): a fresh
/// account starts its clock at `now` with zero elapsed history, never
/// inventing a lookback period, and `last_settled_ts` also starts at `now`
/// so the very first settlement afterward correctly finds nothing to bill
/// until real time elapses.
///
/// Safe to call as often as any caller likes -- a same-timestamp call (e.g.
/// two instructions in one transaction) is a genuine no-op (`elapsed <= 0`).
pub fn checkpoint_tvl_accrual<'info>(
    tvl_accrual: &mut Account<'info, TvlAccrual>,
    reserve: Pubkey,
    bump: u8,
    supply_before: u64,
    now: i64,
) -> Result<()> {
    if tvl_accrual.reserve == Pubkey::default() {
        tvl_accrual.schema_version = SCHEMA_VERSION;
        tvl_accrual.reserve = reserve;
        tvl_accrual.period_supply_seconds = 0;
        tvl_accrual.last_checkpoint_ts = now;
        tvl_accrual.last_settled_ts = now;
        tvl_accrual.bump = bump;
        return Ok(());
    }

    let elapsed = now
        .checked_sub(tvl_accrual.last_checkpoint_ts)
        .ok_or(error!(SsrError::MathUnderflow))?;
    if elapsed <= 0 {
        return Ok(());
    }

    let delta = (supply_before as u128)
        .checked_mul(elapsed as u128)
        .ok_or(error!(SsrError::MathOverflow))?;
    tvl_accrual.period_supply_seconds = tvl_accrual
        .period_supply_seconds
        .checked_add(delta)
        .ok_or(error!(SsrError::MathOverflow))?;
    tvl_accrual.last_checkpoint_ts = now;
    Ok(())
}
