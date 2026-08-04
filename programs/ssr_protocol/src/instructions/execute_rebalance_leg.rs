// NOT YET BUILT/DEPLOYED: this instruction and its ssr_devnet_amm CPI
// dependency were written in an environment with no cargo/rustc/anchor/
// solana on PATH (see this pass's final report) -- API surface (account
// field names, CPI module paths, `.reload()`) matches the established
// Anchor 1.1.2 conventions already used elsewhere in this workspace, but
// has not been compiler-checked. Confirm with `cargo check` before relying
// on it.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use ssr_devnet_amm::cpi::accounts::Swap as AmmSwapAccounts;
use ssr_devnet_amm::cpi::swap as amm_swap_cpi;
use ssr_devnet_amm::program::SsrDevnetAmm;
use ssr_devnet_amm::state::{AmmConfig, Pool as AmmPool};

use super::common::require_reserve_permission;
use crate::constants::{RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED, VAULT_AUTHORITY_SEED};
use crate::errors::SsrError;
use crate::events::RebalanceLegExecuted;
use crate::state::{permission_flags, Reserve, ReserveAsset};

/// Genuinely executes one rebalance leg (a real swap of this Reserve's own
/// vault assets via ssr_devnet_amm) -- unlike `update_targets` (which only
/// writes `target_weight_bps` state) and `record_rebalance` (an unverified
/// attestation of a trade that happened elsewhere), this instruction moves
/// real value through a real, on-chain, CPI'd swap.
///
/// ONE LEG (one CPI) PER CALL, deliberately not an all-legs-in-one-instruction
/// loop: bounds compute/account limits for a Reserve with several registered
/// assets, and leaves a mid-plan failure as an inspectable, real partial
/// state (each leg is its own transaction, submitted sequentially by a
/// client-side orchestrator) rather than reverting an entire multi-leg
/// batch. Rebalance legs are independent trades against independent pools --
/// they should NOT be forced atomic with each other the way a single Buy/
/// Sell's own legs are.
///
/// Reuses this Reserve's own `vault_authority` PDA (the exact seeds
/// `redeem_reserve_tokens_in_kind` already uses to sign outbound vault
/// transfers) as the CPI's signing "trader" -- the Reserve's own
/// already-registered asset vaults are passed DIRECTLY as the AMM's
/// `trader_token_a`/`trader_token_b` accounts, so no intermediate transfer
/// is ever needed; value moves straight from one of this Reserve's own
/// vaults to another via the pool.
///
/// LIMITATION, documented not hidden (mirrors `record_rebalance.rs`'s own
/// disclosure style): there is no on-chain price oracle, so this
/// instruction cannot itself verify that a given leg genuinely moves the
/// Reserve toward its `target_weight_bps` -- that's a USD-value judgment
/// made off-chain by whoever plans the trade, not something raw token-unit
/// vault balances alone can prove on-chain. The only on-chain protections
/// are: (a) the `EXECUTE_REBALANCE` permission gate (the same trust model
/// already accepted for `record_rebalance`'s caller-supplied attestation),
/// (b) the AMM's own `minimum_amount_out` slippage check (execution
/// quality, not decision correctness), and (c) a coarse circuit-breaker
/// bounding `amount_in` to at most half the sell asset's current vault
/// balance per call (blast-radius limiting, not weight-correctness proof).
///
/// Coexists with `record_rebalance` -- does NOT replace it. `record_rebalance`
/// remains available for any future non-AMM-routed manual rebalance. A
/// client should NOT call `record_rebalance` after an AMM-routed leg: this
/// instruction's own `RebalanceLegExecuted` event is already intrinsically
/// trustworthy (every field derived from a real CPI'd balance change, not
/// caller-supplied input), so wrapping it in `record_rebalance`'s
/// attestation would be redundant and could misleadingly imply the
/// underlying claim was otherwise unverified.
#[derive(Accounts)]
pub struct ExecuteRebalanceLeg<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,

    // --- Sell leg: this Reserve's own registered asset being reduced ---
    #[account(
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), mint_sell.key().as_ref()],
        bump,
        constraint = reserve_asset_sell.reserve == reserve.key() @ SsrError::ReserveAssetMismatch,
    )]
    pub reserve_asset_sell: Account<'info, ReserveAsset>,

    #[account(
        mut,
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), mint_sell.key().as_ref()],
        bump,
        address = reserve_asset_sell.vault @ SsrError::InvalidReserveVault,
    )]
    pub reserve_vault_sell: InterfaceAccount<'info, TokenAccount>,

    pub mint_sell: InterfaceAccount<'info, Mint>,

    // --- Buy leg: this Reserve's own registered asset being increased ---
    #[account(
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), mint_buy.key().as_ref()],
        bump,
        constraint = reserve_asset_buy.reserve == reserve.key() @ SsrError::ReserveAssetMismatch,
    )]
    pub reserve_asset_buy: Account<'info, ReserveAsset>,

    #[account(
        mut,
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), mint_buy.key().as_ref()],
        bump,
        address = reserve_asset_buy.vault @ SsrError::InvalidReserveVault,
    )]
    pub reserve_vault_buy: InterfaceAccount<'info, TokenAccount>,

    pub mint_buy: InterfaceAccount<'info, Mint>,

    /// CHECK: this Reserve's own vault-authority PDA, verified purely by
    /// seeds against the cached bump -- becomes the CPI's signing "trader"
    /// below via `CpiContext::new_with_signer`, reusing the identical seeds
    /// `redeem_reserve_tokens_in_kind` already uses.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    // --- ssr_devnet_amm CPI target -- see DEC-0051 and this pass's DECISION_LOG entry ---
    pub amm_program: Program<'info, SsrDevnetAmm>,
    pub amm_config: Account<'info, AmmConfig>,
    #[account(mut)]
    pub amm_pool: Account<'info, AmmPool>,
    #[account(mut)]
    pub amm_vault_a: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub amm_vault_b: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: ssr_devnet_amm's OWN vault-authority PDA (derived under ITS
    /// program ID, not ours) -- validated by that program's own `Swap`
    /// account constraints when the CPI executes, and signed internally by
    /// that program itself; this program never signs for it.
    pub amm_vault_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<ExecuteRebalanceLeg>, amount_in: u64, minimum_amount_out: u64) -> Result<()> {
    ctx.accounts.reserve.require_not_paused()?;
    require!(amount_in > 0, SsrError::ZeroValue);

    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::EXECUTE_REBALANCE,
        ctx.program_id,
    )?;

    let mint_sell = ctx.accounts.mint_sell.key();
    let mint_buy = ctx.accounts.mint_buy.key();
    require!(mint_sell != mint_buy, SsrError::RebalanceLegSameAsset);

    // Determine the AMM's a_to_b direction from which of {mint_sell, mint_buy}
    // is the pool's mint_a (the hub asset, devUSDC) -- rather than trusting a
    // separately-supplied boolean argument that could disagree with the
    // actual mint accounts passed in.
    let pool_mint_a = ctx.accounts.amm_pool.mint_a;
    let pool_mint_b = ctx.accounts.amm_pool.mint_b;
    let a_to_b = if mint_sell == pool_mint_a && mint_buy == pool_mint_b {
        true
    } else if mint_sell == pool_mint_b && mint_buy == pool_mint_a {
        false
    } else {
        return Err(error!(SsrError::ReserveAssetMismatch));
    };

    // Coarse circuit-breaker: never move more than half the sell asset's
    // current real vault balance in a single call (see module doc comment --
    // blast-radius limiting, not a claim of weight-correctness).
    let sell_vault_balance = ctx.accounts.reserve_vault_sell.amount;
    require!(
        amount_in <= sell_vault_balance / 2,
        SsrError::RebalanceLegExceedsCircuitBreaker
    );

    let buy_vault_balance_before = ctx.accounts.reserve_vault_buy.amount;

    let vault_authority_bump = ctx.accounts.reserve.vault_authority_bump;
    let vault_authority_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[vault_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[vault_authority_seeds];

    // This Reserve's own registered-asset vaults are passed DIRECTLY as the
    // AMM's trader_token_a/trader_token_b -- both are already owned by
    // `vault_authority` (see initialize_reserve_asset.rs's vault
    // token::authority), which is exactly who signs this CPI below, so no
    // intermediate transfer is needed.
    let (mint_a_info, mint_b_info, trader_token_a, trader_token_b) = if a_to_b {
        (
            ctx.accounts.mint_sell.to_account_info(),
            ctx.accounts.mint_buy.to_account_info(),
            ctx.accounts.reserve_vault_sell.to_account_info(),
            ctx.accounts.reserve_vault_buy.to_account_info(),
        )
    } else {
        (
            ctx.accounts.mint_buy.to_account_info(),
            ctx.accounts.mint_sell.to_account_info(),
            ctx.accounts.reserve_vault_buy.to_account_info(),
            ctx.accounts.reserve_vault_sell.to_account_info(),
        )
    };

    let cpi_accounts = AmmSwapAccounts {
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool: ctx.accounts.amm_pool.to_account_info(),
        mint_a: mint_a_info,
        mint_b: mint_b_info,
        vault_a: ctx.accounts.amm_vault_a.to_account_info(),
        vault_b: ctx.accounts.amm_vault_b.to_account_info(),
        vault_authority: ctx.accounts.amm_vault_authority.to_account_info(),
        trader_token_a,
        trader_token_b,
        trader: ctx.accounts.vault_authority.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.amm_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    amm_swap_cpi(cpi_ctx, amount_in, minimum_amount_out, a_to_b)?;

    // Re-derive amount_out from a REAL post-CPI balance reload -- never
    // trust a pre-computed/caller-supplied value for the emitted event.
    ctx.accounts.reserve_vault_buy.reload()?;
    let buy_vault_balance_after = ctx.accounts.reserve_vault_buy.amount;
    let amount_out = buy_vault_balance_after
        .checked_sub(buy_vault_balance_before)
        .ok_or(error!(SsrError::MathUnderflow))?;

    emit!(RebalanceLegExecuted {
        reserve: reserve_key,
        mint_sell,
        mint_buy,
        amount_in,
        amount_out,
        executed_by: ctx.accounts.signer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
