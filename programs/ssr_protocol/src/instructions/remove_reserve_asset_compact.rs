//! DEC-0250: removes an EMPTY Reserve Asset from ANY position, not only the
//! last-registered one (`remove_reserve_asset`'s restriction). After a real
//! rebalance sells an asset to zero, the Manager expects it to disappear from
//! the Reserve, and it is usually not the last one registered.
//!
//! Every mint/redeem/update path requires the assets in contiguous
//! `order_index` order (common.rs::load_asset_legs). This keeps that true
//! with a swap-remove: when the removed asset is not the last one, the
//! last-registered asset takes over its `order_index`. Nothing else is
//! renumbered. Same safety rule as the original: the vault must hold exactly
//! zero, so removal can never strand value belonging to holders.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use super::common::require_reserve_permission;
use crate::constants::{RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED, VAULT_AUTHORITY_SEED};
use crate::errors::SsrError;
use crate::events::{ReserveAssetCompacted, ReserveAssetRemoved};
use crate::state::{permission_flags, Reserve, ReserveAsset, ReserveStatus};

#[derive(Accounts)]
pub struct RemoveReserveAssetCompact<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Box<Account<'info, Reserve>>,

    #[account(
        mut,
        close = manager,
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump = reserve_asset.bump,
        constraint = reserve_asset.reserve == reserve.key() @ SsrError::ReserveAssetMismatch,
    )]
    pub reserve_asset: Box<Account<'info, ReserveAsset>>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump,
        address = reserve_asset.vault @ SsrError::InvalidReserveVault,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The last-registered asset, which moves into the freed position. Omit
    /// it only when the removed asset IS the last one.
    #[account(mut, constraint = last_reserve_asset.reserve == reserve.key() @ SsrError::ReserveAssetMismatch)]
    pub last_reserve_asset: Option<Box<Account<'info, ReserveAsset>>>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached bump.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: rent destination, always the root manager (address-checked).
    #[account(mut, address = reserve.manager @ SsrError::NotReserveManager)]
    pub manager: UncheckedAccount<'info>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(ctx: Context<'info, RemoveReserveAssetCompact<'info>>) -> Result<()> {
    let reserve = &ctx.accounts.reserve;
    require!(
        reserve.status == ReserveStatus::AssetsInitializing || reserve.status == ReserveStatus::Active || reserve.status == ReserveStatus::Paused,
        SsrError::UnexpectedReserveStatus
    );
    let reserve_key = reserve.key();
    // Same permission as rebalancing: removing an emptied asset is the last
    // step of a rebalance.
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::EXECUTE_REBALANCE,
        ctx.program_id,
    )?;
    require!(ctx.accounts.vault.amount == 0, SsrError::VaultNotEmpty);
    require!(reserve.asset_count > 1, SsrError::UnexpectedReserveStatus);

    let last_index = reserve.asset_count.checked_sub(1).ok_or(error!(SsrError::MathUnderflow))?;
    let removed_index = ctx.accounts.reserve_asset.order_index;
    let mut moved_mint = None;
    if removed_index != last_index {
        let last = ctx.accounts.last_reserve_asset.as_mut().ok_or(error!(SsrError::RebalanceLastAssetMismatch))?;
        require_eq!(last.order_index, last_index, SsrError::RebalanceLastAssetMismatch);
        last.order_index = removed_index;
        moved_mint = Some(last.asset_mint);
    }

    let bump = reserve.vault_authority_bump;
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, reserve_key.as_ref(), &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    token_interface::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        token_interface::CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.manager.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    ))?;

    let target_weight_bps = ctx.accounts.reserve_asset.target_weight_bps;
    let asset_mint = ctx.accounts.reserve_asset.asset_mint;
    let vault_key = ctx.accounts.reserve_asset.vault;
    let reserve = &mut ctx.accounts.reserve;
    reserve.asset_count = last_index;
    reserve.total_target_weight_bps = reserve.total_target_weight_bps.checked_sub(target_weight_bps).ok_or(error!(SsrError::MathUnderflow))?;
    let now = Clock::get()?.unix_timestamp;
    reserve.configured_at = now;

    emit!(ReserveAssetRemoved { reserve: reserve_key, asset_mint, vault: vault_key, removed_by: ctx.accounts.signer.key(), ts: now });
    emit!(ReserveAssetCompacted { reserve: reserve_key, removed_mint: asset_mint, moved_mint, order_index: removed_index });
    Ok(())
}
