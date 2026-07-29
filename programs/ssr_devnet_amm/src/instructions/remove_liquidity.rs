use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use crate::constants::{AMM_CONFIG_SEED, AMM_POOL_SEED, AMM_VAULT_AUTHORITY_SEED, AMM_VAULT_SEED};
use crate::errors::AmmError;
use crate::events::LiquidityRemoved;
use crate::state::{AmmConfig, Pool};

/// Authority-only. Bounded by each vault's actual balance -- the authority
/// can never withdraw more than the pool actually holds (and, since they
/// are the only depositor, never anyone else's funds either).
#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(
        seeds = [AMM_CONFIG_SEED],
        bump = amm_config.bump,
        has_one = authority @ AmmError::NotAmmAuthority,
    )]
    pub amm_config: Account<'info, AmmConfig>,

    #[account(
        seeds = [AMM_POOL_SEED, mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [AMM_VAULT_SEED, pool.key().as_ref(), mint_a.key().as_ref()],
        bump,
        address = pool.vault_a @ AmmError::InvalidVault,
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [AMM_VAULT_SEED, pool.key().as_ref(), mint_b.key().as_ref()],
        bump,
        address = pool.vault_b @ AmmError::InvalidVault,
    )]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached bump.
    #[account(
        seeds = [AMM_VAULT_AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = mint_a, token::authority = authority)]
    pub authority_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint_b, token::authority = authority)]
    pub authority_token_b: InterfaceAccount<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<RemoveLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
    require!(amount_a > 0 || amount_b > 0, AmmError::ZeroValue);
    require!(amount_a <= ctx.accounts.vault_a.amount, AmmError::InsufficientVaultBalance);
    require!(amount_b <= ctx.accounts.vault_b.amount, AmmError::InsufficientVaultBalance);

    let pool_key = ctx.accounts.pool.key();
    let vault_authority_bump = ctx.accounts.pool.vault_authority_bump;
    let vault_authority_seeds: &[&[u8]] = &[
        AMM_VAULT_AUTHORITY_SEED,
        pool_key.as_ref(),
        &[vault_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[vault_authority_seeds];

    if amount_a > 0 {
        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.vault_a.to_account_info(),
            mint: ctx.accounts.mint_a.to_account_info(),
            to: ctx.accounts.authority_token_a.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
        token_interface::transfer_checked(cpi_ctx, amount_a, ctx.accounts.mint_a.decimals)?;
    }
    if amount_b > 0 {
        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.vault_b.to_account_info(),
            mint: ctx.accounts.mint_b.to_account_info(),
            to: ctx.accounts.authority_token_b.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
        token_interface::transfer_checked(cpi_ctx, amount_b, ctx.accounts.mint_b.decimals)?;
    }

    emit!(LiquidityRemoved {
        pool: pool_key,
        amount_a,
        amount_b,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
