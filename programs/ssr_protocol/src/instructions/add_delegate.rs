use anchor_lang::prelude::*;

use super::common::{require_reserve_permission, require_root_manager};
use crate::constants::{DELEGATE_SEED, RESERVE_SEED};
use crate::errors::SsrError;
use crate::events::DelegateAdded;
use crate::state::{permission_flags, Delegate, Reserve};

#[derive(Accounts)]
#[instruction(delegate_wallet: Pubkey)]
pub struct AddDelegate<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        init,
        payer = signer,
        space = Delegate::SPACE,
        seeds = [DELEGATE_SEED, reserve.key().as_ref(), delegate_wallet.as_ref()],
        bump,
    )]
    pub delegate_account: Account<'info, Delegate>,

    /// CHECK: only deserialized/validated when `signer != reserve.manager`
    /// and `restricted == true`; see `common::require_reserve_permission`.
    /// Distinct account from `delegate_account` above -- this is the
    /// signer's OWN delegate record (used to check THEIR permission to add
    /// someone else), not the new delegate being created.
    pub acting_delegate: UncheckedAccount<'info>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<AddDelegate>,
    delegate_wallet: Pubkey,
    permissions: u16,
    restricted: bool,
) -> Result<()> {
    ctx.accounts.reserve.require_not_paused()?;
    require!(
        permissions & !permission_flags::ALL_V1_FLAGS == 0,
        SsrError::ReservedPermissionBitSet
    );

    let reserve_key = ctx.accounts.reserve.key();
    if restricted {
        require_reserve_permission(
            &ctx.accounts.reserve,
            &reserve_key,
            &ctx.accounts.acting_delegate.to_account_info(),
            &ctx.accounts.signer.key(),
            permission_flags::ADD_RESTRICTED_DELEGATE,
            ctx.program_id,
        )?;
    } else {
        // Only the root Reserve Manager may grant an UNRESTRICTED delegate --
        // never delegable, per docs/protocol/SSR_ARCHITECTURE.md section 7.
        require_root_manager(&ctx.accounts.reserve, &ctx.accounts.signer.key())
            .map_err(|_| error!(SsrError::UnrestrictedDelegateRequiresManager))?;
    }

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.delegate_account.set_inner(Delegate {
        reserve: reserve_key,
        wallet: delegate_wallet,
        permissions,
        restricted,
        added_at: now,
        bump: ctx.bumps.delegate_account,
    });

    ctx.accounts.reserve.delegate_count = ctx
        .accounts
        .reserve
        .delegate_count
        .checked_add(1)
        .ok_or(error!(SsrError::MathOverflow))?;

    emit!(DelegateAdded {
        reserve: reserve_key,
        delegate: delegate_wallet,
        permissions,
        restricted,
        ts: now,
    });

    Ok(())
}
