//! Admin-gated update of `ProtocolConfig.default_protocol_fee_destination`
//! (and, incidentally, the protocol-wide fee bps). `initialize_protocol` only
//! ever runs once (`init`), so without this instruction the treasury address
//! set at genesis could never be corrected -- see DEC-0024.

use anchor_lang::prelude::*;

use crate::constants::PROTOCOL_CONFIG_SEED;
use crate::errors::SsrError;
use crate::events::ProtocolConfigUpdated;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        constraint = protocol_config.is_admin(&authority.key()) @ SsrError::NotProtocolAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Either approved Protocol Admin (`protocol_config.authority` or
    /// `protocol_config.admin_2`) may sign -- see `ProtocolConfig::is_admin`.
    pub authority: Signer<'info>,
}

pub fn handler<'info>(
    ctx: Context<'info, UpdateProtocolConfig<'info>>,
    new_default_protocol_fee_destination: Pubkey,
    new_default_protocol_fee_bps: u16,
) -> Result<()> {
    let protocol_config = &mut ctx.accounts.protocol_config;
    let old_destination = protocol_config.default_protocol_fee_destination;
    let old_fee_bps = protocol_config.default_protocol_fee_bps;

    protocol_config.default_protocol_fee_destination = new_default_protocol_fee_destination;
    protocol_config.default_protocol_fee_bps = new_default_protocol_fee_bps;

    emit!(ProtocolConfigUpdated {
        authority: ctx.accounts.authority.key(),
        old_default_protocol_fee_destination: old_destination,
        new_default_protocol_fee_destination: new_default_protocol_fee_destination,
        old_default_protocol_fee_bps: old_fee_bps,
        new_default_protocol_fee_bps: new_default_protocol_fee_bps,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
