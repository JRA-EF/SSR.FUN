use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{AMM_CONFIG_SEED, AMM_POOL_SEED, AMM_VAULT_AUTHORITY_SEED, AMM_VAULT_SEED, MAX_FEE_BPS, WRAPPED_SOL_MINT};
use crate::errors::AmmError;
use crate::events::PoolCreated;
use crate::state::{AmmConfig, Pool};

/// Authority-only. `mint_a` must be the canonical wrapped-SOL mint --
/// v1 is deliberately hub-and-spoke, not general pairwise pools (DEC-0051).
/// Only the AMM authority can ever create a pool: this is what prevents an
/// attacker from registering a pool with a substituted/fake mint that a
/// client could be tricked into swapping through.
#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(
        seeds = [AMM_CONFIG_SEED],
        bump = amm_config.bump,
        has_one = authority @ AmmError::NotAmmAuthority,
    )]
    pub amm_config: Account<'info, AmmConfig>,

    #[account(
        init,
        payer = authority,
        space = Pool::SPACE,
        seeds = [AMM_POOL_SEED, mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(address = WRAPPED_SOL_MINT @ AmmError::MintAMustBeWrappedSol)]
    pub mint_a: InterfaceAccount<'info, Mint>,

    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [AMM_VAULT_SEED, pool.key().as_ref(), mint_a.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = vault_authority,
        token::token_program = token_program,
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [AMM_VAULT_SEED, pool.key().as_ref(), mint_b.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = vault_authority,
        token::token_program = token_program,
    )]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: signer-only PDA, never holds data; verified purely by seeds.
    #[account(
        seeds = [AMM_VAULT_AUTHORITY_SEED, pool.key().as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreatePool>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, AmmError::FeeExceedsMaximum);

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.pool.set_inner(Pool {
        mint_a: ctx.accounts.mint_a.key(),
        mint_b: ctx.accounts.mint_b.key(),
        vault_a: ctx.accounts.vault_a.key(),
        vault_b: ctx.accounts.vault_b.key(),
        fee_bps,
        bump: ctx.bumps.pool,
        vault_authority_bump: ctx.bumps.vault_authority,
        created_at: now,
    });

    emit!(PoolCreated {
        pool: ctx.accounts.pool.key(),
        mint_a: ctx.accounts.mint_a.key(),
        mint_b: ctx.accounts.mint_b.key(),
        fee_bps,
        ts: now,
    });

    Ok(())
}
