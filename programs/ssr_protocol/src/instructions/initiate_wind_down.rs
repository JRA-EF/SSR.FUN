//! One-way `Active -> WindDown` transition. Root-manager-only, no delegate
//! path -- matches the confirmed "root-exclusive unless explicitly defined
//! otherwise" authority model (see `require_root_manager`'s other callers:
//! authority transfer, unrestricted-delegate grant/revoke). Deliberately does
//! NOT revoke the Reserve Token mint authority: an earlier design sketch
//! considered that as defense-in-depth, but `collect_fees` needs the mint
//! authority PDA to remain usable during `WindDown` (fees stay collectible
//! per the Phase G security analysis). New issuance is already blocked with
//! zero code changes to `mint_reserve_tokens_in_kind`, since it requires
//! `status == Active` exactly. See
//! docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md.

use anchor_lang::prelude::*;

use crate::constants::RESERVE_SEED;
use crate::errors::SsrError;
use crate::events::WindDownInitiated;
use crate::state::{Reserve, ReserveStatus};

#[derive(Accounts)]
pub struct InitiateWindDown<'info> {
    #[account(
        mut,
        has_one = manager @ SsrError::NotReserveManager,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    pub manager: Signer<'info>,
}

pub fn handler(ctx: Context<InitiateWindDown>) -> Result<()> {
    require!(
        ctx.accounts.reserve.status == ReserveStatus::Active,
        SsrError::UnexpectedReserveStatus
    );

    let reserve = &mut ctx.accounts.reserve;
    reserve.status = ReserveStatus::WindDown;

    emit!(WindDownInitiated {
        reserve: reserve.key(),
        initiated_by: ctx.accounts.manager.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
