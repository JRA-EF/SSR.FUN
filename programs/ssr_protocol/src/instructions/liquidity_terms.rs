//! DEC-0251: liquidity terms for pools created from this upgrade on.
//!
//! - SSR takes 20% of everything the creator earns from an SSR pool: the
//!   Raydium creator fee (measured after Raydium's own retained share, i.e.
//!   20% of what actually reaches the router) and the optional project
//!   Buy/Sell tax.
//! - The creator may give part of the remaining 80% back to holders. The
//!   choice (`holder_share_bps`, 0-10,000 of the creator's portion) is made
//!   once, at pool creation, and can never be changed: there is no
//!   instruction that writes it after `configure_liquidity_revenue_v2`.
//! - The holder share collects as USDC in the "basket feed" account (the
//!   canonical USDC ATA of the `LiquidityTerms` PDA). It is released
//!   linearly over 24 hours and the keeper swaps released USDC into the
//!   Reserve's assets and deposits them straight into the vaults. Mint and
//!   redeem price every token from LIVE vault balances, so a deposit raises
//!   the backing of every Reserve Token without minting anything.
//!
//! Pools created before this upgrade keep their recorded terms (0.05% of
//! the creator-fee base, 25% of tax) through the unchanged v1 instructions;
//! a pool is v2 exactly when its `LiquidityTerms` PDA exists. New pools can
//! only be configured through v2 (v1 `configure` now refuses).
//!
//! The feed reuses DEC-0250's flash-swap shape: `basket_feed_begin` lends
//! released USDC to the keeper and writes the same `RebalanceTicket`; the
//! next SSR instruction must be `rebalance_swap_end`, which deposits what
//! arrived in the keeper's buy-asset account into the vault and refuses
//! below `min_out`. The keeper is SSR's fee quote signer
//! (`SettlementKeeperConfig.keeper`), the key that already states fair
//! prices for the USDC mint fee and rebalance swaps.
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke};
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Mint as ClassicMint, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{Mint, TokenAccount as InterfaceTokenAccount};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use super::liquidity_revenue::{retained_rate, validate_pool, LiquidityRevenue, AMM_CONFIG, RAYDIUM, ROUTER_SEED, USDC};
use super::usdc_mint_fee::require_fee_quote_signer;
use crate::constants::{PROTOCOL_CONFIG_SEED, REBALANCE_TICKET_SEED, RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED, SETTLEMENT_KEEPER_CONFIG_SEED};
use crate::errors::SsrError;
use crate::state::{ProtocolConfig, RebalanceTicket, Reserve, ReserveAsset, ReserveStatus, SettlementKeeperConfig};

pub const TERMS_SEED: &[u8] = b"liquidity_terms";
/// SSR's share of the creator's pool earnings (fee and tax), in bps.
pub const SSR_SHARE_BPS: u64 = 2_000;
pub const BPS: u64 = 10_000;
/// Holder-share release window.
pub const FEED_RELEASE_SECONDS: i64 = 86_400;

#[account]
pub struct LiquidityTerms {
    pub reserve: Pubkey,
    pub revenue: Pubkey,
    /// Share of the creator's portion that feeds the basket. Set once.
    pub holder_share_bps: u16,
    /// Feed USDC still releasing.
    pub locked: u64,
    /// Feed USDC released and not yet fed.
    pub unlocked: u64,
    pub stream_end: i64,
    pub last_update: i64,
    /// Lifetime USDC handed to the keeper for the basket.
    pub total_fed: u64,
    pub bump: u8,
}
impl LiquidityTerms {
    pub const SPACE: usize = 8 + 32 * 2 + 2 + 8 * 2 + 8 * 2 + 8 + 1;

    fn release(&mut self, now: i64) {
        if now <= self.last_update { return; }
        if self.locked > 0 {
            if now >= self.stream_end {
                self.unlocked += self.locked;
                self.locked = 0;
            } else {
                let released = (self.locked as u128 * (now - self.last_update) as u128
                    / (self.stream_end - self.last_update) as u128) as u64;
                self.locked -= released;
                self.unlocked += released;
            }
        }
        self.last_update = now;
    }

