//! DEC-0250: a REAL rebalance on Mainnet -- value actually moves from one
//! vault to another. `update_targets` only writes target weights; until this
//! instruction pair nothing could take an asset out of a vault except a
//! redemption (always pro-rata across every asset), so a Manager could set
//! JUP to 0% and ZEC to 30% and the vaults would never change.
//!
//! Flash-swap shape, all inside ONE transaction:
//!   1. `rebalance_swap_begin(amount_in, min_out)` moves `amount_in` of the
//!      sell asset from its vault to the signer's own token account and
//!      writes a `RebalanceTicket`.
//!   2. Any swap the signer likes (in practice the Jupiter route SSR's server
//!      built) turns it into the buy asset in the signer's account.
//!   3. `rebalance_swap_end()` deposits everything that arrived in the
//!      signer's buy-asset account since step 1 into the buy vault, refuses
//!      unless it is at least `min_out`, and closes the ticket.
//!
//! Why this cannot be used to drain a vault:
//!   - begin refuses to run unless end is the next SSR instruction in the
//!     same transaction (instructions sysvar), and Solana transactions are
//!     atomic: if end fails, begin's withdrawal never happened.
//!   - `min_out` is bound by SSR's fee quote signer (the configured
//!     `SettlementKeeperConfig.keeper`, the same key that co-signs the USDC
//!     mint fee, DEC-0238) co-signing the whole transaction. The program has
//!     no price oracle; the quote signer is what says "this much ZEC is a fair
//!     price for that much JUP". A compromised quote signer combined with a
//!     malicious Manager could under-price a swap -- the same trust boundary
//!     as the mint fee, documented rather than hidden.
//!   - Only the root Manager or a co-manager holding EXECUTE_REBALANCE.
//!   - One ticket per Reserve (PDA), so swaps cannot interleave.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use anchor_lang::Discriminator;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use super::common::require_reserve_permission;
use super::usdc_mint_fee::require_fee_quote_signer;
use crate::constants::{REBALANCE_TICKET_SEED, RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED, SETTLEMENT_KEEPER_CONFIG_SEED, VAULT_AUTHORITY_SEED};
use crate::errors::SsrError;
use crate::events::RebalanceSwapExecuted;
use crate::state::{permission_flags, RebalanceTicket, Reserve, ReserveAsset, ReserveStatus, SettlementKeeperConfig};

#[derive(Accounts)]
pub struct RebalanceSwapBegin<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Box<Account<'info, Reserve>>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), mint_sell.key().as_ref()],
        bump = reserve_asset_sell.bump,
        constraint = reserve_asset_sell.reserve == reserve.key() @ SsrError::ReserveAssetMismatch,
    )]
    pub reserve_asset_sell: Box<Account<'info, ReserveAsset>>,

    #[account(
        mut,
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), mint_sell.key().as_ref()],
        bump,
        address = reserve_asset_sell.vault @ SsrError::InvalidReserveVault,
    )]
    pub vault_sell: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mint::token_program = token_program_sell)]
    pub mint_sell: Box<InterfaceAccount<'info, Mint>>,

    /// The signer's own account the sell asset is lent to for the swap.
    #[account(
        mut,
        token::mint = mint_sell,
        token::authority = signer,
        token::token_program = token_program_sell,
    )]
    pub signer_sell_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), mint_buy.key().as_ref()],
        bump = reserve_asset_buy.bump,
        constraint = reserve_asset_buy.reserve == reserve.key() @ SsrError::ReserveAssetMismatch,
    )]
    pub reserve_asset_buy: Box<Account<'info, ReserveAsset>>,

    #[account(
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), mint_buy.key().as_ref()],
        bump,
        address = reserve_asset_buy.vault @ SsrError::InvalidReserveVault,
    )]
    pub vault_buy: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint_buy: Box<InterfaceAccount<'info, Mint>>,

    /// The signer's own account the swap pays the buy asset into.
    #[account(token::mint = mint_buy, token::authority = signer)]
    pub signer_buy_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: this Reserve's vault-authority PDA, verified by seeds; signs the withdrawal.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = signer,
        space = RebalanceTicket::SPACE,
        seeds = [REBALANCE_TICKET_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub ticket: Box<Account<'info, RebalanceTicket>>,

    #[account(seeds = [SETTLEMENT_KEEPER_CONFIG_SEED], bump = settlement_keeper_config.bump)]
    pub settlement_keeper_config: Box<Account<'info, SettlementKeeperConfig>>,

    /// SSR's fee quote signer: its co-signature binds `min_out`.
    pub fee_quote_signer: Signer<'info>,

    /// CHECK: the instructions sysvar, by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program_sell: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RebalanceSwapEnd<'info> {
    /// First account on purpose: begin's sysvar check matches it.
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Box<Account<'info, Reserve>>,

    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        close = signer,
        seeds = [REBALANCE_TICKET_SEED, reserve.key().as_ref()],
        bump = ticket.bump,
        constraint = ticket.reserve == reserve.key() @ SsrError::ReserveAssetMismatch,
    )]
    pub ticket: Box<Account<'info, RebalanceTicket>>,

    #[account(address = ticket.mint_buy @ SsrError::ReserveAssetMismatch, mint::token_program = token_program_buy)]
    pub mint_buy: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = ticket.signer_buy_account @ SsrError::ReserveAssetMismatch)]
    pub signer_buy_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = ticket.vault_buy @ SsrError::InvalidReserveVault)]
    pub vault_buy: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_buy: Interface<'info, TokenInterface>,
}

