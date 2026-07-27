use anchor_lang::prelude::*;

use super::common::require_reserve_permission;
use crate::constants::RESERVE_SEED;
use crate::errors::SsrError;
use crate::events::ReserveUnpaused;
use crate::state::{permission_flags, Reserve, ReserveStatus};

#[derive(Accounts)]
pub struct UnpauseReserve<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

pub fn handler(ctx: Context<UnpauseReserve>) -> Result<()> {
    require!(ctx.accounts.reserve.status == ReserveStatus::Paused, SsrError::ReserveNotPaused);

    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate.to_account_info(),
        &ctx.accounts.signer.key(),
        permission_flags::UNPAUSE_RESERVE,
        ctx.program_id,
    )?;

    ctx.accounts.reserve.status = ReserveStatus::Active;

    emit!(ReserveUnpaused {
        reserve: reserve_key,
        unpaused_by: ctx.accounts.signer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
