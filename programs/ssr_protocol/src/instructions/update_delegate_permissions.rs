use anchor_lang::prelude::*;

use super::common::{require_grantable_permissions, require_reserve_permission, require_root_manager};
use crate::constants::{DELEGATE_SEED, RESERVE_SEED};
use crate::errors::SsrError;
use crate::events::DelegatePermissionsUpdated;
use crate::state::{permission_flags, Delegate, Reserve};

#[derive(Accounts)]
pub struct UpdateDelegatePermissions<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
        has_one = reserve @ SsrError::DelegateNotFound,
        seeds = [DELEGATE_SEED, reserve.key().as_ref(), delegate_account.wallet.as_ref()],
        bump = delegate_account.bump,
    )]
    pub delegate_account: Account<'info, Delegate>,

    /// CHECK: only deserialized/validated when `signer != reserve.manager`
    /// and the target delegate is restricted; see
    /// `common::require_reserve_permission`.
    pub acting_delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

pub fn handler<'info>(
    ctx: Context<'info, UpdateDelegatePermissions<'info>>,
    new_permissions: u16,
) -> Result<()> {
    ctx.accounts.reserve.require_not_paused()?;
    require!(
        new_permissions & !permission_flags::ALL_V1_FLAGS == 0,
        SsrError::ReservedPermissionBitSet
    );

    let reserve_key = ctx.accounts.reserve.key();
    let signer_key = ctx.accounts.signer.key();

    if ctx.accounts.delegate_account.restricted {
        require_reserve_permission(
            &ctx.accounts.reserve,
            &reserve_key,
            &ctx.accounts.acting_delegate,
            &signer_key,
            permission_flags::ADD_RESTRICTED_DELEGATE,
            ctx.program_id,
        )?;
        // Containment: the grant must be a subset of the granter's own
        // permissions, and must not target the granter's own record.
        require_grantable_permissions(
            &ctx.accounts.reserve,
            &reserve_key,
            &ctx.accounts.acting_delegate,
            &signer_key,
            &ctx.accounts.delegate_account.key(),
            new_permissions,
            ctx.program_id,
        )?;
    } else {
        require_root_manager(&ctx.accounts.reserve, &signer_key)
            .map_err(|_| error!(SsrError::UnrestrictedDelegateRequiresManager))?;
    }

    let old_permissions = ctx.accounts.delegate_account.permissions;
    ctx.accounts.delegate_account.permissions = new_permissions;

    emit!(DelegatePermissionsUpdated {
        reserve: reserve_key,
        delegate: ctx.accounts.delegate_account.wallet,
        old_permissions,
        new_permissions,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
