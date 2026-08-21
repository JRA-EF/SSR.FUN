//! Admin-gated: sets `SettlementKeeperConfig.keeper` -- the ONLY wallet ever
//! granted a bounded, per-call SPL delegate approval over a settlement
//! staging account (see `approve_settlement_swap.rs`). Writes to a
//! dedicated, separate, additive singleton PDA (`SettlementKeeperConfig`),
//! NOT `ProtocolConfig` -- see that struct's own header for why growing an
//! already-initialized Mainnet account that every instruction reads is
//! unsafe. `init_if_needed` on the very first configuration.

use anchor_lang::prelude::*;

use crate::constants::{PROTOCOL_CONFIG_SEED, SETTLEMENT_KEEPER_CONFIG_SEED};
use crate::errors::SsrError;
use crate::events::FeeSettlementKeeperSet;
use crate::state::{ProtocolConfig, SettlementKeeperConfig};

#[derive(Accounts)]
pub struct SetFeeSettlementKeeper<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        constraint = protocol_config.is_admin(&authority.key()) @ SsrError::NotProtocolAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = SettlementKeeperConfig::SPACE,
        seeds = [SETTLEMENT_KEEPER_CONFIG_SEED],
        bump,
    )]
    pub settlement_keeper_config: Account<'info, SettlementKeeperConfig>,

    /// Either approved Protocol Admin may sign -- see `ProtocolConfig::is_admin`.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'info, SetFeeSettlementKeeper<'info>>,
    new_keeper: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.settlement_keeper_config;
    let old_keeper = config.keeper;
    config.schema_version = crate::constants::SCHEMA_VERSION;
    config.keeper = new_keeper;
    config.bump = ctx.bumps.settlement_keeper_config;

    emit!(FeeSettlementKeeperSet {
        authority: ctx.accounts.authority.key(),
        old_keeper,
        new_keeper,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
