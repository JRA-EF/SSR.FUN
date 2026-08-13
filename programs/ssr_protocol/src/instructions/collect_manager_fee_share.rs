//! DEC-0094: lets ONE named Manager fee recipient collect only their own
//! accrued balance -- permissionless, mirroring `collect_fees`'s existing
//! "any wallet may trigger the payout" design (accrual is pre-accounted;
//! the caller can never redirect funds anywhere but the recipient's own
//! ATA). Fully additive -- `collect_fees.rs` is left completely untouched.
//!
//! Falls back to the legacy `fee_config.fee_destination` /
//! `pending_manager_fee_shares` path when a Reserve hasn't opted into
//! multi-recipient routing (no `ManagerFeeRecipients` account yet) -- in
//! that case the only valid `recipient` is the Reserve's Primary Fee
//! Destination itself, and this instruction behaves like the Manager half
//! of the existing `collect_fees`.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use crate::constants::{MANAGER_FEE_RECIPIENTS_SEED, MINT_AUTHORITY_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED};
use crate::errors::SsrError;
use crate::events::ManagerFeeShareCollected;
use crate::state::{ManagerFeeRecipients, Reserve};

#[derive(Accounts)]
pub struct CollectManagerFeeShare<'info> {
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

    /// Optional (DEC-0094): pass the program ID itself as a "None" sentinel
    /// for a not-yet-migrated Reserve (legacy fallback path).
    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

    /// CHECK: the recipient being paid out -- validated in the handler
    /// against either the `ManagerFeeRecipients` array or (fallback)
    /// `reserve.fee_config.fee_destination`. Only used as the ATA
    /// authority below; never a signer, since this is permissionless.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token_account: Account<'info, SplTokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'info, CollectManagerFeeShare<'info>>) -> Result<()> {
    let reserve_key = ctx.accounts.reserve.key();
    let recipient_key = ctx.accounts.recipient.key();

    let amount = match ctx.accounts.manager_fee_recipients.as_mut() {
        Some(recipients_account) => {
            require_keys_eq!(
                recipients_account.reserve,
                reserve_key,
                SsrError::ManagerFeeRecipientsMismatch
            );
            let idx = recipients_account
                .find_recipient_index(&recipient_key)
                .ok_or(error!(SsrError::RecipientNotFound))?;
            let pending = recipients_account.recipients[idx].pending_fee_shares;
            require!(pending > 0, SsrError::NoPendingFees);
            recipients_account.recipients[idx].pending_fee_shares = 0;
            recipients_account.recipients[idx].collected_fee_shares = recipients_account
                .recipients[idx]
                .collected_fee_shares
                .checked_add(pending)
                .ok_or(error!(SsrError::MathOverflow))?;
            pending
        }
        None => {
            require_keys_eq!(
                recipient_key,
                ctx.accounts.reserve.fee_config.fee_destination,
                SsrError::RecipientNotFound
            );
            let pending = ctx.accounts.reserve.fee_config.pending_manager_fee_shares;
            require!(pending > 0, SsrError::NoPendingFees);
            ctx.accounts.reserve.fee_config.pending_manager_fee_shares = 0;
            pending
        }
    };

    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[mint_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];
    let cpi_accounts = MintTo {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        to: ctx.accounts.recipient_token_account.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
    token::mint_to(cpi_ctx, amount)?;

    emit!(ManagerFeeShareCollected {
        reserve: reserve_key,
        recipient: recipient_key,
        amount,
        collected_by: ctx.accounts.payer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
