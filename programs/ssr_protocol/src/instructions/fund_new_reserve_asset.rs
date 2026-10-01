//! Bootstraps a freshly `add_reserve_asset_active`-registered asset's vault
//! from exactly zero. Necessary because `mint_reserve_tokens_in_kind`'s
//! required-deposit math is purely balance-ratio-based
//! (`mul_div_ceil(requested, vault_balance_before, total_supply_before)`) --
//! a vault stuck at 0 would require a deposit of `mul_div_ceil(x, 0, supply)
//! = 0` forever, so ordinary Buy activity could never fund it. This
//! instruction is the smallest safe fix: manager-only, additive-only (no
//! Reserve Token minted -- it's a pure backing increase that benefits every
//! existing holder and dilutes nobody), and restricted to only work while
//! the target vault's balance is exactly zero (a one-time bootstrap, not a
//! general "top up anytime" feature). See Phase F security analysis in
//! docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use crate::constants::{RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED};
use crate::errors::SsrError;
use crate::events::ReserveAssetFunded;
use crate::state::{Reserve, ReserveAsset, ReserveStatus};

#[derive(Accounts)]
pub struct FundNewReserveAsset<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
        has_one = manager @ SsrError::NotReserveManager,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
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

    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = manager,
    )]
    pub manager_token_account: InterfaceAccount<'info, TokenAccount>,

    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<FundNewReserveAsset>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.reserve.status == ReserveStatus::Active,
        SsrError::UnexpectedReserveStatus
    );
    require!(amount > 0, SsrError::ZeroValue);
    require!(ctx.accounts.vault.amount == 0, SsrError::VaultNotEmpty);

    let cpi_accounts = token_interface::TransferChecked {
        from: ctx.accounts.manager_token_account.to_account_info(),
        mint: ctx.accounts.asset_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.manager.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    // `amount` is what must ARRIVE in the vault -- a fee-bearing mint is
    // grossed up so the funded balance is the figure the Manager asked for.
    let to_send = crate::instructions::common::gross_up_for_transfer_fee(
        &ctx.accounts.asset_mint.to_account_info(),
        amount,
    )?;
    token_interface::transfer_checked(cpi_ctx, to_send, ctx.accounts.asset_mint.decimals)?;

    emit!(ReserveAssetFunded {
        reserve: ctx.accounts.reserve.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        vault: ctx.accounts.vault.key(),
        amount,
        funded_by: ctx.accounts.manager.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
