use anchor_lang::prelude::*;

use crate::constants::AMM_CONFIG_SEED;
use crate::errors::AmmError;
use crate::events::AmmUnpausedEvent;
use crate::state::AmmConfig;

#[derive(Accounts)]
pub struct UnpauseAmm<'info> {
    #[account(
        mut,
        seeds = [AMM_CONFIG_SEED],
        bump = amm_config.bump,
        has_one = authority @ AmmError::NotAmmAuthority,
    )]
    pub amm_config: Account<'info, AmmConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UnpauseAmm>) -> Result<()> {
    ctx.accounts.amm_config.paused = false;
    emit!(AmmUnpausedEvent {
        unpaused_by: ctx.accounts.authority.key(),
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
