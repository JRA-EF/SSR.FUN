//! DEC-0255: where the holder share goes -- Reserve backing, the pool, or both.
//!
//! - The creator may send part of the holder share (`pool_share_bps`, 1-10,000
//!   of it) into the Reserve Token's SSR pool instead of the basket. The
//!   choice is made once, in the same transaction as
//!   `configure_liquidity_revenue_v2`, and can never be changed: the
//!   `LiquiditySplit` account is created once and no instruction writes its
//!   share afterwards. A pool without this account sends everything to backing
//!   (exactly DEC-0251).
//! - The pool leg reuses the basket feed's flash shape: `pool_feed_begin`
//!   lends released holder USDC to SSR's keeper; the keeper swaps about half
//!   into Reserve Tokens on the pool and deposits both sides; the next SSR
//!   instruction must be `pool_feed_end`, which moves the new LP tokens into
//!   the split's own LP account and refuses fewer than `min_lp` (signed by
//!   SSR's fee quote signer, which states the fair price). No instruction can
//!   move LP tokens out of that account: the liquidity is locked for good, and
//!   because CPMM keeps trading fees inside the pool, it compounds.
//! - Unspent USDC goes back to the feed as still-released; Reserve Token
//!   dust stays with the split, never with the keeper.
//! - The program caps the pool leg at its share of everything fed. The keeper
//!   may send the pool's part to backing instead (when the pool trades more
//!   than 1% away from NAV, adding there would hand the gap to arbitrageurs);
//!   the pool can catch up later, never overtake its share.
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Mint as ClassicMint, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{self, Mint, TokenAccount as InterfaceTokenAccount, TokenInterface, TransferChecked};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use super::liquidity_revenue::{LiquidityRevenue, RAYDIUM, ROUTER_SEED, USDC};
use super::liquidity_terms::{LiquidityTerms, BPS, TERMS_SEED};
use super::usdc_mint_fee::require_fee_quote_signer;
use crate::constants::{RESERVE_SEED, SETTLEMENT_KEEPER_CONFIG_SEED};
use crate::errors::SsrError;
use crate::state::{Reserve, ReserveStatus, SettlementKeeperConfig};

pub const SPLIT_SEED: &[u8] = b"liquidity_split";
pub const POOL_FEED_TICKET_SEED: &[u8] = b"pool_feed_ticket";

#[account]
pub struct LiquiditySplit {
    pub terms: Pubkey,
    /// Share of the holder share that goes to the pool. Set once.
    pub pool_share_bps: u16,
    /// Lifetime holder USDC that went into the pool.
    pub pool_fed: u64,
    /// Lifetime LP tokens locked in the split's LP account.
    pub lp_locked: u64,
    pub bump: u8,
}
impl LiquiditySplit {
    pub const SPACE: usize = 8 + 32 + 2 + 8 + 8 + 1;
}

/// Written by `pool_feed_begin`, closed by `pool_feed_end` in the same transaction.
#[account]
pub struct PoolFeedTicket {
    pub reserve: Pubkey,
    pub keeper_usdc: Pubkey,
    pub keeper_reserve_token: Pubkey,
    pub keeper_lp: Pubkey,
    /// Balances before begin lent anything: end counts only what changed.
    pub usdc_before: u64,
    pub reserve_token_before: u64,
    pub lp_before: u64,
    pub amount_in: u64,
    pub min_lp: u64,
    pub bump: u8,
}
impl PoolFeedTicket {
    pub const SPACE: usize = 8 + 32 * 4 + 8 * 5 + 1;
}

/// Whether the pool may take `amount` more: the pool never holds more than its
/// share of everything released to holders so far (fed plus still waiting), so
/// the pool and backing legs of one release can run in any order.
pub fn pool_feed_allowed(pool_fed: u64, released_total: u64, amount: u64, pool_share_bps: u16) -> bool {
    (pool_fed as u128 + amount as u128) * BPS as u128 <= released_total as u128 * pool_share_bps as u128
}

#[event]
pub struct LiquiditySplitConfigured {
    pub reserve: Pubkey, pub terms: Pubkey, pub pool_share_bps: u16,
}
#[event]
pub struct PoolFeedExecuted {
    pub reserve: Pubkey, pub pool: Pubkey, pub usdc_in: u64, pub usdc_returned: u64,
    pub lp_locked: u64, pub reserve_token_kept: u64, pub ts: i64,
}

