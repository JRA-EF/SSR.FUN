use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use super::accrue_fees::checkpoint_tvl_accrual;
use super::common::{credit_manager_fee_shares, load_asset_legs, mul_div_ceil, transfer_into_vault};
use crate::constants::{
    BPS_DENOMINATOR, MANAGER_FEE_RECIPIENTS_SEED, MINT_AUTHORITY_SEED, MIN_SEED_AMOUNT_PER_ASSET,
    PROTOCOL_CONFIG_SEED, PROTOCOL_MIN_MINT_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    TVL_ACCRUAL_SEED,
};
use crate::errors::SsrError;
use crate::events::{ManagerFeeAccrualSource, ProtocolMintFeeTransferred, ReserveSeeded};
use crate::fee_math::{split_configured_bps, split_total_fee};
use crate::state::{ManagerFeeRecipients, ProtocolConfig, Reserve, ReserveStatus, TvlAccrual};

#[derive(Accounts)]
pub struct SeedReserve<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        has_one = manager @ SsrError::NotReserveManager,
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

    /// CHECK: signer-only PDA, verified purely by seeds against the cached
    /// bump from `create_reserve`.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = manager,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = manager,
    )]
    pub manager_reserve_token_account: Account<'info, SplTokenAccount>,

    #[account(mut)]
    pub manager: Signer<'info>,

    /// Instant Protocol mint-fee transfer (this pass, see
    /// docs/project/DECISION_LOG.md): the initial seed mint is a mint like
    /// any other -- the Protocol's share of ITS fee is minted directly
    /// here, in the same atomic transaction, never accrued as pending.
    /// `manager` fronts this ATA's rent if it doesn't exist yet.
    ///
    /// Option (2026-08-17 corrective pass, see docs/project/DECISION_LOG.md):
    /// when `protocol_fee_destination` IS the manager's own wallet, this
    /// account's associated_token derivation would resolve to the exact
    /// same address as `manager_reserve_token_account` below -- two separate
    /// mutable `Account<'info, TokenAccount>` slots resolving to one
    /// underlying account, which Anchor's own ConstraintDuplicateMutableAccount
    /// safety check rejects unconditionally, before this handler ever runs
    /// (confirmed live: DevNet error 2040). The client detects this ahead of
    /// time and passes this program's own ID as the explicit "None" sentinel
    /// instead -- the same convention already used for `manager_fee_recipients`
    /// below (see `common::credit_manager_fee_shares`'s doc comment). The
    /// handler verifies the omission actually matches reality rather than
    /// trusting it blindly (SsrError::ProtocolFeeDestinationTokenAccountRequired).
    #[account(
        init_if_needed,
        payer = manager,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = protocol_fee_destination,
    )]
    pub protocol_fee_destination_token_account: Option<Account<'info, SplTokenAccount>>,
    /// CHECK: only used as the associated-token-account authority above;
    /// must equal `protocol_config.default_protocol_fee_destination`,
    /// checked in the handler.
    pub protocol_fee_destination: UncheckedAccount<'info>,

    /// Time-weighted average TVL accumulator (2026-08-14 pass) -- the
    /// initial seed mint checkpoints it too, same as every other mint. See
    /// `accrue_fees::checkpoint_tvl_accrual`'s doc comment.
    #[account(
        init_if_needed,
        payer = manager,
        space = TvlAccrual::SPACE,
        seeds = [TVL_ACCRUAL_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub tvl_accrual: Account<'info, TvlAccrual>,

    /// Optional (DEC-0094 sentinel pattern, see common::credit_manager_fee_shares):
    /// pass the program ID itself for a Reserve that hasn't opted into
    /// multi-recipient routing (the overwhelmingly common case at seed time,
    /// since seeding is the FIRST mint -- but a creator can bundle
    /// initializeManagerFeeRecipients into the same create-and-register
    /// transaction, so this must still be handled here too).
    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, manager_asset_token_account, mint, token_program]
    // in ReserveAsset.order_index order. See instructions/common.rs::load_asset_legs.
}

