//! Collects ONLY the Protocol's pending fee share, leaving the Manager's
//! pending balance completely untouched -- fully additive, mirroring
//! `collect_manager_fee_share.rs`'s precedent (`collect_fees.rs`, which
//! collects both sides together, is left completely unchanged and still
//! works exactly as before). Permissionless, same as every other
//! fee-collection instruction here: accrual is pre-accounted on
//! `reserve.fee_config.pending_protocol_fee_shares`, so the caller can never
//! redirect funds anywhere but the Protocol's own fixed, on-chain-configured
//! treasury ATA (`protocol_config.default_protocol_fee_destination`) -- the
//! caller only ever fronts the destination ATA's rent if it doesn't exist
//! yet.
//!
//! What this exists for: `api/devnet/accrue-fees-cron.ts`'s weekly keeper
//! calls this for every Reserve with a nonzero pending Protocol balance,
//! right after its TVL-fee checkpoint -- so the Protocol never has to
//! manually collect anything; its treasury balance grows automatically on a
//! fixed schedule. See docs/project/DECISION_LOG.md's entry for this pass.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use crate::constants::{MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED};
use crate::errors::SsrError;
use crate::events::ProtocolFeeCollected;
use crate::state::{ProtocolConfig, Reserve};

#[derive(Accounts)]
pub struct CollectProtocolFee<'info> {
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
        associated_token::authority = protocol_fee_destination,
    )]
    pub protocol_fee_destination_token_account: Account<'info, SplTokenAccount>,
    /// CHECK: only used as the associated-token-account authority above;
    /// must equal `protocol_config.default_protocol_fee_destination`,
    /// checked in the handler.
    pub protocol_fee_destination: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'info, CollectProtocolFee<'info>>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.protocol_fee_destination.key(),
        ctx.accounts.protocol_config.default_protocol_fee_destination,
        SsrError::InvalidFeeShareSplit
    );

    let reserve_key = ctx.accounts.reserve.key();
    let amount = ctx.accounts.reserve.fee_config.pending_protocol_fee_shares;
    require!(amount > 0, SsrError::NoPendingFees);
    ctx.accounts.reserve.fee_config.pending_protocol_fee_shares = 0;

    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[mint_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];
    let cpi_accounts = MintTo {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        to: ctx
            .accounts
            .protocol_fee_destination_token_account
            .to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
    token::mint_to(cpi_ctx, amount)?;

    emit!(ProtocolFeeCollected {
        reserve: reserve_key,
        amount,
        destination: ctx.accounts.protocol_fee_destination.key(),
        collected_by: ctx.accounts.payer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