#[derive(Accounts)]
pub struct ConfigureLiquiditySplit<'info> {
    #[account(mut)] pub manager: Signer<'info>,
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump,
        constraint = reserve.manager == manager.key() @ SsrError::LiquidityRevenueValidationFailed)]
    pub reserve: Box<Account<'info, Reserve>>,
    #[account(seeds = [ROUTER_SEED, reserve.key().as_ref()], bump = revenue.bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(seeds = [TERMS_SEED, revenue.key().as_ref()], bump = terms.bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    #[account(init, payer = manager, space = LiquiditySplit::SPACE, seeds = [SPLIT_SEED, terms.key().as_ref()], bump)]
    pub split: Box<Account<'info, LiquiditySplit>>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
pub fn configure_split(ctx: Context<ConfigureLiquiditySplit>, pool_share_bps: u16) -> Result<()> {
    require!(pool_share_bps > 0 && pool_share_bps as u64 <= BPS && ctx.accounts.terms.holder_share_bps > 0,
        SsrError::LiquiditySplitInvalid);
    // Only at launch: the terms must be created by this same transaction.
    let terms_key = ctx.accounts.terms.key();
    let ixs = ctx.accounts.instructions_sysvar.to_account_info();
    let mut launched_here = false;
    let mut i = 0;
    while let Ok(ix) = load_instruction_at_checked(i, &ixs) {
        if ix.program_id == crate::ID && ix.data.len() >= 8
            && ix.data[..8] == *crate::instruction::ConfigureLiquidityRevenueV2::DISCRIMINATOR
            && ix.accounts.get(4).map(|a| a.pubkey) == Some(terms_key) {
            launched_here = true;
            break;
        }
        i += 1;
    }
    require!(launched_here, SsrError::LiquiditySplitNotAtLaunch);
    **ctx.accounts.split = LiquiditySplit { terms: terms_key, pool_share_bps, pool_fed: 0, lp_locked: 0, bump: ctx.bumps.split };
    emit!(LiquiditySplitConfigured { reserve: ctx.accounts.reserve.key(), terms: terms_key, pool_share_bps });
    Ok(())
}

#[derive(Accounts)]
pub struct PoolFeedBegin<'info> {
    /// First account on purpose, matching `PoolFeedEnd`.
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump)]
    pub reserve: Box<Account<'info, Reserve>>,
    /// SSR's fee quote signer: receives the released USDC, adds the
    /// liquidity, and its signature binds `min_lp`.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [SETTLEMENT_KEEPER_CONFIG_SEED], bump = settlement_keeper_config.bump)]
    pub settlement_keeper_config: Box<Account<'info, SettlementKeeperConfig>>,
    #[account(seeds = [ROUTER_SEED, reserve.key().as_ref()], bump = revenue.bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(mut, seeds = [TERMS_SEED, revenue.key().as_ref()], bump = terms.bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    #[account(mut, seeds = [SPLIT_SEED, terms.key().as_ref()], bump = split.bump)]
    pub split: Box<Account<'info, LiquiditySplit>>,
    #[account(mut, address = get_associated_token_address(&terms.key(), &USDC) @ SsrError::LiquidityRevenueValidationFailed)]
    pub feed_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = USDC, token::authority = keeper)]
    pub keeper_usdc: Box<Account<'info, TokenAccount>>,
    #[account(token::mint = reserve.reserve_token_mint, token::authority = keeper)]
    pub keeper_reserve_token: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(address = Pubkey::find_program_address(&[b"pool_lp_mint", revenue.pool.as_ref()], &RAYDIUM).0 @ SsrError::LiquidityRevenueValidationFailed)]
    pub lp_mint: Box<Account<'info, ClassicMint>>,
    #[account(token::mint = lp_mint, token::authority = keeper)]
    pub keeper_lp: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = keeper, space = PoolFeedTicket::SPACE, seeds = [POOL_FEED_TICKET_SEED, reserve.key().as_ref()], bump)]
    pub ticket: Box<Account<'info, PoolFeedTicket>>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
