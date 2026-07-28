use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint as SplMint, Token, TokenAccount as SplTokenAccount};

use super::common::{load_asset_legs, mul_div_ceil, mul_div_floor, transfer_out_of_vault};
use crate::constants::{
    BPS_DENOMINATOR, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveTokensRedeemed;
use crate::state::Reserve;

/// Deliberately does NOT accept a `ProtocolConfig` account: redemption is
/// exempt from both the Reserve-level pause AND the protocol-wide emergency
/// pause, per DEC-0016 (adapted from the reference protocol's `redeem`
/// lacking a `notDeprecated` modifier -- RESERVE_REFERENCE_ANALYSIS.md
/// section 12). No administrator action can ever block a holder's
/// redemption right.
#[derive(Accounts)]
pub struct RedeemReserveTokensInKind<'info> {
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
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = redeemer_reserve_token_account.mint == reserve.reserve_token_mint @ SsrError::ReserveAssetMismatch,
        constraint = redeemer_reserve_token_account.owner == redeemer.key() @ SsrError::NotReserveManager,
    )]
    pub redeemer_reserve_token_account: Account<'info, SplTokenAccount>,

    pub redeemer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, redeemer_asset_token_account, mint, token_program]
    // in ReserveAsset.order_index order. See instructions/common.rs::load_asset_legs.
}

pub fn handler<'info>(
    ctx: Context<'info, RedeemReserveTokensInKind<'info>>,
    reserve_tokens_to_redeem: u64,
    min_asset_amounts_out: Vec<u64>,
) -> Result<()> {
    ctx.accounts.reserve.require_active_or_paused()?;
    require!(reserve_tokens_to_redeem > 0, SsrError::ZeroValue);
    require_eq!(
        min_asset_amounts_out.len(),
        ctx.accounts.reserve.asset_count as usize,
        SsrError::RemainingAccountsMismatch
    );

    let total_supply_before = ctx.accounts.reserve_token_mint.supply;
    require!(total_supply_before > 0, SsrError::ZeroSupply);
    require!(
        reserve_tokens_to_redeem <= ctx.accounts.redeemer_reserve_token_account.amount,
        SsrError::RedemptionExceedsEntitlement
    );

    let fee_config = ctx.accounts.reserve.fee_config;
    let redemption_fee_shares = mul_div_ceil(
        reserve_tokens_to_redeem,
        fee_config.redemption_fee_bps as u64,
        BPS_DENOMINATOR as u64,
    )?;
    let net_shares_for_entitlement = reserve_tokens_to_redeem
        .checked_sub(redemption_fee_shares)
        .ok_or(error!(SsrError::MathUnderflow))?;
    require!(
        net_shares_for_entitlement > 0,
        SsrError::ZeroAmountAfterFeesOrRounding
    );

    let reserve_key = ctx.accounts.reserve.key();
    let legs = load_asset_legs(
        &ctx.accounts.reserve,
        &reserve_key,
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    // Entitlement computed on PRE-burn supply/balances, matching the
    // reference protocol's ordering (RESERVE_REFERENCE_ANALYSIS.md section
    // 5): `_toAssets` reads `totalSupply()` before `_burn` executes.
    let mut entitlements = Vec::with_capacity(legs.len());
    for (i, leg) in legs.iter().enumerate() {
        let vault_balance_before = leg.vault.amount;
        let entitlement = mul_div_floor(
            net_shares_for_entitlement,
            vault_balance_before,
            total_supply_before,
        )?;
        require!(
            entitlement >= min_asset_amounts_out[i],
            SsrError::SlippageMinOutputNotMet
        );
        entitlements.push(entitlement);
    }

    // Burn-then-transfer ordering (RESERVE_REFERENCE_ANALYSIS.md section 5).
    // Note the FULL `reserve_tokens_to_redeem` is burned even though asset
    // payout is computed on the net (post-fee) portion -- the fee portion's
    // backing assets are deliberately left in the vaults, permanently
    // increasing the per-share backing for all remaining holders. This is
    // the redemption-side analogue of the reference protocol's
    // `folioFeeForSelf` burn-instead-of-distribute mechanic, and avoids
    // needing a separate fee-recipient mint on every redemption.
    let cpi_accounts = Burn {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        from: ctx
            .accounts
            .redeemer_reserve_token_account
            .to_account_info(),
        authority: ctx.accounts.redeemer.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token::burn(cpi_ctx, reserve_tokens_to_redeem)?;

    let vault_authority_bump = ctx.accounts.reserve.vault_authority_bump;
    let vault_authority_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[vault_authority_bump],
    ];
    let vault_authority_ai = ctx.accounts.vault_authority.to_account_info();

    let mut asset_mints = Vec::with_capacity(legs.len());
    for (leg, &amount) in legs.iter().zip(entitlements.iter()) {
        transfer_out_of_vault(leg, &vault_authority_ai, vault_authority_seeds, amount)?;
        asset_mints.push(leg.mint.key());
    }

    emit!(ReserveTokensRedeemed {
        reserve: reserve_key,
        redeemer: ctx.accounts.redeemer.key(),
        reserve_tokens_burned: reserve_tokens_to_redeem,
        redemption_fee_reserve_tokens: redemption_fee_shares,
        asset_mints,
        asset_amounts_out: entitlements,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
