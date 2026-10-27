//! DEC-0257: the creator's trade tax, charged by the Reserve Token itself.
//!
//! The Buy/Sell tax of DEC-0240/0251 only applies to trades routed through
//! `swap_with_project_tax_v2`; Jupiter, bots and direct Raydium swaps never
//! touch it. The one charge every route pays is the Token-2022 transfer fee
//! (DEC-0229), so a pool launched through SSR can now carry its tax there:
//!
//! - `enable_trade_tax`: only at launch, in the same transaction as
//!   `configure_liquidity_revenue_v2`, signed by the Reserve's manager. Sets
//!   the mint's transfer fee to the protocol rate (0.15%) plus the larger of
//!   the pool's Buy/Sell rates, records that tax in `TradeTax`, and zeroes the
//!   pool's wrapper rates so a trade routed through SSR is not taxed twice.
//!   Token-2022 applies the new rate two epochs later. Set once; no
//!   instruction changes it afterwards.
//! - `collect_trade_tax`: permissionless, replaces `collect_transfer_fees` for
//!   these mints (which now refuses them, as does the admin's
//!   `update_transfer_fee`, so neither can move the creator's part). Harvests
//!   withheld fees, then splits them by the mint's current rate: the protocol
//!   part plus 20% of the tax to the SSR treasury, the creator's 80% to the
//!   pool's fixed treasury, and the holder share of it burned (supply falls,
//!   backing stays, so every holder's NAV rises). All paid in Reserve Tokens.
//!   Payouts are ordinary Token-2022 transfers, so they are charged the fee
//!   too; that fee is withheld again and split on the next collection.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::{
    self as spl_token_2022,
    extension::{transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as Token2022Mint,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TransferChecked};
use solana_instructions_sysvar::load_instruction_at_checked;

