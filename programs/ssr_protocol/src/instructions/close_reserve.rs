//! Terminal `WindDown -> Closed` transition. Requires the Reserve Token
//! supply AND every registered asset's vault balance to already be zero --
//! i.e. every holder has redeemed out (redemption stays available during
//! `WindDown`; see `Reserve::require_redemption_allowed`) before the Reserve
//! can be closed. Closes the `Reserve` account, every `ReserveAsset` account,
//! and every vault token account, reclaiming rent to the manager.
//! Deliberately does NOT attempt to close the `reserve_token_mint` account
//! itself -- SPL Token mint-account closing semantics are a live-program risk
//! not worth taking for a small amount of permanently-locked rent; see Phase
//! G security analysis in
//! docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md.
//!
//! `remaining_accounts` must be `reserve.asset_count` pairs of
//! `[reserve_asset, vault]`, in `order_index` order -- lighter than
//! `common::load_asset_legs` (no owner_token_account/mint/token_program per
//! leg needed) since this only reads and then closes each account.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint as SplMint;
use anchor_spl::token_interface::{self, TokenAccount, TokenInterface};

use crate::constants::{
    RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED, RESERVE_VAULT_SEED,
    VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveClosed;
use crate::state::{Reserve, ReserveAsset, ReserveStatus};

#[derive(Accounts)]
pub struct CloseReserve<'info> {
    #[account(
        mut,
        close = manager,
        has_one = manager @ SsrError::NotReserveManager,
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
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(ctx: Context<'info, CloseReserve<'info>>) -> Result<()> {
    let reserve_key = ctx.accounts.reserve.key();
    let asset_count = {
        let reserve = &ctx.accounts.reserve;
        require!(
            reserve.status == ReserveStatus::WindDown,
            SsrError::UnexpectedReserveStatus
        );
        reserve.asset_count as usize
    };
    require!(
        ctx.accounts.reserve_token_mint.supply == 0,
        SsrError::ReserveTokenSupplyNotZero
    );
    require_eq!(
        ctx.remaining_accounts.len(),
        asset_count * 2,
        SsrError::RemainingAccountsMismatch
    );

    let vault_authority_bump = ctx.accounts.reserve.vault_authority_bump;
    let vault_authority_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[vault_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[vault_authority_seeds];
    let manager_info = ctx.accounts.manager.to_account_info();
    let program_id = ctx.program_id;

    for i in 0..asset_count {
        let base = i * 2;
        let reserve_asset_info = &ctx.remaining_accounts[base];
        let vault_info = &ctx.remaining_accounts[base + 1];

        let config: Account<'info, ReserveAsset> = Account::try_from(reserve_asset_info)
            .map_err(|_| error!(SsrError::ReserveAssetMismatch))?;
        require_keys_eq!(config.reserve, reserve_key, SsrError::ReserveAssetMismatch);
        require_eq!(
            config.order_index as usize,
            i,
            SsrError::RemainingAccountsMismatch
        );

        let (expected_reserve_asset_key, _) = Pubkey::find_program_address(
            &[
                RESERVE_ASSET_SEED,
                reserve_key.as_ref(),
                config.asset_mint.as_ref(),
            ],
            program_id,
        );
        require_keys_eq!(
            expected_reserve_asset_key,
            reserve_asset_info.key(),
            SsrError::ReserveAssetMismatch
        );

        let (expected_vault_key, _) = Pubkey::find_program_address(
            &[
                RESERVE_VAULT_SEED,
                reserve_key.as_ref(),
                config.asset_mint.as_ref(),
            ],
            program_id,
        );
        require_keys_eq!(
            expected_vault_key,
            vault_info.key(),
            SsrError::InvalidReserveVault
        );
        require_keys_eq!(*vault_info.key, config.vault, SsrError::InvalidReserveVault);

        let vault: InterfaceAccount<'info, TokenAccount> =
            InterfaceAccount::try_from(vault_info)
                .map_err(|_| error!(SsrError::InvalidReserveVault))?;
        require_keys_eq!(vault.mint, config.asset_mint, SsrError::ReserveAssetMismatch);
        require!(vault.amount == 0, SsrError::VaultNotEmpty);

        let cpi_accounts = token_interface::CloseAccount {
            account: vault_info.clone(),
            destination: manager_info.clone(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::close_account(cpi_ctx)?;

        config.close(manager_info.clone())?;
    }

    // `reserve` carries `close = manager` (see the Accounts struct): Anchor
    // fully zeroes and reassigns this account after the handler returns, so
    // there is no persisted account left to ever read a `Closed` status from
    // -- full closure IS the terminal state (see the module doc comment).
    // Discovery already treats "PDA derives but `fetchNullable` returns null"
    // as "this Reserve no longer exists," which is exactly what happens here.

    emit!(ReserveClosed {
        reserve: reserve_key,
        closed_by: ctx.accounts.manager.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