    /// Brings the stream up to `now` against the feed account's real
    /// balance. Anything that arrived since the last sync (distribution,
    /// tax, or a plain transfer) starts releasing now, and the remainder
    /// still locked is spread over the new 24-hour window with it.
    pub fn sync(&mut self, now: i64, balance: u64) {
        self.release(now);
        let tracked = self.locked as u128 + self.unlocked as u128;
        if (balance as u128) < tracked {
            // Never expected (only basket_feed_begin moves funds out, and it
            // syncs first); fail safe by never releasing more than exists.
            self.unlocked = self.unlocked.min(balance);
            self.locked = self.locked.min(balance - self.unlocked);
        } else if (balance as u128) > tracked {
            self.locked += (balance as u128 - tracked) as u64;
            self.stream_end = now + FEED_RELEASE_SECONDS;
        }
    }
}

/// SSR's 20% of collected creator fees; the carry keeps many small
/// distributions from rounding SSR's share away.
pub fn creator_fee_split(net: u64, carry: u128) -> Result<(u64, u128)> {
    require!(carry < BPS as u128, SsrError::LiquidityRevenueValidationFailed);
    let numerator = net as u128 * SSR_SHARE_BPS as u128 + carry;
    Ok(((numerator / BPS as u128) as u64, numerator % BPS as u128))
}
/// The project tax on `amount` (rounded up, as v1) split 20% SSR / 80%
/// creator; SSR receives the rounding remainder.
pub fn tax_split_v2(amount: u64, bps: u16) -> Result<(u64, u64)> {
    require!(bps <= 200, SsrError::LiquidityRevenueValidationFailed);
    let total = u64::try_from((amount as u128 * bps as u128 + 9999) / 10000).map_err(|_| error!(SsrError::MathOverflow))?;
    let creator = (total as u128 * (BPS - SSR_SHARE_BPS) as u128 / BPS as u128) as u64;
    Ok((total - creator, creator))
}
/// The holder part of a creator amount (rounded down, in the creator's favour).
pub fn holder_part(creator_amount: u64, holder_share_bps: u16) -> u64 {
    (creator_amount as u128 * holder_share_bps as u128 / BPS as u128) as u64
}

#[event]
pub struct LiquidityTermsConfigured {
    pub reserve: Pubkey, pub pool: Pubkey, pub buy_tax_bps: u16, pub sell_tax_bps: u16, pub holder_share_bps: u16,
}
#[event]
pub struct LiquidityRevenueDistributedV2 {
    pub reserve: Pubkey, pub pool: Pubkey, pub protocol_usdc: u64, pub creator_usdc: u64, pub holder_usdc: u64,
}
#[event]
pub struct ProjectTaxChargedV2 {
    pub reserve: Pubkey, pub pool: Pubkey, pub user: Pubkey, pub buy: bool,
    pub protocol_usdc: u64, pub creator_usdc: u64, pub holder_usdc: u64, pub net_output: u64,
}
#[event]
pub struct BasketFeedReleased {
    pub reserve: Pubkey, pub mint_buy: Pubkey, pub usdc_in: u64, pub min_out: u64,
    pub still_locked: u64, pub still_unlocked: u64, pub ts: i64,
}

