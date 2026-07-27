use anchor_lang::prelude::*;

use crate::constants::RESERVE_SEED;
use crate::events::ReserveManagerTransferred;
use crate::state::Reserve;

/// Root-exclusive, irreversible-by-anyone-else action -- see
/// docs/protocol/SSR_ARCHITECTURE.md section 7. No delegate permission flag
/// ever grants this.
#[derive(Accounts)]
pub struct TransferReserveManager<'info> {
    #[account(
        mut,
        has_one = manager,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    pub manager: Signer<'info>,
}

pub fn handler<'info>(ctx: Context<'info, TransferReserveManager<'info>>, new_manager: Pubkey) -> Result<()> {
    let reserve_key = ctx.accounts.reserve.key();
    let old_manager = ctx.accounts.reserve.manager;

    ctx.accounts.reserve.manager = new_manager;

    emit!(ReserveManagerTransferred {
        reserve: reserve_key,
        old_manager,
        new_manager,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
