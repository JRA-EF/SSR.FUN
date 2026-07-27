use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use super::common::require_reserve_permission;
use crate::constants::{RESERVE_SEED, RESERVE_VAULT_SEED};
use crate::errors::SsrError;
use crate::events::RebalanceRecorded;
use crate::state::{permission_flags, Reserve, ReserveAsset};

/// Reconciliation/attestation step of the manual rebalance flow (see
/// docs/protocol/SSR_ARCHITECTURE.md section 0 and DEC-0017): SSR v1 does
/// NOT implement an on-chain trade-execution instruction (e.g. a validated
/// Jupiter-route CPI) -- that is explicitly deferred pending its own design
/// and security review (quote validation, route-account allowlisting, min-
/// output enforcement). Manual rebalancing in v1 means the Reserve Manager
/// (or an EXECUTE_REBALANCE delegate) performs the actual trade through some
/// externally-authorized means and then calls this instruction purely to
/// reconcile/record the outcome on-chain for indexing.
///
/// LIMITATION, documented not hidden: `balances_before` is caller-supplied,
/// not independently verified on-chain (there is no prior on-chain snapshot
/// to compare against in this v1 design) -- this instruction is an audit
/// trail, not a trustless proof that a rebalance happened as claimed. See
/// docs/protocol/SECURITY_INVARIANTS.md.
#[derive(Accounts)]
pub struct RecordRebalance<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
    // Remaining accounts: reserve.asset_count pairs of [reserve_asset, vault],
    // in order_index order.
}

pub fn handler(ctx: Context<RecordRebalance>, balances_before: Vec<u64>, note: String) -> Result<()> {
    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate.to_account_info(),
        &ctx.accounts.signer.key(),
        permission_flags::EXECUTE_REBALANCE,
        ctx.program_id,
    )?;

    let expected_count = ctx.accounts.reserve.asset_count as usize;
    require_eq!(balances_before.len(), expected_count, SsrError::RemainingAccountsMismatch);
    require_eq!(ctx.remaining_accounts.len(), expected_count * 2, SsrError::RemainingAccountsMismatch);

    let mut asset_mints = Vec::with_capacity(expected_count);
    let mut balances_after = Vec::with_capacity(expected_count);

    for i in 0..expected_count {
        let reserve_asset_info = &ctx.remaining_accounts[i * 2];
        let vault_info = &ctx.remaining_accounts[i * 2 + 1];

        let config: Account<ReserveAsset> =
            Account::try_from(reserve_asset_info).map_err(|_| error!(SsrError::ReserveAssetMismatch))?;
        require_keys_eq!(config.reserve, reserve_key, SsrError::ReserveAssetMismatch);
        require_eq!(config.order_index as usize, i, SsrError::RemainingAccountsMismatch);

        let (expected_vault_key, _) =
            Pubkey::find_program_address(&[RESERVE_VAULT_SEED, reserve_key.as_ref(), config.asset_mint.as_ref()], ctx.program_id);
        require_keys_eq!(expected_vault_key, vault_info.key(), SsrError::InvalidReserveVault);

        let vault: InterfaceAccount<TokenAccount> =
            InterfaceAccount::try_from(vault_info).map_err(|_| error!(SsrError::InvalidReserveVault))?;

        asset_mints.push(config.asset_mint);
        balances_after.push(vault.amount);
    }

    emit!(RebalanceRecorded {
        reserve: reserve_key,
        asset_mints,
        balances_before,
        balances_after,
        executed_by: ctx.accounts.signer.key(),
        note,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
