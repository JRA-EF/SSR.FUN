use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use super::accrue_fees::checkpoint_tvl_accrual;
use super::common::{load_asset_legs, mul_div_ceil, transfer_into_vault, init_fee_settlement_if_needed};
use crate::constants::{
    BPS_DENOMINATOR, FEE_SETTLEMENT_SEED, FEE_VAULT_AUTHORITY_SEED, MINT_AUTHORITY_SEED,
    PROTOCOL_CONFIG_SEED, PROTOCOL_MIN_MINT_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    TVL_ACCRUAL_SEED,
};
use crate::errors::SsrError;
use crate::events::{FeeVaultCredited, ManagerFeeAccrualSource, ReserveTokensMinted};
use crate::fee_math::{split_configured_bps, split_total_fee};
use crate::state::{FeeSettlement, ProtocolConfig, Reserve, ReserveStatus, TvlAccrual};

#[derive(Accounts)]
pub struct MintReserveTokensInKind<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
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

    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = depositor,
    )]
    pub depositor_reserve_token_account: Account<'info, SplTokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    /// USDC fee-settlement pipeline (2026-08-21 pass, see
    /// docs/project/DECISION_LOG.md): BOTH the Protocol's and the Manager's
    /// mint-fee shares now crystallize together into this shared fee vault
    /// (replacing the old instant-mint-to-treasury / pending-counter
    /// destinations) -- see `fee_vault`/`fee_vault_authority` below and
    /// `redeem_fee_vault_shares.rs` for what happens to them next.
    /// `init_if_needed` on this Reserve's very first-ever fee crystallization.
    #[account(
        init_if_needed,
        payer = depositor,
        space = FeeSettlement::SPACE,
        seeds = [FEE_SETTLEMENT_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub fee_settlement: Account<'info, FeeSettlement>,

    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = fee_vault_authority,
    )]
    pub fee_vault: Account<'info, SplTokenAccount>,

    /// CHECK: signer-only PDA (mint authority is `mint_authority` above,
    /// same as every other mint destination in this instruction -- this
    /// account is only the fee vault's ATA *owner*, verified purely by
    /// seeds against the cached bump).
    #[account(
        seeds = [FEE_VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub fee_vault_authority: UncheckedAccount<'info>,

    /// Time-weighted average TVL accumulator (2026-08-14 pass) -- checkpointed
    /// here for free (cheap arithmetic, no CPI), never settled here. See
    /// `accrue_fees::checkpoint_tvl_accrual`'s doc comment. Lazily created on
    /// this Reserve's first-ever checkpoint call.
    #[account(
        init_if_needed,
        payer = depositor,
        space = TvlAccrual::SPACE,
        seeds = [TVL_ACCRUAL_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub tvl_accrual: Account<'info, TvlAccrual>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, depositor_asset_token_account, mint, token_program]
    // in ReserveAsset.order_index order. See instructions/common.rs::load_asset_legs.
}

pub fn handler<'info>(
    ctx: Context<'info, MintReserveTokensInKind<'info>>,
    reserve_tokens_requested: u64,
    min_reserve_tokens_out: u64,
    max_asset_amounts: Vec<u64>,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.paused,
        SsrError::ProtocolPaused
    );
    require!(
        ctx.accounts.reserve.status == ReserveStatus::Active,
        SsrError::UnexpectedReserveStatus
    );
    require!(reserve_tokens_requested > 0, SsrError::ZeroValue);
    require_eq!(
        max_asset_amounts.len(),
        ctx.accounts.reserve.asset_count as usize,
        SsrError::RemainingAccountsMismatch
    );

    // Snapshot supply/balances BEFORE any transfer -- the entire mint
    // requirement is computed on the pre-transaction ratio, matching the
    // reference protocol's `_toAssets(shares, Ceil)` (RESERVE_REFERENCE_ANALYSIS.md
    // section 4/14).
    let total_supply_before = ctx.accounts.reserve_token_mint.supply;
    require!(total_supply_before > 0, SsrError::ZeroSupply);

    // 2026-08-14 pass: piggyback the TVL accumulator CHECKPOINT (not
    // settlement -- see checkpoint_tvl_accrual's doc comment) onto this
    // mint, on the pre-mint supply, so the weekly settlement always has an
    // accurate time-weighted history even between keeper runs.
    let reserve_key_for_tvl = ctx.accounts.reserve.key();
    checkpoint_tvl_accrual(
        &mut ctx.accounts.tvl_accrual,
        reserve_key_for_tvl,
        ctx.bumps.tvl_accrual,
        total_supply_before,
        Clock::get()?.unix_timestamp,
    )?;

    let reserve_key = ctx.accounts.reserve.key();
    let legs = load_asset_legs(
        &ctx.accounts.reserve,
        &reserve_key,
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    let mut asset_mints = Vec::with_capacity(legs.len());
    let mut asset_amounts_in = Vec::with_capacity(legs.len());

    for (i, leg) in legs.iter().enumerate() {
        let vault_balance_before = leg.vault.amount;
        let required_amount = mul_div_ceil(
            reserve_tokens_requested,
            vault_balance_before,
            total_supply_before,
        )?;
        require!(
            required_amount <= max_asset_amounts[i],
            SsrError::SlippageMaxInputExceeded
        );

        transfer_into_vault(
            leg,
            &ctx.accounts.depositor.to_account_info(),
            required_amount,
        )?;

        asset_mints.push(leg.mint.key());
        asset_amounts_in.push(required_amount);
    }

    // DEC-0094: `mint_fee_bps` is the configured (manager-set) gross rate;
    // the EFFECTIVE total actually charged is derived fresh here via the
    // SSR.fun fee formula, and can exceed `mint_fee_bps` when it's below
    // the Protocol's 0.5% floor -- see fee_math::split_configured_bps.
    let configured_mint_fee_bps = ctx.accounts.reserve.fee_config.mint_fee_bps;
    let (protocol_bps, manager_bps) =
        split_configured_bps(configured_mint_fee_bps, PROTOCOL_MIN_MINT_FEE_BPS);
    let effective_total_bps = (protocol_bps as u64)
        .checked_add(manager_bps as u64)
        .ok_or(error!(SsrError::MathOverflow))?;
    let mint_fee_shares = mul_div_ceil(
        reserve_tokens_requested,
        effective_total_bps,
        BPS_DENOMINATOR as u64,
    )?;
    let net_shares_out = reserve_tokens_requested
        .checked_sub(mint_fee_shares)
        .ok_or(error!(SsrError::MathUnderflow))?;
    require!(net_shares_out > 0, SsrError::ZeroAmountAfterFeesOrRounding);
    require!(
        net_shares_out >= min_reserve_tokens_out,
        SsrError::SlippageMinOutputNotMet
    );

    // protocol_fee_shares floor+exact-remainder split from mint_fee_shares
    // (DEC-0094: divides by effective_total_bps, NOT BPS_DENOMINATOR -- see
    // fee_math::split_total_fee's doc comment for why the pre-DEC-0094
    // divisor would be wrong here).
    let (protocol_fee_shares, manager_fee_shares) =
        split_total_fee(mint_fee_shares, protocol_bps, manager_bps)?;

    {
        let reserve = &mut ctx.accounts.reserve;
        // Informational telemetry only (DEC-0094) -- see the doc comment on
        // these two fields in state/reserve.rs. Reflects the mint fee's
        // effective split specifically (not the TVL fee's, which can
        // differ); never read for control flow.
        reserve.fee_config.manager_fee_share_bps = manager_bps;
        reserve.fee_config.protocol_fee_share_bps = protocol_bps;
    }

    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[mint_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];

    // Depositor's own net share, unchanged.
    let cpi_accounts = MintTo {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        to: ctx
            .accounts
            .depositor_reserve_token_account
            .to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token::mint_to(cpi_ctx, net_shares_out)?;

    // USDC fee-settlement pipeline (2026-08-21 pass): BOTH shares crystallize
    // together into the shared fee vault, in the SAME single CPI -- no more
    // ConstraintDuplicateMutableAccount collision risk to guard against
    // (the fee vault is always one single, always-distinct account, never
    // colliding with depositor_reserve_token_account).
    if mint_fee_shares > 0 {
        let vault_cpi_accounts = MintTo {
            mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.fee_vault.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let vault_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            vault_cpi_accounts,
            signer_seeds,
        );
        token::mint_to(vault_cpi_ctx, mint_fee_shares)?;

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
            source: ManagerFeeAccrualSource::MintFee,
            ts: Clock::get()?.unix_timestamp,
        });
    }

    let now = Clock::get()?.unix_timestamp;
    emit!(ReserveTokensMinted {
        reserve: reserve_key,
        depositor: ctx.accounts.depositor.key(),
        reserve_tokens_out: net_shares_out,
        mint_fee_reserve_tokens: mint_fee_shares,
        asset_mints,
        asset_amounts_in,
        ts: now,
    });

    Ok(())
}
