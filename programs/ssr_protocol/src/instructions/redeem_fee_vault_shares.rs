//! USDC fee-settlement pipeline, step 1 of 3 (2026-08-21 pass, see
//! docs/project/DECISION_LOG.md): burns `shares` (<= the fee vault's current
//! real balance) from the shared fee vault and stages the proportional
//! per-asset entitlement -- computed with the EXACT same math
//! `redeem_reserve_tokens_in_kind` already uses for a normal Sell -- into
//! each asset's own settlement staging ATA (owned by `settlement_authority`,
//! never a caller-controlled account, see `common::require_canonical_ata`).
//!
//! Permissionless, matching `accrue_fees`/`collect_protocol_fee`'s existing
//! convention: money can only ever move from the Reserve's own vaults into
//! the Reserve's own staging accounts, never anywhere a caller controls, so
//! there is no reason to gate who can trigger it -- redeeming EARLIER rather
//! than later only ever benefits the settlement pipeline (gets assets ready
//! for the keeper to swap sooner).
//!
//! Staging ATAs are NOT `init_if_needed` here (remaining_accounts are raw,
//! untyped `AccountInfo`s, like every other mint/redeem call's asset legs in
//! this program) -- the caller's transaction must bundle an idempotent ATA-
//! creation instruction for each staging ATA first, same client-side
//! responsibility this program already places on every mint/seed caller for
//! their own asset legs.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint as SplMint, Token, TokenAccount as SplTokenAccount};

use super::common::{load_asset_legs, mul_div_floor, require_canonical_ata, transfer_out_of_vault};
use crate::constants::{
    FEE_SETTLEMENT_SEED, FEE_VAULT_AUTHORITY_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    SETTLEMENT_AUTHORITY_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::FeeSharesRedeemed;
use crate::fee_math::split_by_weight;
use crate::state::{FeeSettlement, Reserve};

#[derive(Accounts)]
pub struct RedeemFeeVaultShares<'info> {
    #[account(
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

    #[account(
        mut,
        seeds = [FEE_SETTLEMENT_SEED, reserve.key().as_ref()],
        bump = fee_settlement.bump,
        constraint = fee_settlement.reserve == reserve.key() @ SsrError::FeeSettlementReserveMismatch,
    )]
    pub fee_settlement: Account<'info, FeeSettlement>,

    #[account(
        mut,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = fee_vault_authority,
    )]
    pub fee_vault: Account<'info, SplTokenAccount>,

    /// CHECK: signer-only PDA (burn authority for the fee vault), verified
    /// purely by seeds against `fee_settlement`'s cached bump.
    #[account(
        seeds = [FEE_VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = fee_settlement.fee_vault_authority_bump,
    )]
    pub fee_vault_authority: UncheckedAccount<'info>,

    /// CHECK: signer-only PDA that OWNS every settlement staging ATA --
    /// never itself signs anything in this instruction, only used to verify
    /// each `remaining_accounts` staging ATA is the genuine canonical one
    /// (see `common::require_canonical_ata`), not a caller-redirectable
    /// account.
    #[account(
        seeds = [SETTLEMENT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = fee_settlement.settlement_authority_bump,
    )]
    pub settlement_authority: UncheckedAccount<'info>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached
    /// bump -- the Reserve's EXISTING vault authority (unrelated to the two
    /// new authorities above), same one `redeem_reserve_tokens_in_kind`
    /// already uses to move real per-asset vault balances.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, settlement_staging_ata, mint, token_program]
    // in ReserveAsset.order_index order -- identical shape to every other
    // mint/redeem call's asset legs (see instructions/common.rs::load_asset_legs).
}