pub fn split_feed_begin<'info>(ctx: Context<'info, PoolFeedBegin<'info>>, amount_in: u64, min_lp: u64) -> Result<()> {
    // Adding liquidity is a market action: only for a Reserve that is live.
    require!(ctx.accounts.reserve.status == ReserveStatus::Active, SsrError::UnexpectedReserveStatus);
    require!(amount_in > 0 && min_lp > 0, SsrError::ZeroValue);
    require_fee_quote_signer(&ctx.accounts.settlement_keeper_config, &ctx.accounts.keeper)?;
    let reserve_key = ctx.accounts.reserve.key();

    let ixs = ctx.accounts.instructions_sysvar.to_account_info();
    let current = load_current_index_checked(&ixs)? as usize;
    let mut found = false;
    let mut i = current + 1;
    while let Ok(ix) = load_instruction_at_checked(i, &ixs) {
        if ix.program_id == crate::ID {
            found = ix.data.len() >= 8
                && ix.data[..8] == *crate::instruction::PoolFeedEnd::DISCRIMINATOR
                && ix.accounts.first().map(|a| a.pubkey) == Some(reserve_key);
            break;
        }
        i += 1;
    }
    require!(found, SsrError::PoolFeedEndMissing);

    let now = Clock::get()?.unix_timestamp;
    let terms = &mut ctx.accounts.terms;
    terms.sync(now, ctx.accounts.feed_usdc.amount);
    require!(amount_in <= terms.unlocked, SsrError::BasketFeedExceedsReleased);
    let split = &mut ctx.accounts.split;
    let released_total = terms.total_fed.saturating_add(terms.unlocked);
    require!(pool_feed_allowed(split.pool_fed, released_total, amount_in, split.pool_share_bps), SsrError::PoolFeedExceedsShare);
    terms.unlocked -= amount_in;
    terms.total_fed = terms.total_fed.saturating_add(amount_in);
    split.pool_fed = split.pool_fed.saturating_add(amount_in);

    let ticket = &mut ctx.accounts.ticket;
    ticket.reserve = reserve_key;
    ticket.keeper_usdc = ctx.accounts.keeper_usdc.key();
    ticket.keeper_reserve_token = ctx.accounts.keeper_reserve_token.key();
    ticket.keeper_lp = ctx.accounts.keeper_lp.key();
    ticket.usdc_before = ctx.accounts.keeper_usdc.amount;
    ticket.reserve_token_before = ctx.accounts.keeper_reserve_token.amount;
    ticket.lp_before = ctx.accounts.keeper_lp.amount;
    ticket.amount_in = amount_in;
    ticket.min_lp = min_lp;
    ticket.bump = ctx.bumps.ticket;

    let revenue_key = ctx.accounts.revenue.key();
    let bump = [ctx.accounts.terms.bump];
    let seeds: &[&[u8]] = &[TERMS_SEED, revenue_key.as_ref(), &bump];
    token::transfer(CpiContext::new(ctx.accounts.token_program.key(), Transfer {
        from: ctx.accounts.feed_usdc.to_account_info(), to: ctx.accounts.keeper_usdc.to_account_info(),
        authority: ctx.accounts.terms.to_account_info(),
    }).with_signer(&[seeds]), amount_in)?;
    Ok(())
}

