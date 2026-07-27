use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use super::common::{load_asset_legs, transfer_into_vault};
use crate::constants::{
    MINT_AUTHORITY_SEED, MIN_SEED_AMOUNT_PER_ASSET, PROTOCOL_CONFIG_SEED, RESERVE_SEED,
    RESERVE_TOKEN_MINT_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveSeeded;
use crate::state::{ProtocolConfig, Reserve, ReserveStatus};

#[derive(Accounts)]
pub struct SeedReserve<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        has_one = manager @ SsrError::NotReserveManager,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
    )]
    pub reserve_token_mint: Account<'info, SplMint>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached
    /// bump from `create_reserve`.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = manager,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = manager,
    )]
    pub manager_reserve_token_account: Account<'info, SplTokenAccount>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, manager_asset_token_account, mint, token_program]
    // in ReserveAsset.order_index order. See instructions/common.rs::load_asset_legs.
}

pub fn handler<'info>(ctx: Context<'info, SeedReserve<'info>>, seed_amounts: Vec<u64>, initial_reserve_tokens: u64) -> Result<()> {
    require!(!ctx.accounts.protocol_config.paused, SsrError::ProtocolPaused);
    require!(
        ctx.accounts.reserve.status == ReserveStatus::AssetsInitializing,
        SsrError::UnexpectedReserveStatus
    );
    require!(ctx.accounts.reserve.asset_count > 0, SsrError::UnexpectedReserveStatus);
    require!(initial_reserve_tokens > 0, SsrError::ZeroValue);
    require_eq!(
        seed_amounts.len(),
        ctx.accounts.reserve.asset_count as usize,
        SsrError::RemainingAccountsMismatch
    );

    let reserve_key = ctx.accounts.reserve.key();
    let mut legs = load_asset_legs(
        &ctx.accounts.reserve,
        &reserve_key,
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    let mut asset_mints = Vec::with_capacity(legs.len());
    let mut asset_amounts = Vec::with_capacity(legs.len());

    for (leg, &amount) in legs.iter_mut().zip(seed_amounts.iter()) {
        require!(amount >= MIN_SEED_AMOUNT_PER_ASSET, SsrError::SeedAmountTooLow);
        transfer_into_vault(leg, &ctx.accounts.manager.to_account_info(), amount)?;

        // Mirrors the reference protocol's own `initialize()` assertion
        // (Folio.sol lines 247-248): every basket asset's vault must
        // actually hold a nonzero balance before any Reserve Token is
        // minted. Reloading (rather than trusting the transfer call above
        // didn't error) is cheap insurance against a token program that
        // silently no-ops a transfer instead of erroring.
        leg.vault.reload()?;
        require!(leg.vault.amount > 0, SsrError::SeedAmountTooLow);

        asset_mints.push(leg.mint.key());
        asset_amounts.push(amount);
    }

    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    let now = Clock::get()?.unix_timestamp;
    {
        let reserve = &mut ctx.accounts.reserve;
        reserve.status = ReserveStatus::Active;
        reserve.configured_at = now;
    }

    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[mint_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];

    let cpi_accounts = MintTo {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        to: ctx.accounts.manager_reserve_token_account.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token::mint_to(cpi_ctx, initial_reserve_tokens)?;

    emit!(ReserveSeeded {
        reserve: reserve_key,
        initial_reserve_tokens,
        asset_mints,
        asset_amounts,
        ts: now,
    });

    Ok(())
}