pub fn handler<'info>(
    ctx: Context<'info, RedeemFeeVaultShares<'info>>,
    shares: u64,
) -> Result<()> {
    require!(shares > 0, SsrError::ZeroValue);
    require!(
        shares <= ctx.accounts.fee_vault.amount,
        SsrError::FeeSettlementInsufficientBalance
    );

    // Pre-burn snapshot -- matches redeem_reserve_tokens_in_kind's own
    // ordering (entitlement computed on the supply/balances as they stood
    // BEFORE this call's own burn+transfers).
    let total_supply_before = ctx.accounts.reserve_token_mint.supply;
    require!(total_supply_before > 0, SsrError::ZeroSupply);

    let (protocol_redeemed, manager_redeemed) = split_by_weight(
        shares,
        ctx.accounts.fee_settlement.protocol_shares_in_vault,
        ctx.accounts.fee_settlement.manager_shares_in_vault,
    )?;

    let reserve_key = ctx.accounts.reserve.key();
    let legs = load_asset_legs(
        &ctx.accounts.reserve,
        &reserve_key,
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    let settlement_authority_key = ctx.accounts.settlement_authority.key();
    let mut entitlements = Vec::with_capacity(legs.len());
    for leg in legs.iter() {
        require_canonical_ata(
            &leg.owner_token_account,
            &settlement_authority_key,
            &leg.mint.key(),
            &leg.token_program,
        )?;
        let vault_balance_before = leg.vault.amount;
        let entitlement = mul_div_floor(shares, vault_balance_before, total_supply_before)?;
        entitlements.push(entitlement);
    }

    // Burn from the fee vault, signed by fee_vault_authority.
    let fee_vault_authority_bump = ctx.accounts.fee_settlement.fee_vault_authority_bump;
    let fee_vault_authority_seeds: &[&[u8]] = &[
        FEE_VAULT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[fee_vault_authority_bump],
    ];
    let burn_signer_seeds: &[&[&[u8]]] = &[fee_vault_authority_seeds];
    let burn_cpi_accounts = Burn {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        from: ctx.accounts.fee_vault.to_account_info(),
        authority: ctx.accounts.fee_vault_authority.to_account_info(),
    };
    let burn_cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        burn_cpi_accounts,
        burn_signer_seeds,
    );
    token::burn(burn_cpi_ctx, shares)?;

    // Transfer each real vault's entitlement into its staging ATA, signed by
    // the Reserve's existing vault_authority -- identical mechanics to a
    // normal Sell's payout leg.
    let vault_authority_bump = ctx.accounts.reserve.vault_authority_bump;
    let vault_authority_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[vault_authority_bump],
    ];
    let vault_authority_ai = ctx.accounts.vault_authority.to_account_info();

    let mut asset_mints = Vec::with_capacity(legs.len());
    for (leg, &amount) in legs.iter().zip(entitlements.iter()) {
        if amount > 0 {
            transfer_out_of_vault(leg, &vault_authority_ai, vault_authority_seeds, amount)?;
        }
        asset_mints.push(leg.mint.key());
    }

    let fee_settlement = &mut ctx.accounts.fee_settlement;
    fee_settlement.protocol_shares_in_vault = fee_settlement
        .protocol_shares_in_vault
        .checked_sub(protocol_redeemed)
        .ok_or(error!(SsrError::MathUnderflow))?;
    fee_settlement.manager_shares_in_vault = fee_settlement
        .manager_shares_in_vault
        .checked_sub(manager_redeemed)
        .ok_or(error!(SsrError::MathUnderflow))?;
    fee_settlement.protocol_shares_pending_settlement = fee_settlement
        .protocol_shares_pending_settlement
        .checked_add(protocol_redeemed)
        .ok_or(error!(SsrError::MathOverflow))?;
    fee_settlement.manager_shares_pending_settlement = fee_settlement
        .manager_shares_pending_settlement
        .checked_add(manager_redeemed)
        .ok_or(error!(SsrError::MathOverflow))?;

    emit!(FeeSharesRedeemed {
        reserve: reserve_key,
        shares_redeemed: shares,
        protocol_shares_redeemed: protocol_redeemed,
        manager_shares_redeemed: manager_redeemed,
        asset_mints,
        asset_amounts_staged: entitlements,
        redeemed_by: ctx.accounts.payer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