pub fn begin_handler<'info>(ctx: Context<'info, RebalanceSwapBegin<'info>>, amount_in: u64, min_out: u64) -> Result<()> {
    let reserve = &ctx.accounts.reserve;
    require!(reserve.status == ReserveStatus::Active, SsrError::UnexpectedReserveStatus);
    reserve.require_not_paused()?;
    require!(amount_in > 0 && min_out > 0, SsrError::ZeroValue);

    let reserve_key = reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::EXECUTE_REBALANCE,
        ctx.program_id,
    )?;
    require_fee_quote_signer(&ctx.accounts.settlement_keeper_config, &ctx.accounts.fee_quote_signer)?;

    let mint_sell = ctx.accounts.mint_sell.key();
    let mint_buy = ctx.accounts.mint_buy.key();
    require!(mint_sell != mint_buy, SsrError::RebalanceLegSameAsset);
    require!(amount_in <= ctx.accounts.vault_sell.amount, SsrError::RebalanceSwapExceedsVault);

    // The next SSR instruction in this transaction must be rebalance_swap_end
    // for this same Reserve. Anything in between belongs to other programs
    // (the swap route); a second SSR instruction there is refused, so no
    // mint, redemption or second begin can run against the half-moved vaults.
    let ixs = ctx.accounts.instructions_sysvar.to_account_info();
    let current = load_current_index_checked(&ixs)? as usize;
    let mut found = false;
    let mut i = current + 1;
    while let Ok(ix) = load_instruction_at_checked(i, &ixs) {
        if ix.program_id == crate::ID {
            found = ix.data.len() >= 8
                && ix.data[..8] == *crate::instruction::RebalanceSwapEnd::DISCRIMINATOR
                && ix.accounts.first().map(|a| a.pubkey) == Some(reserve_key);
            break;
        }
        i += 1;
    }
    require!(found, SsrError::RebalanceSwapEndMissing);

    let ticket = &mut ctx.accounts.ticket;
    ticket.reserve = reserve_key;
    ticket.mint_sell = mint_sell;
    ticket.mint_buy = mint_buy;
    ticket.vault_buy = ctx.accounts.vault_buy.key();
    ticket.signer_buy_account = ctx.accounts.signer_buy_account.key();
    ticket.buy_balance_before = ctx.accounts.signer_buy_account.amount;
    ticket.amount_in = amount_in;
    ticket.min_out = min_out;
    ticket.bump = ctx.bumps.ticket;

    let bump = ctx.accounts.reserve.vault_authority_bump;
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, reserve_key.as_ref(), &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program_sell.key(),
            TransferChecked {
                from: ctx.accounts.vault_sell.to_account_info(),
                mint: ctx.accounts.mint_sell.to_account_info(),
                to: ctx.accounts.signer_sell_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount_in,
        ctx.accounts.mint_sell.decimals,
    )?;
    Ok(())
}

pub fn end_handler<'info>(ctx: Context<'info, RebalanceSwapEnd<'info>>) -> Result<()> {
    let ticket = &ctx.accounts.ticket;
    let received = ctx
        .accounts
        .signer_buy_account
        .amount
        .checked_sub(ticket.buy_balance_before)
        .ok_or(error!(SsrError::RebalanceSwapMinimumNotMet))?;
    require!(received >= ticket.min_out, SsrError::RebalanceSwapMinimumNotMet);

    let vault_before = ctx.accounts.vault_buy.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program_buy.key(),
            TransferChecked {
                from: ctx.accounts.signer_buy_account.to_account_info(),
                mint: ctx.accounts.mint_buy.to_account_info(),
                to: ctx.accounts.vault_buy.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ),
        received,
        ctx.accounts.mint_buy.decimals,
    )?;
    ctx.accounts.vault_buy.reload()?;
    let amount_out = ctx
        .accounts
        .vault_buy
        .amount
        .checked_sub(vault_before)
        .ok_or(error!(SsrError::MathUnderflow))?;

    emit!(RebalanceSwapExecuted {
        reserve: ticket.reserve,
        mint_sell: ticket.mint_sell,
        mint_buy: ticket.mint_buy,
        amount_in: ticket.amount_in,
        amount_out,
        min_out: ticket.min_out,
        executed_by: ctx.accounts.signer.key(),
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