pub fn handler<'info>(
    ctx: Context<'info, SeedReserve<'info>>,
    seed_amounts: Vec<u64>,
    initial_reserve_tokens: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.paused,
        SsrError::ProtocolPaused
    );
    require!(
        ctx.accounts.reserve.status == ReserveStatus::AssetsInitializing,
        SsrError::UnexpectedReserveStatus
    );
    require!(
        ctx.accounts.reserve.asset_count > 0,
        SsrError::UnexpectedReserveStatus
    );
    require!(initial_reserve_tokens > 0, SsrError::ZeroValue);
    require_eq!(
        seed_amounts.len(),
        ctx.accounts.reserve.asset_count as usize,
        SsrError::RemainingAccountsMismatch
    );
    require_keys_eq!(
        ctx.accounts.protocol_fee_destination.key(),
        ctx.accounts
            .protocol_config
            .default_protocol_fee_destination,
        SsrError::InvalidFeeShareSplit
    );
    // See the doc comment on `protocol_fee_destination_token_account` above:
    // an omitted account is only ever valid when the Protocol fee-destination
    // wallet genuinely IS the manager's own -- verified here, never trusted
    // blindly, so a caller can never dodge paying the Protocol's genuine fee
    // share by mis-omitting this account for some OTHER wallet.
    let collapse_protocol_fee_into_manager =
        ctx.accounts.protocol_fee_destination_token_account.is_none();
    if collapse_protocol_fee_into_manager {
        require_keys_eq!(
            ctx.accounts.protocol_fee_destination.key(),
            ctx.accounts.manager.key(),
            SsrError::ProtocolFeeDestinationTokenAccountRequired
        );
    }

    let reserve_key = ctx.accounts.reserve.key();
    let mut legs = load_asset_legs(
        &ctx.accounts.reserve,
        &reserve_key,
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    let mut asset_mints = Vec::with_capacity(legs.len());
    let mut asset_amounts = Vec::with_capacity(legs.len());

    for (leg, &amount) in legs.iter_mut().zip(seed_amounts.iter()) {
        require!(
            amount >= MIN_SEED_AMOUNT_PER_ASSET,
            SsrError::SeedAmountTooLow
        );
        transfer_into_vault(leg, &ctx.accounts.manager.to_account_info(), amount)?;

        // Mirrors the reference protocol's own `initialize()` assertion
        // (Folio.sol lines 247-248): every basket asset's vault must
        // actually hold a nonzero balance before any Reserve Token is
        // minted. Reloading (rather than trusting the transfer call above
        // didn't error) is cheap insurance against a token program that
        // silently no-ops a transfer instead of erroring.
        leg.vault.reload()?;
        require!(leg.vault.amount > 0, SsrError::SeedAmountTooLow);

        asset_mints.push(leg.mint.key());
        asset_amounts.push(amount);
    }

    // The initial seed is a mint like any other -- see
    // mint_reserve_tokens_in_kind.rs's identical formula. Previously
    // fee-free (a genuine bug: the creator's own inception mint was the one
    // mint event that never generated Protocol or Manager revenue).
    // `initial_reserve_tokens` is treated as the GROSS requested amount,
    // exactly like `reserve_tokens_requested` in a normal mint; the creator
    // receives the NET amount after the fee, never the full gross figure.
    let configured_mint_fee_bps = ctx.accounts.reserve.fee_config.mint_fee_bps;
    let (protocol_bps, manager_bps) =
        split_configured_bps(configured_mint_fee_bps, PROTOCOL_MIN_MINT_FEE_BPS);
    let effective_total_bps = (protocol_bps as u64)
        .checked_add(manager_bps as u64)
        .ok_or(error!(SsrError::MathOverflow))?;
    let mint_fee_shares = mul_div_ceil(
        initial_reserve_tokens,
        effective_total_bps,
        BPS_DENOMINATOR as u64,
    )?;
    let net_shares_out = initial_reserve_tokens
        .checked_sub(mint_fee_shares)
        .ok_or(error!(SsrError::MathUnderflow))?;
    require!(net_shares_out > 0, SsrError::ZeroAmountAfterFeesOrRounding);
    let (protocol_fee_shares, manager_fee_shares) =
        split_total_fee(mint_fee_shares, protocol_bps, manager_bps)?;

    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    let now = Clock::get()?.unix_timestamp;
    // 2026-08-14 pass: the initial seed mint checkpoints the TVL accumulator
    // too, on the pre-mint (zero) supply -- see
    // accrue_fees::checkpoint_tvl_accrual's doc comment.
    checkpoint_tvl_accrual(
        &mut ctx.accounts.tvl_accrual,
        reserve_key,
        ctx.bumps.tvl_accrual,
        0,
        now,
    )?;
    {
        let reserve = &mut ctx.accounts.reserve;
        reserve.status = ReserveStatus::Active;
        reserve.configured_at = now;
        // Informational telemetry only, mirroring mint_reserve_tokens_in_kind.rs.
        reserve.fee_config.manager_fee_share_bps = manager_bps;
        reserve.fee_config.protocol_fee_share_bps = protocol_bps;
    }
    credit_manager_fee_shares(
        &mut ctx.accounts.reserve,
        &mut ctx.accounts.manager_fee_recipients,
        manager_fee_shares,
        ManagerFeeAccrualSource::MintFee,
    )?;

    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[mint_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];

    // Instant Protocol mint-fee transfer (this pass): mints the Protocol's
    // share of the initial seed's fee directly to its treasury ATA in this
    // SAME transaction -- never accrued as pending. See
    // docs/project/DECISION_LOG.md's entry for this pass.
    //
    // 2026-08-17 pass: when the Protocol fee-destination wallet IS the
    // manager's own (collapse_protocol_fee_into_manager, checked above), a
    // SEPARATE mint CPI into protocol_fee_destination_token_account isn't
    // possible -- that account was omitted precisely because it would
    // resolve to the exact same ATA as manager_reserve_token_account. The
    // Protocol's share is not dropped or redirected: it's minted in the
    // SAME single CPI as the manager's own net share, to that one shared
    // account, preserving the exact combined total.
    if collapse_protocol_fee_into_manager {
        let combined_amount = protocol_fee_shares
            .checked_add(net_shares_out)
            .ok_or(error!(SsrError::MathOverflow))?;
        let cpi_accounts = MintTo {
            mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.manager_reserve_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token::mint_to(cpi_ctx, combined_amount)?;
    } else {
        if protocol_fee_shares > 0 {
            let protocol_fee_destination_token_account = ctx
                .accounts
                .protocol_fee_destination_token_account
                .as_ref()
                .ok_or(error!(SsrError::ProtocolFeeDestinationTokenAccountRequired))?;
            let protocol_cpi_accounts = MintTo {
                mint: ctx.accounts.reserve_token_mint.to_account_info(),
                to: protocol_fee_destination_token_account.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            };
            let protocol_cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                protocol_cpi_accounts,
                signer_seeds,
            );
            token::mint_to(protocol_cpi_ctx, protocol_fee_shares)?;
        }

        let cpi_accounts = MintTo {
            mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.manager_reserve_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token::mint_to(cpi_ctx, net_shares_out)?;
    }

    emit!(ReserveSeeded {
        reserve: reserve_key,
        initial_reserve_tokens: net_shares_out,
        mint_fee_reserve_tokens: mint_fee_shares,
        asset_mints,
        asset_amounts,
        ts: now,
    });
    if protocol_fee_shares > 0 {
        emit!(ProtocolMintFeeTransferred {
            reserve: reserve_key,
            reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
            amount: protocol_fee_shares,
            destination: ctx.accounts.protocol_fee_destination.key(),
            ts: now,
        });
    }

    Ok(())
}
