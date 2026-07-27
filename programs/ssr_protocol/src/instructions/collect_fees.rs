use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use crate::constants::{MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED};
use crate::errors::SsrError;
use crate::events::FeesCollected;
use crate::state::{ProtocolConfig, Reserve};

/// Permissionless -- like `accrue_fees`, this only mints already-accounted
/// pending shares to fixed, Reserve-configured destinations; the caller
/// cannot redirect funds anywhere. `payer` covers destination-ATA rent if
/// either destination doesn't have one yet.
#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
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

    /// CHECK: signer-only PDA, verified purely by seeds against the cached bump.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = manager_fee_destination,
    )]
    pub manager_fee_destination_token_account: Account<'info, SplTokenAccount>,
    /// CHECK: only used as the associated-token-account authority above;
    /// must equal `reserve.fee_config.fee_destination`, checked in the handler.
    pub manager_fee_destination: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = protocol_fee_destination,
    )]
    pub protocol_fee_destination_token_account: Account<'info, SplTokenAccount>,
    /// CHECK: only used as the associated-token-account authority above;
    /// checked in the handler against
    /// `protocol_config.default_protocol_fee_destination` -- closes the gap
    /// flagged in docs/protocol/SECURITY_INVARIANTS.md (was previously
    /// unvalidated, meaning any caller-supplied address could receive the
    /// protocol's fee share).
    pub protocol_fee_destination: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'info, CollectFees<'info>>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.manager_fee_destination.key(),
        ctx.accounts.reserve.fee_config.fee_destination,
        SsrError::InvalidFeeShareSplit
    );
    require_keys_eq!(
        ctx.accounts.protocol_fee_destination.key(),
        ctx.accounts.protocol_config.default_protocol_fee_destination,
        SsrError::InvalidFeeShareSplit
    );

    let manager_shares = ctx.accounts.reserve.fee_config.pending_manager_fee_shares;
    let protocol_shares = ctx.accounts.reserve.fee_config.pending_protocol_fee_shares;
    require!(manager_shares > 0 || protocol_shares > 0, SsrError::NoPendingFees);

    let reserve_key = ctx.accounts.reserve.key();
    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    let mint_authority_seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, reserve_key.as_ref(), &[mint_authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];

    if manager_shares > 0 {
        let cpi_accounts = MintTo {
            mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.manager_fee_destination_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
        token::mint_to(cpi_ctx, manager_shares)?;
    }
    if protocol_shares > 0 {
        let cpi_accounts = MintTo {
            mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.protocol_fee_destination_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
        token::mint_to(cpi_ctx, protocol_shares)?;
    }

    let reserve = &mut ctx.accounts.reserve;
    reserve.fee_config.pending_manager_fee_shares = 0;
    reserve.fee_config.pending_protocol_fee_shares = 0;

    emit!(FeesCollected {
        reserve: reserve_key,
        manager_fee_shares_minted: manager_shares,
        protocol_fee_shares_minted: protocol_shares,
        manager_destination: ctx.accounts.manager_fee_destination.key(),
        protocol_destination: ctx.accounts.protocol_fee_destination.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
