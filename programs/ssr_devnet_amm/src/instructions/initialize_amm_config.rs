use anchor_lang::prelude::*;

use crate::constants::{AMM_CONFIG_SEED, MAX_FEE_BPS};
use crate::errors::AmmError;
use crate::events::AmmConfigInitialized;
use crate::state::AmmConfig;

#[derive(Accounts)]
pub struct InitializeAmmConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = AmmConfig::SPACE,
        seeds = [AMM_CONFIG_SEED],
        bump,
    )]
    pub amm_config: Account<'info, AmmConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeAmmConfig>, hub_mint: Pubkey, default_fee_bps: u16) -> Result<()> {
    require!(default_fee_bps <= MAX_FEE_BPS, AmmError::FeeExceedsMaximum);

    ctx.accounts.amm_config.set_inner(AmmConfig {
        authority: ctx.accounts.authority.key(),
        hub_mint,
        default_fee_bps,
        paused: false,
        bump: ctx.bumps.amm_config,
    });

    emit!(AmmConfigInitialized {
        authority: ctx.accounts.authority.key(),
        hub_mint,
        default_fee_bps,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
