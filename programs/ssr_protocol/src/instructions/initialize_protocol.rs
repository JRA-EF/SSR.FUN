use anchor_lang::prelude::*;

use crate::constants::{ABSOLUTE_MAX_RESERVE_ASSETS, PROTOCOL_CONFIG_SEED};
use crate::errors::SsrError;
use crate::events::ProtocolInitialized;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::SPACE,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'info, InitializeProtocol<'info>>,
    max_reserve_assets: u8,
    default_protocol_fee_bps: u16,
    default_protocol_fee_destination: Pubkey,
) -> Result<()> {
    require!(
        max_reserve_assets > 0 && max_reserve_assets <= ABSOLUTE_MAX_RESERVE_ASSETS,
        SsrError::MaxReserveAssetsTooHigh
    );

    let bump = ctx.bumps.protocol_config;
    ctx.accounts.protocol_config.set_inner(ProtocolConfig::initial(
        ctx.accounts.authority.key(),
        max_reserve_assets,
        default_protocol_fee_bps,
        default_protocol_fee_destination,
        bump,
    ));

    emit!(ProtocolInitialized {
        authority: ctx.accounts.authority.key(),
        max_reserve_assets,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
