//! Removes a registered Reserve Asset. Narrower than a general "disable any
//! asset" instruction by design: `common::load_asset_legs` and
//! `load_reserve_asset_configs` require ALL `asset_count` legs, unfiltered by
//! `enabled`, in strict `order_index` order -- so an asset that's merely
//! flagged disabled would still have to be included in every mint/redeem/
//! update_targets call forever, which defeats the purpose. Actual removal is
//! the safe fix, restricted to the two cases that make it structurally safe
//! without renumbering or balance-draining logic:
//!   1. the target must be the LAST-registered asset (`order_index ==
//!      asset_count - 1`) -- no other asset's `order_index` needs to shift;
//!   2. its vault balance must be exactly zero -- removal can never strand
//!      value attributable to existing Reserve Token holders.
//!
//! Removing a non-last or non-empty asset is out of scope; see Phase F
//! security analysis in docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use super::common::require_reserve_permission;
use crate::constants::{RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED, VAULT_AUTHORITY_SEED};
use crate::errors::SsrError;
use crate::events::ReserveAssetRemoved;
use crate::state::{permission_flags, Reserve, ReserveAsset, ReserveStatus};

#[derive(Accounts)]
pub struct RemoveReserveAsset<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
        close = manager,
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump = reserve_asset.bump,
        constraint = reserve_asset.reserve == reserve.key() @ SsrError::ReserveAssetMismatch,
    )]
    pub reserve_asset: Account<'info, ReserveAsset>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump,
        address = reserve_asset.vault @ SsrError::InvalidReserveVault,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached bump.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: rent destination for the closed `ReserveAsset` and `vault`
    /// accounts is always the Reserve's root manager, never the calling
    /// delegate -- checked against `reserve.manager` via the address
    /// constraint below.
    #[account(mut, address = reserve.manager @ SsrError::NotReserveManager)]
    pub manager: UncheckedAccount<'info>,

    /// CHECK: only deserialized/validated when `signer != reserve.manager`;
    /// see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(ctx: Context<'info, RemoveReserveAsset<'info>>) -> Result<()> {
    let reserve = &ctx.accounts.reserve;
    require!(
        reserve.status == ReserveStatus::AssetsInitializing
            || reserve.status == ReserveStatus::Active
            || reserve.status == ReserveStatus::Paused,
        SsrError::UnexpectedReserveStatus
    );

    let reserve_key = reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::MANAGE_LIQUIDITY_CONFIG,
        ctx.program_id,
    )?;

    let reserve = &ctx.accounts.reserve;
    let last_index = reserve
        .asset_count
        .checked_sub(1)
        .ok_or(error!(SsrError::MathUnderflow))?;
    require_eq!(
        ctx.accounts.reserve_asset.order_index,
        last_index,
        SsrError::AssetNotLastRegistered
    );
    require!(ctx.accounts.vault.amount == 0, SsrError::VaultNotEmpty);

    let vault_authority_bump = reserve.vault_authority_bump;
    let vault_authority_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[vault_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[vault_authority_seeds];

    let cpi_accounts = token_interface::CloseAccount {
        account: ctx.accounts.vault.to_account_info(),
        destination: ctx.accounts.manager.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::close_account(cpi_ctx)?;

    let target_weight_bps = ctx.accounts.reserve_asset.target_weight_bps;
    let asset_mint = ctx.accounts.reserve_asset.asset_mint;
    let vault_key = ctx.accounts.reserve_asset.vault;

    let reserve = &mut ctx.accounts.reserve;
    reserve.asset_count = reserve
        .asset_count
        .checked_sub(1)
        .ok_or(error!(SsrError::MathUnderflow))?;
    reserve.total_target_weight_bps = reserve
        .total_target_weight_bps
        .checked_sub(target_weight_bps)
        .ok_or(error!(SsrError::MathUnderflow))?;
    let now = Clock::get()?.unix_timestamp;
    reserve.configured_at = now;

    emit!(ReserveAssetRemoved {
        reserve: reserve_key,
        asset_mint,
        vault: vault_key,
        removed_by: ctx.accounts.signer.key(),
        ts: now,
    });

    Ok(())
}
