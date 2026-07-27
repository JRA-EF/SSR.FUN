use anchor_lang::prelude::*;

use super::common::{require_reserve_permission, require_root_manager};
use crate::constants::{DELEGATE_SEED, RESERVE_SEED};
use crate::errors::SsrError;
use crate::events::DelegateRemoved;
use crate::state::{permission_flags, Delegate, Reserve};

#[derive(Accounts)]
pub struct RemoveDelegate<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
        close = signer,
        has_one = reserve @ SsrError::DelegateNotFound,
        seeds = [DELEGATE_SEED, reserve.key().as_ref(), delegate_account.wallet.as_ref()],
        bump = delegate_account.bump,
    )]
    pub delegate_account: Account<'info, Delegate>,

    /// CHECK: only deserialized/validated when `signer != reserve.manager`
    /// and the target delegate is restricted; see
    /// `common::require_reserve_permission`.
    pub acting_delegate: UncheckedAccount<'info>,

    #[account(mut)]
    pub signer: Signer<'info>,
}

pub fn handler<'info>(ctx: Context<'info, RemoveDelegate<'info>>) -> Result<()> {
    let reserve_key = ctx.accounts.reserve.key();
    let signer_key = ctx.accounts.signer.key();

    if ctx.accounts.delegate_account.restricted {
        require_reserve_permission(
            &ctx.accounts.reserve,
            &reserve_key,
            &ctx.accounts.acting_delegate,
            &signer_key,
            permission_flags::REMOVE_RESTRICTED_DELEGATE,
            ctx.program_id,
        )?;
    } else {
        // Only the root Reserve Manager may revoke an UNRESTRICTED delegate --
        // never delegable, per docs/protocol/SSR_ARCHITECTURE.md section 7.
        require_root_manager(&ctx.accounts.reserve, &signer_key)
            .map_err(|_| error!(SsrError::UnrestrictedDelegateRequiresManager))?;
    }

    let delegate_wallet = ctx.accounts.delegate_account.wallet;
    ctx.accounts.reserve.delegate_count = ctx
        .accounts
        .reserve
        .delegate_count
        .checked_sub(1)
        .ok_or(error!(SsrError::MathUnderflow))?;

    emit!(DelegateRemoved {
        reserve: reserve_key,
        delegate: delegate_wallet,
        ts: Clock::get()?.unix_timestamp,
    });

    // `close = signer` (in the Accounts struct above) reclaims the account's
    // rent lamports to `signer` and zeroes its discriminator automatically
    // on instruction exit -- no manual account closing needed here.
    Ok(())
}
