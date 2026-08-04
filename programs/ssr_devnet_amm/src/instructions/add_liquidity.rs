use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use crate::constants::{AMM_CONFIG_SEED, AMM_POOL_SEED, AMM_VAULT_SEED};
use crate::errors::AmmError;
use crate::events::LiquidityAdded;
use crate::state::{AmmConfig, Pool};

/// Authority-only, additive. This is the ONLY source of liquidity in v1 --
/// no public deposit exists (see DEC-0051 "single-authority liquidity").
/// Amounts need not be in the pool's current ratio; the depositing
/// authority is the sole trusted liquidity source and sets the price by
/// their own choice of amounts, same as `fund_new_reserve_asset` in
/// `ssr_protocol` lets the manager choose bootstrap amounts freely.
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
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

    #[account(mut, token::mint = mint_a, token::authority = authority)]
    pub authority_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint_b, token::authority = authority)]
    pub authority_token_b: InterfaceAccount<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<AddLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
    require!(amount_a > 0 || amount_b > 0, AmmError::ZeroValue);

    if amount_a > 0 {
        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.authority_token_a.to_account_info(),
            mint: ctx.accounts.mint_a.to_account_info(),
            to: ctx.accounts.vault_a.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount_a, ctx.accounts.mint_a.decimals)?;
    }
    if amount_b > 0 {
        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.authority_token_b.to_account_info(),
            mint: ctx.accounts.mint_b.to_account_info(),
            to: ctx.accounts.vault_b.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount_b, ctx.accounts.mint_b.decimals)?;
    }

    emit!(LiquidityAdded {
        pool: ctx.accounts.pool.key(),
        amount_a,
        amount_b,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
