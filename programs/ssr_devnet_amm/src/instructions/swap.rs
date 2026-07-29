use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use super::common::{constant_product_amount_out, mul_div_floor};
use crate::constants::{AMM_CONFIG_SEED, AMM_POOL_SEED, AMM_VAULT_AUTHORITY_SEED, AMM_VAULT_SEED, BPS_DENOMINATOR};
use crate::errors::AmmError;
use crate::events::SwapExecuted;
use crate::state::{AmmConfig, Pool};

/// PERMISSIONLESS -- the only instruction in this program a normal user can
/// call. Every account is either re-derived from its own PDA seeds and
/// checked, or explicitly checked against the pool's registered mints,
/// mirroring `ssr_protocol::common::load_asset_legs`'s defensive pattern
/// exactly (see DEC-0051): this is what makes vault/mint substitution
/// structurally impossible, not merely checked by convention.
#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(seeds = [AMM_CONFIG_SEED], bump = amm_config.bump)]
    pub amm_config: Account<'info, AmmConfig>,

    #[account(
        seeds = [AMM_POOL_SEED, mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(address = pool.mint_a @ AmmError::MintMismatch)]
    pub mint_a: InterfaceAccount<'info, Mint>,
    #[account(address = pool.mint_b @ AmmError::MintMismatch)]
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

    #[account(mut, token::mint = mint_a, token::authority = trader)]
    pub trader_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint_b, token::authority = trader)]
    pub trader_token_b: InterfaceAccount<'info, TokenAccount>,

    pub trader: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Swap>, amount_in: u64, minimum_amount_out: u64, a_to_b: bool) -> Result<()> {
    require!(!ctx.accounts.amm_config.paused, AmmError::AmmPaused);
    require!(amount_in > 0, AmmError::ZeroValue);

    let fee_bps = ctx.accounts.pool.fee_bps;
    let fee_amount = mul_div_floor(amount_in, fee_bps as u64, BPS_DENOMINATOR as u64)?;
    let amount_in_after_fee = amount_in
        .checked_sub(fee_amount)
        .ok_or(error!(AmmError::MathOverflow))?;

    let (reserve_in, reserve_out) = if a_to_b {
        (ctx.accounts.vault_a.amount, ctx.accounts.vault_b.amount)
    } else {
        (ctx.accounts.vault_b.amount, ctx.accounts.vault_a.amount)
    };

    let amount_out = constant_product_amount_out(reserve_in, reserve_out, amount_in_after_fee)?;
    require!(amount_out > 0, AmmError::ZeroValue);
    require!(amount_out >= minimum_amount_out, AmmError::SlippageMinOutputNotMet);

    let pool_key = ctx.accounts.pool.key();
    let vault_authority_bump = ctx.accounts.pool.vault_authority_bump;
    let vault_authority_seeds: &[&[u8]] = &[
        AMM_VAULT_AUTHORITY_SEED,
        pool_key.as_ref(),
        &[vault_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[vault_authority_seeds];

    let (from_ata, to_ata, in_mint, out_mint, in_vault, out_vault, in_decimals, out_decimals) = if a_to_b {
        (
            ctx.accounts.trader_token_a.to_account_info(),
            ctx.accounts.trader_token_b.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
            ctx.accounts.vault_a.to_account_info(),
            ctx.accounts.vault_b.to_account_info(),
            ctx.accounts.mint_a.decimals,
            ctx.accounts.mint_b.decimals,
        )
    } else {
        (
            ctx.accounts.trader_token_b.to_account_info(),
            ctx.accounts.trader_token_a.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
            ctx.accounts.vault_b.to_account_info(),
            ctx.accounts.vault_a.to_account_info(),
            ctx.accounts.mint_b.decimals,
            ctx.accounts.mint_a.decimals,
        )
    };

    // Trader -> pool vault (trader's own signature).
    let in_cpi_accounts = token_interface::TransferChecked {
        from: from_ata,
        mint: in_mint,
        to: in_vault,
        authority: ctx.accounts.trader.to_account_info(),
    };
    let in_cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), in_cpi_accounts);
    token_interface::transfer_checked(in_cpi_ctx, amount_in, in_decimals)?;

    // Pool vault -> trader (vault-authority PDA signature).
    let out_cpi_accounts = token_interface::TransferChecked {
        from: out_vault,
        mint: out_mint,
        to: to_ata,
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    let out_cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), out_cpi_accounts, signer_seeds);
    token_interface::transfer_checked(out_cpi_ctx, amount_out, out_decimals)?;

    emit!(SwapExecuted {
        pool: pool_key,
        trader: ctx.accounts.trader.key(),
        a_to_b,
        amount_in,
        fee_amount,
        amount_out,
        reserve_in_after: reserve_in.saturating_add(amount_in),
        reserve_out_after: reserve_out.saturating_sub(amount_out),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
