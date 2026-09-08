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
    MANAGER_FEE_RECIPIENTS_SEED, RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    RESERVE_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveClosed;
use crate::state::{ManagerFeeRecipients, Reserve, ReserveAsset, ReserveStatus};

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

    /// Optional (DEC-0094): pass the program ID itself as a "None" sentinel
    /// for a Reserve that never opted into multi-recipient routing. When
    /// `Some`, every active recipient's `pending_fee_shares` must be zero
    /// (see the handler) -- without this, a manager could close a Reserve
    /// with real, uncollected per-recipient balances still outstanding,
    /// permanently stranding them (the exact failure mode
    /// `PendingFeesNotCollected` below already prevents for the legacy
    /// aggregate, which this account's existence structurally bypasses).
    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

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
    // Every accrued fee share must be collected (via collect_fees) before
    // this Reserve account -- which is the only place pending_manager_fee_shares
    // / pending_protocol_fee_shares live -- is closed. Without this check, a
    // manager could close a Reserve with real, unclaimed fee shares still
    // outstanding, permanently stranding them: closing removes the Reserve
    // account entirely, and collect_fees has no way to run against an
    // account that no longer exists. See docs/project/DECISION_LOG.md for
    // the corrective entry this closes.
    require!(
        ctx.accounts.reserve.fee_config.pending_manager_fee_shares == 0
            && ctx.accounts.reserve.fee_config.pending_protocol_fee_shares == 0,
        SsrError::PendingFeesNotCollected
    );
    // DEC-0094: for a Reserve that opted into multi-recipient routing, the
    // legacy aggregate check above always trivially passes (that field
    // stops accumulating once migrated -- see common::credit_manager_fee_shares)
    // so it can no longer catch a real outstanding balance. This is the
    // check that actually protects a migrated Reserve.
    if let Some(recipients_account) = ctx.accounts.manager_fee_recipients.as_ref() {
        require_keys_eq!(
            recipients_account.reserve,
            reserve_key,
            SsrError::ManagerFeeRecipientsMismatch
        );
        require!(
            recipients_account.all_pending_collected(),
            SsrError::PendingManagerFeeSharesNotCollected
        );
    }
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

    // TWO PASSES, deliberately (found live 2026-09-08, Mainnet test Reserve
    // #21, DEC-0193): closing an asset's vault (a token-program CPI) and then
    // its ReserveAsset config (a Rust-side lamport move) in the SAME loop
    // iteration fails on the SECOND asset with `UnbalancedInstruction` --
    // the runtime re-checks the caller's account lamport sum when the next
    // CPI is entered, and the config just closed in Rust is not among the
    // accounts passed to that CPI, so its lamport decrease is not yet
    // visible while the manager's matching increase is. Every multi-asset
    // Reserve was therefore un-closable. Pass 1 validates and closes every
    // vault via CPI; pass 2 closes every ReserveAsset config with no CPI in
    // between (Anchor then closes `reserve` itself on exit, also CPI-free).
    let mut configs: Vec<Account<'info, ReserveAsset>> = Vec::with_capacity(asset_count);
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

        configs.push(config);
    }
    for config in configs {
        config.close(manager_info.clone())?;
    }

    // Reclaim the ManagerFeeRecipients account's rent too, same as every
    // ReserveAsset above -- checked and zero-balance-verified already.
    if let Some(recipients_account) = ctx.accounts.manager_fee_recipients.take() {
        recipients_account.close(manager_info.clone())?;
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