#[derive(Accounts)]
pub struct ConfigureLiquidityRevenueV2<'info> {
    #[account(mut)] pub manager: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump,
        constraint = reserve.manager == manager.key() @ SsrError::LiquidityRevenueValidationFailed)]
    pub reserve: Box<Account<'info, Reserve>>,
    #[account(init, payer = manager, space = LiquidityRevenue::SPACE,
        seeds = [ROUTER_SEED, reserve.key().as_ref()], bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(init, payer = manager, space = LiquidityTerms::SPACE,
        seeds = [TERMS_SEED, revenue.key().as_ref()], bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    /// The basket feed. `init_if_needed` so nobody can block configuration
    /// by creating this ATA first.
    #[account(init_if_needed, payer = manager, associated_token::mint = usdc_mint,
        associated_token::authority = terms, associated_token::token_program = token_program)]
    pub feed_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = USDC)] pub usdc_mint: Box<Account<'info, ClassicMint>>,
    /// CHECK: validated packed Raydium PoolState, including creator and pair.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: validated fixed Raydium AmmConfig.
    #[account(address = AMM_CONFIG)] pub amm_config: UncheckedAccount<'info>,
    /// CHECK: validated canonical optional CreatorFeeShare PDA.
    pub creator_fee_share: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn configure_v2(ctx: Context<ConfigureLiquidityRevenueV2>, buy_tax_bps: u16, sell_tax_bps: u16, holder_share_bps: u16) -> Result<()> {
    require!(!ctx.accounts.protocol_config.paused && buy_tax_bps <= 200 && sell_tax_bps <= 200, SsrError::LiquidityRevenueValidationFailed);
    require!(holder_share_bps as u64 <= BPS, SsrError::LiquidityHolderShareInvalid);
    let revenue_key = ctx.accounts.revenue.key();
    validate_pool(&ctx.accounts.pool, ctx.accounts.reserve.reserve_token_mint, revenue_key)?;
    let rate = retained_rate(&ctx.accounts.amm_config, &ctx.accounts.creator_fee_share, revenue_key)?;
    **ctx.accounts.revenue = LiquidityRevenue { reserve: ctx.accounts.reserve.key(), pool: ctx.accounts.pool.key(),
        treasury: ctx.accounts.reserve.fee_config.fee_destination, buy_tax_bps, sell_tax_bps, retained_rate: rate, remainder: 0, bump: ctx.bumps.revenue };
    let now = Clock::get()?.unix_timestamp;
    **ctx.accounts.terms = LiquidityTerms { reserve: ctx.accounts.reserve.key(), revenue: revenue_key, holder_share_bps,
        locked: 0, unlocked: 0, stream_end: now, last_update: now, total_fed: 0, bump: ctx.bumps.terms };
    emit!(LiquidityTermsConfigured { reserve: ctx.accounts.reserve.key(), pool: ctx.accounts.pool.key(), buy_tax_bps, sell_tax_bps, holder_share_bps });
    Ok(())
}