use super::liquidity_revenue::{LiquidityRevenue, ROUTER_SEED};
use super::liquidity_terms::{holder_part, LiquidityTerms, BPS, SSR_SHARE_BPS, TERMS_SEED};
use crate::constants::{
    MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS, PROTOCOL_CONFIG_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    RESERVE_TOKEN_TRANSFER_FEE_MAX_FEE, TRANSFER_FEE_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::state::{ProtocolConfig, Reserve};

pub const TRADE_TAX_SEED: &[u8] = b"trade_tax";
/// Same 0-2% range as the Buy/Sell sliders.
pub const MAX_TRADE_TAX_BPS: u16 = 200;
/// DEC-0268: the smallest trade tax. Below it the combined rate (protocol +
/// tax) can stay at or under the 0.25% protocol ceiling, where
/// `trade_tax_active` cannot see it (same floor as the app, DEC-0263).
pub const MIN_TRADE_TAX_BPS: u16 = 15;

#[account]
pub struct TradeTax {
    pub reserve: Pubkey,
    pub revenue: Pubkey,
    /// The creator's fixed treasury (the pool's `LiquidityRevenue.treasury`).
    pub treasury: Pubkey,
    pub tax_bps: u16,
    /// The protocol part of the combined rate when the tax was set.
    pub protocol_bps: u16,
    /// Share of the creator's 80% that is burned for holders. Set once.
    pub holder_share_bps: u16,
    /// Lifetime Reserve Token amounts paid out by `collect_trade_tax`.
    pub total_protocol: u64,
    pub total_creator: u64,
    pub total_burned: u64,
    pub bump: u8,
}
impl TradeTax {
    pub const SPACE: usize = 8 + 32 * 3 + 2 * 3 + 8 * 3 + 1;
}

#[event]
pub struct TradeTaxEnabled {
    pub reserve: Pubkey, pub reserve_token_mint: Pubkey, pub tax_bps: u16, pub protocol_bps: u16,
    pub new_transfer_fee_bps: u16, pub holder_share_bps: u16, pub effective_epoch: u64,
}
#[event]
pub struct TradeTaxCollected {
    pub reserve: Pubkey, pub reserve_token_mint: Pubkey, pub withheld: u64, pub fee_bps: u16,
    pub protocol_amount: u64, pub creator_amount: u64, pub burned_amount: u64,
    pub harvested_accounts: u16, pub collected_by: Pubkey, pub ts: i64,
}

/// (current-epoch rate, newer rate, withheld on the mint) of a Token-2022 Reserve Token.
pub fn mint_transfer_fee(mint_info: &AccountInfo) -> Result<(u16, u16, u64)> {
    let data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
    let fee = mint
        .get_extension::<TransferFeeConfig>()
        .map_err(|_| error!(SsrError::ReserveTokenHasNoTransferFee))?;
    let epoch = Clock::get()?.epoch;
    Ok((
        fee.get_epoch_fee(epoch).transfer_fee_basis_points.into(),
        fee.newer_transfer_fee.transfer_fee_basis_points.into(),
        fee.withheld_amount.into(),
    ))
}

/// True once a trade tax has been set on the mint: only `enable_trade_tax`
/// can raise a rate above the protocol ceiling. Checked by the protocol-only
/// `collect_transfer_fees` and `update_transfer_fee`, which must not touch
/// the creator's part.
pub fn trade_tax_active(current_bps: u16, newer_bps: u16) -> bool {
    current_bps > MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS || newer_bps > MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS
}

/// Splits `withheld` collected at `fee_bps` into (SSR, creator, burned).
/// Before the tax takes effect (`fee_bps` still the protocol rate) it is all
/// protocol fee. The protocol part rounds down; SSR takes the tax rounding.
pub fn trade_tax_split(withheld: u64, fee_bps: u16, protocol_bps: u16, holder_share_bps: u16) -> (u64, u64, u64) {
    if fee_bps <= protocol_bps || withheld == 0 {
        return (withheld, 0, 0);
    }
    let protocol_part = (withheld as u128 * protocol_bps as u128 / fee_bps as u128) as u64;
    let tax = withheld - protocol_part;
    let creator_all = (tax as u128 * (BPS - SSR_SHARE_BPS) as u128 / BPS as u128) as u64;
    let burned = holder_part(creator_all, holder_share_bps);
    (withheld - creator_all, creator_all - burned, burned)
}

#[derive(Accounts)]
pub struct EnableTradeTax<'info> {
    #[account(mut)] pub manager: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump,
        constraint = reserve.manager == manager.key() @ SsrError::LiquidityRevenueValidationFailed)]
    pub reserve: Box<Account<'info, Reserve>>,
    #[account(mut, seeds = [ROUTER_SEED, reserve.key().as_ref()], bump = revenue.bump)]
    pub revenue: Box<Account<'info, LiquidityRevenue>>,
    #[account(seeds = [TERMS_SEED, revenue.key().as_ref()], bump = terms.bump)]
    pub terms: Box<Account<'info, LiquidityTerms>>,
    #[account(init, payer = manager, space = TradeTax::SPACE, seeds = [TRADE_TAX_SEED, reserve.key().as_ref()], bump)]
    pub trade_tax: Box<Account<'info, TradeTax>>,
    /// CHECK: the Reserve's own Token-2022 mint, pinned by seeds and address;
    /// its fee extension is parsed in the handler.
    #[account(mut, seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()], bump,
        address = reserve.reserve_token_mint, owner = spl_token_2022::ID @ SsrError::ReserveTokenHasNoTransferFee)]
    pub reserve_token_mint: UncheckedAccount<'info>,
    /// CHECK: signer-only PDA, verified purely by seeds.
    #[account(seeds = [TRANSFER_FEE_AUTHORITY_SEED], bump)]
    pub transfer_fee_authority: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