#[derive(Accounts)]
pub struct PoolFeedEnd<'info> {
    /// First account on purpose: begin's sysvar check matches it.
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump)]
    pub reserve: Box<Account<'info, Reserve>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [ROUTER_SEED, reserve.key().as_ref()], bump = revenue.bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(mut, seeds = [TERMS_SEED, revenue.key().as_ref()], bump = terms.bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    #[account(mut, seeds = [SPLIT_SEED, terms.key().as_ref()], bump = split.bump)]
    pub split: Box<Account<'info, LiquiditySplit>>,
    #[account(mut, close = keeper, seeds = [POOL_FEED_TICKET_SEED, reserve.key().as_ref()], bump = ticket.bump,
        constraint = ticket.reserve == reserve.key() @ SsrError::ReserveAssetMismatch)]
    pub ticket: Box<Account<'info, PoolFeedTicket>>,
    #[account(mut, address = get_associated_token_address(&terms.key(), &USDC) @ SsrError::LiquidityRevenueValidationFailed)]
    pub feed_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = ticket.keeper_usdc @ SsrError::LiquidityRevenueValidationFailed)]
    pub keeper_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = ticket.keeper_reserve_token @ SsrError::LiquidityRevenueValidationFailed)]
    pub keeper_reserve_token: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(mut, address = ticket.keeper_lp @ SsrError::LiquidityRevenueValidationFailed)]
    pub keeper_lp: Box<Account<'info, TokenAccount>>,
    #[account(address = Pubkey::find_program_address(&[b"pool_lp_mint", revenue.pool.as_ref()], &RAYDIUM).0 @ SsrError::LiquidityRevenueValidationFailed)]
    pub lp_mint: Box<Account<'info, ClassicMint>>,
    /// The locked LP: no instruction moves tokens out of it.
    #[account(init_if_needed, payer = keeper, associated_token::mint = lp_mint, associated_token::authority = split,
        associated_token::token_program = token_program)]
    pub split_lp: Box<Account<'info, TokenAccount>>,
    #[account(address = reserve.reserve_token_mint @ SsrError::LiquidityRevenueValidationFailed, mint::token_program = reserve_token_program)]
    pub reserve_token_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init_if_needed, payer = keeper, associated_token::mint = reserve_token_mint, associated_token::authority = split,
        associated_token::token_program = reserve_token_program)]
    pub split_reserve_token: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub reserve_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn split_feed_end<'info>(ctx: Context<'info, PoolFeedEnd<'info>>) -> Result<()> {
    let ticket = &ctx.accounts.ticket;
    let lp = ctx.accounts.keeper_lp.amount.checked_sub(ticket.lp_before).ok_or(error!(SsrError::PoolFeedMinimumNotMet))?;
    require!(lp >= ticket.min_lp, SsrError::PoolFeedMinimumNotMet);
    let usdc_left = ctx.accounts.keeper_usdc.amount.saturating_sub(ticket.usdc_before).min(ticket.amount_in);
    let tokens_left = ctx.accounts.keeper_reserve_token.amount.saturating_sub(ticket.reserve_token_before);
    let keeper = ctx.accounts.keeper.to_account_info();
    token::transfer(CpiContext::new(ctx.accounts.token_program.key(), Transfer {
        from: ctx.accounts.keeper_lp.to_account_info(), to: ctx.accounts.split_lp.to_account_info(), authority: keeper.clone(),
    }), lp)?;
    if usdc_left > 0 {
        token::transfer(CpiContext::new(ctx.accounts.token_program.key(), Transfer {
            from: ctx.accounts.keeper_usdc.to_account_info(), to: ctx.accounts.feed_usdc.to_account_info(), authority: keeper.clone(),
        }), usdc_left)?;
        // Already released once: it goes back as released, not as a new deposit.
        let terms = &mut ctx.accounts.terms;
        terms.unlocked += usdc_left;
        terms.total_fed -= usdc_left;
        ctx.accounts.split.pool_fed -= usdc_left;
    }
    if tokens_left > 0 {
        token_interface::transfer_checked(CpiContext::new(ctx.accounts.reserve_token_program.key(), TransferChecked {
            from: ctx.accounts.keeper_reserve_token.to_account_info(), mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.split_reserve_token.to_account_info(), authority: keeper,
        }), tokens_left, ctx.accounts.reserve_token_mint.decimals)?;
    }
    ctx.accounts.split.lp_locked = ctx.accounts.split.lp_locked.saturating_add(lp);
    emit!(PoolFeedExecuted { reserve: ticket.reserve, pool: ctx.accounts.revenue.pool, usdc_in: ticket.amount_in,
        usdc_returned: usdc_left, lp_locked: lp, reserve_token_kept: tokens_left, ts: Clock::get()?.unix_timestamp });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn pool_never_overtakes_its_share() {
        // 30% to the pool: of 1,000 released, at most 300 go to the pool, before or after backing.
        assert!(pool_feed_allowed(0, 1_000, 300, 3_000));
        assert!(!pool_feed_allowed(0, 1_000, 301, 3_000));
        assert!(!pool_feed_allowed(300, 1_000, 1, 3_000));
        assert!(pool_feed_allowed(0, 1, 1, 10_000));
        assert!(!pool_feed_allowed(0, 0, 1, 10_000));
        // Catch-up after backing took the pool's part while off NAV: the cap is cumulative.
        assert!(pool_feed_allowed(0, 10_000, 3_000, 3_000));
        assert!(pool_feed_allowed(2_999, 10_001, 1, 3_000));
        assert!(pool_feed_allowed(u64::MAX, u64::MAX, 0, 10_000));
        assert!(!pool_feed_allowed(u64::MAX, u64::MAX, 1, 10_000));
    }
}