#[derive(Accounts)]
pub struct DistributeLiquidityRevenueV2<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [ROUTER_SEED, revenue.reserve.as_ref()], bump = revenue.bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(mut, seeds = [TERMS_SEED, revenue.key().as_ref()], bump = terms.bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    #[account(mut, constraint = staging.owner == revenue.key() && staging.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub staging: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, constraint = protocol_destination.owner == protocol_config.default_protocol_fee_destination && protocol_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub protocol_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, constraint = creator_destination.owner == revenue.treasury && creator_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub creator_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&terms.key(), &USDC) @ SsrError::LiquidityRevenueValidationFailed)]
    pub feed_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: config validated before distribution. Changes fail closed.
    #[account(address = AMM_CONFIG)] pub amm_config: UncheckedAccount<'info>,
    /// CHECK: canonical optional override validated before distribution.
    pub creator_fee_share: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
pub fn distribute_v2(ctx: Context<DistributeLiquidityRevenueV2>) -> Result<()> {
    let rate = retained_rate(&ctx.accounts.amm_config, &ctx.accounts.creator_fee_share, ctx.accounts.revenue.key())?;
    require!(rate == ctx.accounts.revenue.retained_rate, SsrError::LiquidityRevenueEconomicsChanged);
    let total = ctx.accounts.staging.amount;
    let (ssr, remainder) = creator_fee_split(total, ctx.accounts.revenue.remainder)?;
    let holders = holder_part(total - ssr, ctx.accounts.terms.holder_share_bps);
    let creator = total - ssr - holders;
    let reserve = ctx.accounts.revenue.reserve;
    let bump = [ctx.accounts.revenue.bump];
    let seeds: &[&[u8]] = &[ROUTER_SEED, reserve.as_ref(), &bump];
    for (amount, destination) in [(ssr, ctx.accounts.protocol_destination.to_account_info()),
        (creator, ctx.accounts.creator_destination.to_account_info()), (holders, ctx.accounts.feed_usdc.to_account_info())] {
        if amount > 0 { token::transfer(CpiContext::new(ctx.accounts.token_program.key(), Transfer {
            from: ctx.accounts.staging.to_account_info(), to: destination, authority: ctx.accounts.revenue.to_account_info(),
        }).with_signer(&[seeds]), amount)?; }
    }
    ctx.accounts.revenue.remainder = remainder;
    // Start the holder share's 24-hour release now.
    ctx.accounts.feed_usdc.reload()?;
    let (now, balance) = (Clock::get()?.unix_timestamp, ctx.accounts.feed_usdc.amount);
    ctx.accounts.terms.sync(now, balance);
    emit!(LiquidityRevenueDistributedV2 { reserve, pool: ctx.accounts.revenue.pool, protocol_usdc: ssr, creator_usdc: creator, holder_usdc: holders });
    Ok(())
}

#[derive(Accounts)]
pub struct SwapWithProjectTaxV2<'info> {
    // Same account rules as v1 `SwapWithProjectTax` (see its comment on
    // `dup`), plus the terms and the basket feed.
    pub user: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [ROUTER_SEED, revenue.reserve.as_ref()], bump = revenue.bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(mut, seeds = [TERMS_SEED, revenue.key().as_ref()], bump = terms.bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    #[account(mut, constraint = user_usdc.owner == user.key() && user_usdc.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, constraint = protocol_destination.owner == protocol_config.default_protocol_fee_destination && protocol_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub protocol_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, constraint = creator_destination.owner == revenue.treasury && creator_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub creator_destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&terms.key(), &USDC) @ SsrError::LiquidityRevenueValidationFailed)]
    pub feed_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: address pins CPI to Raydium.
    #[account(address = RAYDIUM, executable)] pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    // Exactly the 13 native Swap accounts, in Raydium's documented order.
}
fn key(data: &[u8], offset: usize) -> Pubkey { Pubkey::new_from_array(data[offset..offset+32].try_into().unwrap()) }
fn u64_at(data: &[u8], offset: usize) -> u64 { u64::from_le_bytes(data[offset..offset+8].try_into().unwrap()) }
pub fn taxed_swap_v2<'info>(ctx: Context<'info, SwapWithProjectTaxV2<'info>>, buy: bool, amount_in: u64, minimum_net_out: u64) -> Result<()> {
    require!(!ctx.accounts.protocol_config.paused && amount_in>0 && minimum_net_out>0, SsrError::LiquidityRevenueValidationFailed);
    let a = ctx.remaining_accounts;
    require!(a.len()==13 && a[0].key()==ctx.accounts.user.key() && a[3].key()==ctx.accounts.revenue.pool, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(a[2].key(), AMM_CONFIG, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(a[if buy {4} else {5}].key(), ctx.accounts.user_usdc.key(), SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(a[if buy {10} else {11}].key(), USDC, SsrError::LiquidityRevenueValidationFailed);
    // Raydium validates pool vaults, mints, programs and observation PDA.
    // Only the user's signer is forwarded; no protocol/Reserve PDA signs.
    let before_usdc = ctx.accounts.user_usdc.amount;
    let before_output = {
        let d=a[5].try_borrow_data()?;
        require!(d.len()>=165, SsrError::LiquidityRevenueValidationFailed);
        require_keys_eq!(key(&d,32), ctx.accounts.user.key(), SsrError::LiquidityRevenueValidationFailed);
        u64_at(&d,64)
    };
    let (mut ssr,mut creator) = if buy {tax_split_v2(amount_in,ctx.accounts.revenue.buy_tax_bps)?} else {(0,0)};
    let swap_input = amount_in.checked_sub(ssr+creator).ok_or(error!(SsrError::MathUnderflow))?;
    require!(swap_input>0, SsrError::LiquidityRevenueValidationFailed);
    let mut data=vec![143,190,90,218,196,30,51,222]; // global:swap_base_input
    data.extend_from_slice(&swap_input.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes()); // final user-net minimum checked below
    let ix=Instruction {program_id:RAYDIUM, data, accounts:a.iter().enumerate().map(|(i,x)| {
        let writable=matches!(i,3|4|5|6|7|12);
        if writable {AccountMeta::new(x.key(),i==0)} else {AccountMeta::new_readonly(x.key(),i==0)}
    }).collect()};
    invoke(&ix,a)?;
    ctx.accounts.user_usdc.reload()?;
    let output = {let d=a[5].try_borrow_data()?;u64_at(&d,64).checked_sub(before_output).ok_or(error!(SsrError::MathUnderflow))?};
    if !buy {
        let received=ctx.accounts.user_usdc.amount.checked_sub(before_usdc).ok_or(error!(SsrError::MathUnderflow))?;
        (ssr,creator)=tax_split_v2(received,ctx.accounts.revenue.sell_tax_bps)?;
    }
    let net_output=if buy {output} else {output.checked_sub(ssr+creator).ok_or(error!(SsrError::MathUnderflow))?};
    require!(net_output>=minimum_net_out, SsrError::LiquiditySwapMinimumNotMet);
    let holders = holder_part(creator, ctx.accounts.terms.holder_share_bps);
    let creator = creator - holders;
    for (amount,to) in [(ssr,ctx.accounts.protocol_destination.to_account_info()),(creator,ctx.accounts.creator_destination.to_account_info()),
        (holders,ctx.accounts.feed_usdc.to_account_info())] {
        if amount>0 {token::transfer(CpiContext::new(ctx.accounts.token_program.key(),Transfer {
            from:ctx.accounts.user_usdc.to_account_info(),to,authority:ctx.accounts.user.to_account_info(),
        }),amount)?;}
    }
    if holders > 0 {
        ctx.accounts.feed_usdc.reload()?;
        let (now, balance) = (Clock::get()?.unix_timestamp, ctx.accounts.feed_usdc.amount);
        ctx.accounts.terms.sync(now, balance);
    }
    emit!(ProjectTaxChargedV2 {reserve:ctx.accounts.revenue.reserve,pool:ctx.accounts.revenue.pool,user:ctx.accounts.user.key(),buy,
        protocol_usdc:ssr,creator_usdc:creator,holder_usdc:holders,net_output});
    Ok(())
}

#[derive(Accounts)]
pub struct BasketFeedBegin<'info> {
    /// First account on purpose, matching `RebalanceSwapEnd`.
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump)]
    pub reserve: Box<Account<'info, Reserve>>,
    /// SSR's fee quote signer: receives the released USDC, routes it, and
    /// its signature binds `min_out`.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [SETTLEMENT_KEEPER_CONFIG_SEED], bump = settlement_keeper_config.bump)]
    pub settlement_keeper_config: Box<Account<'info, SettlementKeeperConfig>>,
    #[account(seeds = [ROUTER_SEED, reserve.key().as_ref()], bump = revenue.bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(mut, seeds = [TERMS_SEED, revenue.key().as_ref()], bump = terms.bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    #[account(mut, address = get_associated_token_address(&terms.key(), &USDC) @ SsrError::LiquidityRevenueValidationFailed)]
    pub feed_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = USDC, token::authority = keeper)]
    pub keeper_usdc: Box<Account<'info, TokenAccount>>,
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
    pub vault_buy: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    pub mint_buy: Box<InterfaceAccount<'info, Mint>>,
    /// The keeper's account the route pays the buy asset into. For a USDC
    /// asset this is `keeper_usdc` itself (no route needed).
    #[account(token::mint = mint_buy, token::authority = keeper)]
    pub keeper_buy_account: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,
    #[account(init, payer = keeper, space = RebalanceTicket::SPACE,
        seeds = [REBALANCE_TICKET_SEED, reserve.key().as_ref()], bump)]
    pub ticket: Box<Account<'info, RebalanceTicket>>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