pub fn enable(ctx: Context<EnableTradeTax>) -> Result<()> {
    require!(!ctx.accounts.protocol_config.paused, SsrError::ProtocolPaused);
    let tax_bps = ctx.accounts.revenue.buy_tax_bps.max(ctx.accounts.revenue.sell_tax_bps);
    require!(tax_bps >= MIN_TRADE_TAX_BPS && tax_bps <= MAX_TRADE_TAX_BPS, SsrError::TradeTaxInvalid);
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
    require!(launched_here, SsrError::TradeTaxNotAtLaunch);

    let mint_info = ctx.accounts.reserve_token_mint.to_account_info();
    let (current_bps, newer_bps, _) = mint_transfer_fee(&mint_info)?;
    require!(!trade_tax_active(current_bps, newer_bps), SsrError::TradeTaxInvalid);
    let protocol_bps = newer_bps;
    let new_bps = protocol_bps + tax_bps;
    // DEC-0268: the combined rate must sit above the protocol ceiling, so
    // `trade_tax_active` -- the guard of the protocol-only sweep and fee update,
    // which cannot see this account -- holds for as long as TradeTax exists.
    // Only this instruction can raise a rate past the ceiling and nothing
    // lowers it afterwards, so "rate above the ceiling" and "TradeTax exists"
    // are the same thing. (Was: a 0.05% or 0.10% tax gave 0.20% / 0.25%.)
    require!(new_bps > MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS, SsrError::TradeTaxInvalid);
    let authority_bump = [ctx.bumps.transfer_fee_authority];
    let authority_seeds: &[&[u8]] = &[TRANSFER_FEE_AUTHORITY_SEED, &authority_bump];
    let ix = spl_token_2022::extension::transfer_fee::instruction::set_transfer_fee(
        &spl_token_2022::ID, &mint_info.key(), &ctx.accounts.transfer_fee_authority.key(), &[],
        new_bps, RESERVE_TOKEN_TRANSFER_FEE_MAX_FEE,
    )?;
    invoke_signed(&ix, &[mint_info, ctx.accounts.transfer_fee_authority.to_account_info(),
        ctx.accounts.token_program.to_account_info()], &[authority_seeds])?;

    // The token now charges the tax on every route; the wrapper must not add it again.
    ctx.accounts.revenue.buy_tax_bps = 0;
    ctx.accounts.revenue.sell_tax_bps = 0;
    let holder_share_bps = ctx.accounts.terms.holder_share_bps;
    **ctx.accounts.trade_tax = TradeTax { reserve: ctx.accounts.reserve.key(), revenue: ctx.accounts.revenue.key(),
        treasury: ctx.accounts.revenue.treasury, tax_bps, protocol_bps, holder_share_bps,
        total_protocol: 0, total_creator: 0, total_burned: 0, bump: ctx.bumps.trade_tax };
    emit!(TradeTaxEnabled { reserve: ctx.accounts.reserve.key(), reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        tax_bps, protocol_bps, new_transfer_fee_bps: new_bps, holder_share_bps,
        effective_epoch: Clock::get()?.epoch.saturating_add(2) });
    Ok(())
}

