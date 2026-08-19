//! Toggles `ProtocolConfig.paused`, the documented global emergency pause
//! (see docs/protocol/ACCOUNT_MODEL.md) that blocks `create_reserve`,
//! `mint_reserve_tokens_in_kind`, and `seed_reserve` program-wide, and never
//! blocks redemption on any existing Reserve. Prior to this instruction the
//! field existed and was checked but nothing could ever set it after
//! `initialize_protocol` (which always starts it `false`) -- discovered
//! during the Mainnet authority-model pass and fixed alongside it.
//!
//! Either approved Protocol Admin may call this independently, same as
//! `update_protocol_config`. This instruction never touches any Reserve
//! account or vault, so it grants no path to Reserve Asset custody.

use anchor_lang::prelude::*;

use crate::constants::PROTOCOL_CONFIG_SEED;
use crate::errors::SsrError;
use crate::events::ProtocolPausedSet;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct SetProtocolPaused<'info> {
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        constraint = protocol_config.is_admin(&authority.key()) @ SsrError::NotProtocolAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler<'info>(
    ctx: Context<'info, SetProtocolPaused<'info>>,
    paused: bool,
) -> Result<()> {
    ctx.accounts.protocol_config.paused = paused;

    emit!(ProtocolPausedSet {
        authority: ctx.accounts.authority.key(),
        paused,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
