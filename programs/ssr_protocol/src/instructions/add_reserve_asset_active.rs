//! Adds a new, zero-balance Reserve Asset to an already-`Active` Reserve.
//! Deliberately a SEPARATE instruction from `initialize_reserve_asset`
//! (rather than loosening that one's status check) so the pre-Active
//! creation flow -- already live-verified across Phases A-D -- keeps its
//! exact existing account interface and behavior, with zero regression risk.
//! See Phase F security analysis in
//! docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md for why this is
//! config-only (adds the asset's *registration*; funding it is a separate
//! step -- see `fund_new_reserve_asset` -- and no rebalance execution is
//! implied or performed here).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::common::{require_reserve_permission, validate_asset_mint_extensions};
use crate::constants::{
    BPS_DENOMINATOR, PROTOCOL_CONFIG_SEED, RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED,
    VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveAssetAdded;
use crate::state::{
    permission_flags, ProtocolConfig, Reserve, ReserveAsset, ReserveStatus, TokenProgramKind,
};

#[derive(Accounts)]
pub struct AddReserveAssetActive<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        init,
        payer = signer,
        space = ReserveAsset::SPACE,
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub reserve_asset: Account<'info, ReserveAsset>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = signer,
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault_authority,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached
    /// bump -- same pattern as `initialize_reserve_asset`.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: only deserialized/validated when `signer != reserve.manager`;
    /// see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'info, AddReserveAssetActive<'info>>,
    target_weight_bps: u16,
) -> Result<()> {
    require!(
        ctx.accounts.reserve.status == ReserveStatus::Active,
        SsrError::UnexpectedReserveStatus
    );

    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::MANAGE_LIQUIDITY_CONFIG,
        ctx.program_id,
    )?;

    let reserve = &ctx.accounts.reserve;
    require!(
        reserve.asset_count < ctx.accounts.protocol_config.max_reserve_assets,
        SsrError::ReserveAssetLimitReached
    );
    require!(
        reserve
            .total_target_weight_bps
            .checked_add(target_weight_bps)
            .ok_or(error!(SsrError::MathOverflow))?
            <= BPS_DENOMINATOR,
        SsrError::TargetWeightExceedsTotal
    );

    let token_program_id = ctx.accounts.token_program.key();
    validate_asset_mint_extensions(
        &ctx.accounts.asset_mint.to_account_info(),
        &token_program_id,
    )?;
    let token_program_kind = if token_program_id == anchor_spl::token::ID {
        TokenProgramKind::SplToken
    } else {
        TokenProgramKind::Token2022
    };

    let order_index = reserve.asset_count;
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.reserve_asset.set_inner(ReserveAsset {
        reserve: reserve_key,
        asset_mint: ctx.accounts.asset_mint.key(),
        vault: ctx.accounts.vault.key(),
        token_program: token_program_kind,
        decimals: ctx.accounts.asset_mint.decimals,
        target_weight_bps,
        enabled: true,
        order_index,
        bump: ctx.bumps.reserve_asset,
    });

    let reserve = &mut ctx.accounts.reserve;
    reserve.asset_count = reserve
        .asset_count
        .checked_add(1)
        .ok_or(error!(SsrError::MathOverflow))?;
    reserve.total_target_weight_bps = reserve
        .total_target_weight_bps
        .checked_add(target_weight_bps)
        .ok_or(error!(SsrError::MathOverflow))?;
    reserve.configured_at = now;

    emit!(ReserveAssetAdded {
        reserve: reserve_key,
        asset_mint: ctx.accounts.asset_mint.key(),
        vault: ctx.accounts.vault.key(),
        target_weight_bps,
        order_index,
        added_by: ctx.accounts.signer.key(),
        ts: now,
    });

    Ok(())
}