#[derive(Accounts)]
pub struct CollectTradeTax<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump)]
    pub reserve: Box<Account<'info, Reserve>>,
    #[account(mut, seeds = [TRADE_TAX_SEED, reserve.key().as_ref()], bump = trade_tax.bump)]
    pub trade_tax: Box<Account<'info, TradeTax>>,
    #[account(mut, seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()], bump,
        address = reserve.reserve_token_mint, mint::token_program = token_program)]
    pub reserve_token_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: signer-only PDA, verified purely by seeds.
    #[account(seeds = [TRANSFER_FEE_AUTHORITY_SEED], bump)]
    pub transfer_fee_authority: UncheckedAccount<'info>,
    /// Withheld fees land here before the split; owned by the `trade_tax` PDA.
    #[account(init_if_needed, payer = payer, associated_token::mint = reserve_token_mint,
        associated_token::authority = trade_tax, associated_token::token_program = token_program)]
    pub staging: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: only the ATA authority below; must be the Protocol treasury.
    #[account(address = protocol_config.default_protocol_fee_destination @ SsrError::TransferFeeTreasuryMismatch)]
    pub protocol_treasury: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, associated_token::mint = reserve_token_mint,
        associated_token::authority = protocol_treasury, associated_token::token_program = token_program)]
    pub protocol_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: only the ATA authority below; must be the treasury fixed at launch.
    #[account(address = trade_tax.treasury @ SsrError::TransferFeeTreasuryMismatch)]
    pub creator_treasury: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, associated_token::mint = reserve_token_mint,
        associated_token::authority = creator_treasury, associated_token::token_program = token_program)]
    pub creator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: any number of this mint's token accounts (writable)
    // to harvest withheld fees from first. May be empty.
}
pub fn collect<'info>(ctx: Context<'info, CollectTradeTax<'info>>) -> Result<()> {
    let mint_info = ctx.accounts.reserve_token_mint.to_account_info();
    let token_program_info = ctx.accounts.token_program.to_account_info();
    let sources = ctx.remaining_accounts;
    if !sources.is_empty() {
        let source_keys: Vec<&Pubkey> = sources.iter().map(|a| a.key).collect();
        let ix = spl_token_2022::extension::transfer_fee::instruction::harvest_withheld_tokens_to_mint(
            &spl_token_2022::ID, &mint_info.key(), &source_keys)?;
        let mut infos = Vec::with_capacity(sources.len() + 2);
        infos.push(mint_info.clone());
        infos.extend_from_slice(sources);
        infos.push(token_program_info.clone());
        invoke_signed(&ix, &infos, &[])?;
    }
    let (fee_bps, _, on_mint) = mint_transfer_fee(&mint_info)?;
    if on_mint > 0 {
        let authority_bump = [ctx.bumps.transfer_fee_authority];
        let authority_seeds: &[&[u8]] = &[TRANSFER_FEE_AUTHORITY_SEED, &authority_bump];
        let ix = spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_mint(
            &spl_token_2022::ID, &mint_info.key(), &ctx.accounts.staging.key(),
            &ctx.accounts.transfer_fee_authority.key(), &[])?;
        invoke_signed(&ix, &[mint_info.clone(), ctx.accounts.staging.to_account_info(),
            ctx.accounts.transfer_fee_authority.to_account_info(), token_program_info.clone()], &[authority_seeds])?;
    }
    ctx.accounts.staging.reload()?;
    let withheld = ctx.accounts.staging.amount;
    let t = &ctx.accounts.trade_tax;
    let (protocol_amount, creator_amount, burned_amount) = trade_tax_split(withheld, fee_bps, t.protocol_bps, t.holder_share_bps);

    let reserve_key = ctx.accounts.reserve.key();
    let bump = [t.bump];
    let seeds: &[&[u8]] = &[TRADE_TAX_SEED, reserve_key.as_ref(), &bump];
    let decimals = ctx.accounts.reserve_token_mint.decimals;
    for (amount, to) in [(protocol_amount, ctx.accounts.protocol_token_account.to_account_info()),
        (creator_amount, ctx.accounts.creator_token_account.to_account_info())] {
        if amount > 0 {
            token_interface::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.staging.to_account_info(), mint: mint_info.clone(), to,
                authority: ctx.accounts.trade_tax.to_account_info(),
            }).with_signer(&[seeds]), amount, decimals)?;
        }
    }
    if burned_amount > 0 {
        token_interface::burn(CpiContext::new(ctx.accounts.token_program.key(), Burn {
            mint: mint_info, from: ctx.accounts.staging.to_account_info(),
            authority: ctx.accounts.trade_tax.to_account_info(),
        }).with_signer(&[seeds]), burned_amount)?;
    }
    let t = &mut ctx.accounts.trade_tax;
    t.total_protocol = t.total_protocol.saturating_add(protocol_amount);
    t.total_creator = t.total_creator.saturating_add(creator_amount);
    t.total_burned = t.total_burned.saturating_add(burned_amount);
    emit!(TradeTaxCollected { reserve: reserve_key, reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        withheld, fee_bps, protocol_amount, creator_amount, burned_amount,
        harvested_accounts: u16::try_from(sources.len()).unwrap_or(u16::MAX),
        collected_by: ctx.accounts.payer.key(), ts: Clock::get()?.unix_timestamp });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn before_the_tax_takes_effect_everything_is_protocol_fee() {
        assert_eq!(trade_tax_split(10_000, 15, 15, 5_000), (10_000, 0, 0));
    }
    #[test] fn split_at_one_percent_tax() {
        // 1.15% combined: 15/115 protocol, 100/115 tax; creator 80% of the tax.
        let (ssr, creator, burned) = trade_tax_split(115_000, 115, 15, 0);
        assert_eq!((ssr, creator, burned), (15_000 + 20_000, 80_000, 0));
    }
    #[test] fn holder_share_is_burned_from_the_creator_part() {
        let (ssr, creator, burned) = trade_tax_split(115_000, 115, 15, 2_000);
        assert_eq!((ssr, creator, burned), (35_000, 64_000, 16_000));
    }
    #[test] fn split_conserves_every_unit() {
        for w in [1u64, 7, 999, 1_234_567, u64::MAX / 3] {
            for (fee, hs) in [(215u16, 10_000u16), (100 + 15, 3_333), (16, 1)] {
                let (a, b, c) = trade_tax_split(w, fee, 15, hs);
                assert_eq!(a as u128 + b as u128 + c as u128, w as u128);
            }
        }
    }
    #[test] fn the_minimum_tax_always_clears_the_ceiling() {
        // At the live 0.15% protocol rate the smallest allowed tax gives 0.30%.
        assert!(trade_tax_active(15, 15 + MIN_TRADE_TAX_BPS));
        // The two rates the minimum shuts out were invisible to the guard.
        assert!(!trade_tax_active(15, 15 + 5) && !trade_tax_active(15, 15 + 10));
    }
    #[test] fn active_only_above_the_protocol_ceiling() {
        assert!(!trade_tax_active(15, 25));
        assert!(trade_tax_active(15, 115));
        assert!(trade_tax_active(115, 115));
    }
}