pub fn feed_begin<'info>(ctx: Context<'info, BasketFeedBegin<'info>>, amount_in: u64, min_out: u64) -> Result<()> {
    // Holders can still redeem while paused or winding down, so their
    // backing keeps growing then too; only a closed Reserve is refused.
    require!(matches!(ctx.accounts.reserve.status, ReserveStatus::Active | ReserveStatus::Paused | ReserveStatus::WindDown),
        SsrError::UnexpectedReserveStatus);
    require!(amount_in > 0 && min_out > 0, SsrError::ZeroValue);
    require_fee_quote_signer(&ctx.accounts.settlement_keeper_config, &ctx.accounts.keeper)?;
    let reserve_key = ctx.accounts.reserve.key();

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

    let now = Clock::get()?.unix_timestamp;
    let terms = &mut ctx.accounts.terms;
    terms.sync(now, ctx.accounts.feed_usdc.amount);
    require!(amount_in <= terms.unlocked, SsrError::BasketFeedExceedsReleased);
    terms.unlocked -= amount_in;
    terms.total_fed = terms.total_fed.saturating_add(amount_in);

    let ticket = &mut ctx.accounts.ticket;
    ticket.reserve = reserve_key;
    ticket.mint_sell = USDC;
    ticket.mint_buy = ctx.accounts.mint_buy.key();
    ticket.vault_buy = ctx.accounts.vault_buy.key();
    ticket.signer_buy_account = ctx.accounts.keeper_buy_account.key();
    ticket.buy_balance_before = ctx.accounts.keeper_buy_account.amount;
    ticket.amount_in = amount_in;
    ticket.min_out = min_out;
    ticket.bump = ctx.bumps.ticket;

    let revenue_key = ctx.accounts.revenue.key();
    let bump = [ctx.accounts.terms.bump];
    let seeds: &[&[u8]] = &[TERMS_SEED, revenue_key.as_ref(), &bump];
    token::transfer(CpiContext::new(ctx.accounts.token_program.key(), Transfer {
        from: ctx.accounts.feed_usdc.to_account_info(), to: ctx.accounts.keeper_usdc.to_account_info(),
        authority: ctx.accounts.terms.to_account_info(),
    }).with_signer(&[seeds]), amount_in)?;
    emit!(BasketFeedReleased { reserve: reserve_key, mint_buy: ctx.accounts.mint_buy.key(), usdc_in: amount_in, min_out,
        still_locked: ctx.accounts.terms.locked, still_unlocked: ctx.accounts.terms.unlocked, ts: now });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn terms() -> LiquidityTerms {
        LiquidityTerms { reserve: Pubkey::default(), revenue: Pubkey::default(), holder_share_bps: 5000,
            locked: 0, unlocked: 0, stream_end: 0, last_update: 0, total_fed: 0, bump: 0 }
    }
    #[test] fn ssr_takes_twenty_percent_without_fragmentation_loss() {
        assert_eq!(creator_fee_split(1_000_000, 0).unwrap(), (200_000, 0));
        let mut carry = 0; let mut total = 0;
        for _ in 0..10_000 { let (p, c) = creator_fee_split(1, carry).unwrap(); total += p; carry = c; }
        assert_eq!(total, 2_000); assert_eq!(carry, 0);
        assert!(creator_fee_split(1, 10_000).is_err());
    }
    #[test] fn tax_v2_conserves_and_zero_is_zero() {
        assert_eq!(tax_split_v2(1_000_000, 200).unwrap(), (4000, 16000));
        assert_eq!(tax_split_v2(1_000_000, 0).unwrap(), (0, 0));
        for n in 0..1000 { let (p, c) = tax_split_v2(n, 100).unwrap(); assert_eq!(p + c, (n + 99) / 100); assert!(c * 5 <= (p + c) * 4); }
        let (p, c) = tax_split_v2(u64::MAX, 200).unwrap();
        assert_eq!(p as u128 + c as u128, ((u64::MAX as u128) * 200 + 9999) / 10000);
        assert!(tax_split_v2(1, 201).is_err());
    }
    #[test] fn holder_part_bounds() {
        assert_eq!(holder_part(800, 0), 0);
        assert_eq!(holder_part(800, 10_000), 800);
        assert_eq!(holder_part(800, 5_000), 400);
        assert_eq!(holder_part(3, 5_000), 1);
        assert_eq!(holder_part(u64::MAX, 10_000), u64::MAX);
    }
    #[test] fn feed_releases_linearly_over_24h() {
        let mut t = terms();
        t.sync(1_000, 24_000);
        assert_eq!((t.locked, t.unlocked, t.stream_end), (24_000, 0, 1_000 + 86_400));
        t.sync(1_000 + 3_600, 24_000);
        assert_eq!(t.unlocked, 1_000);
        t.sync(1_000 + 43_200, 24_000);
        assert_eq!(t.unlocked, 12_000);
        t.sync(1_000 + 86_400 + 5, 24_000);
        assert_eq!((t.locked, t.unlocked), (0, 24_000));
    }
    #[test] fn new_deposit_restarts_window_for_remaining_lock() {
        let mut t = terms();
        t.sync(0, 86_400);
        t.sync(43_200, 86_400);
        assert_eq!((t.locked, t.unlocked), (43_200, 43_200));
        // Keeper feeds what was released.
        t.unlocked = 0;
        t.sync(43_200, 43_200 + 43_200);
        assert_eq!((t.locked, t.unlocked), (86_400, 0));
        assert_eq!(t.stream_end, 43_200 + 86_400);
        t.sync(43_200 + 86_400, 86_400);
        assert_eq!((t.locked, t.unlocked), (0, 86_400));
    }
    #[test] fn sync_never_releases_more_than_balance() {
        let mut t = terms();
        t.sync(0, 1_000);
        t.sync(86_400, 400);
        assert!(t.locked + t.unlocked <= 400);
        let mut t = terms();
        t.sync(10, 0);
        assert_eq!((t.locked, t.unlocked), (0, 0));
        t.sync(5, 50); // clock never moves backwards on-chain; still safe
        assert_eq!(t.locked + t.unlocked, 50);
    }
}
