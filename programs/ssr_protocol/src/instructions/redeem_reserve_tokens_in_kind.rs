use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use super::accrue_fees::checkpoint_tvl_accrual;
use super::common::{
    init_fee_settlement_if_needed, load_asset_legs, mul_div_ceil, mul_div_floor,
    transfer_out_of_vault,
};
use crate::constants::{
    BPS_DENOMINATOR, FEE_SETTLEMENT_SEED, FEE_VAULT_AUTHORITY_SEED, MANAGER_FEE_RECIPIENTS_SEED,
    MINT_AUTHORITY_SEED, PROTOCOL_MIN_MINT_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    TVL_ACCRUAL_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::{FeeVaultCredited, ManagerFeeAccrualSource, ReserveTokensRedeemed};
use crate::fee_math::{split_redemption_bps, split_total_fee};
use crate::state::{FeeSettlement, ManagerFeeRecipients, Reserve, TvlAccrual};

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

    #[account(mut)]
    pub redeemer: Signer<'info>,

    /// Optional (DEC-0094): pass the program ID itself as a "None" sentinel
    /// for a Reserve that hasn't opted into multi-recipient routing. Not
    /// actually used to credit anything on THIS instruction anymore (the
    /// TVL fee is only ever settled by `accrue_fees` now) but kept in the
    /// account list for forward-compatibility with an opportunistic
    /// same-transaction settlement bundle -- redemption fee itself is
    /// unrelated and untouched (still burned, never distributed).
    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

    /// Time-weighted average TVL accumulator (2026-08-14 pass) -- checkpointed
    /// here for free, never settled here. See
    /// `accrue_fees::checkpoint_tvl_accrual`'s doc comment.
    #[account(
        init_if_needed,
        payer = redeemer,
        space = TvlAccrual::SPACE,
        seeds = [TVL_ACCRUAL_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub tvl_accrual: Account<'info, TvlAccrual>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached
    /// bump -- DEC-0173: needed here for the first time, to mint the
    /// redemption fee's shares into the fee vault below.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// DEC-0173 (USDC on mint and redeem): the redemption fee's shares now
    /// crystallize into this Reserve's shared fee vault for USDC settlement
    /// (see `redeem_fee_vault_shares.rs`), replacing the old
    /// burn-for-holders mechanic. The redeemer fronts the one-time rent only
    /// on this Reserve's very first fee crystallization. Note this preserves
    /// DEC-0016's administrator-cannot-block-redemption guarantee: these are
    /// permissionless PDAs derived from the Reserve itself, requiring no
    /// admin-controlled account and no ProtocolConfig read.
    #[account(
        init_if_needed,
        payer = redeemer,
        space = FeeSettlement::SPACE,
        seeds = [FEE_SETTLEMENT_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub fee_settlement: Account<'info, FeeSettlement>,

    #[account(
        init_if_needed,
        payer = redeemer,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = fee_vault_authority,
    )]
    pub fee_vault: Account<'info, SplTokenAccount>,

    /// CHECK: signer-only PDA (only the fee vault's ATA *owner* -- the mint
    /// authority for the fee-share mint is `mint_authority` above), verified
    /// purely by seeds against the cached bump.
    #[account(
        seeds = [FEE_VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub fee_vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, redeemer_asset_token_account, mint, token_program]
    // in ReserveAsset.order_index order. See instructions/common.rs::load_asset_legs.
}

pub fn handler<'info>(
    ctx: Context<'info, RedeemReserveTokensInKind<'info>>,
    reserve_tokens_to_redeem: u64,
    min_asset_amounts_out: Vec<u64>,
) -> Result<()> {
    ctx.accounts.reserve.require_redemption_allowed()?;
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

    // 2026-08-14 pass: piggyback the TVL accumulator CHECKPOINT (never
    // settlement -- see accrue_fees::checkpoint_tvl_accrual's doc comment)
    // onto this redeem too, same as mint/seed. Unrelated to, and does not
    // affect, the redemption fee computed below.
    let reserve_key_for_tvl = ctx.accounts.reserve.key();
    checkpoint_tvl_accrual(
        &mut ctx.accounts.tvl_accrual,
        reserve_key_for_tvl,
        ctx.bumps.tvl_accrual,
        total_supply_before,
        Clock::get()?.unix_timestamp,
    )?;

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
    // The FULL `reserve_tokens_to_redeem` is burned while asset payout is
    // computed on the net (post-fee) portion -- and then, DEC-0173, the fee
    // portion is re-minted into the shared fee vault below (replacing the
    // old burn-for-holders mechanic, which left the fee's backing to the
    // remaining holders instead of ever paying the Protocol or Manager).
    // Net supply effect is identical to the old design; the fee's backing
    // assets stay in the vaults exactly as before, now claimable by the fee
    // vault's own later `redeem_fee_vault_shares` settlement instead of
    // accruing to holders.
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

    // DEC-0173: crystallize the redemption fee into the fee vault.
    // split_redemption_bps is attribution-only -- the charged total remains
    // exactly `redemption_fee_bps`, never raised by any floor (unlike the
    // mint fee's split_configured_bps).
    if redemption_fee_shares > 0 {
        let (protocol_bps, manager_bps) =
            split_redemption_bps(fee_config.redemption_fee_bps, PROTOCOL_MIN_MINT_FEE_BPS);
        let (protocol_fee_shares, manager_fee_shares) =
            split_total_fee(redemption_fee_shares, protocol_bps, manager_bps)?;

        let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
        let mint_authority_seeds: &[&[u8]] = &[
            MINT_AUTHORITY_SEED,
            reserve_key.as_ref(),
            &[mint_authority_bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];
        let vault_cpi_accounts = MintTo {
            mint: ctx.accounts.reserve_token_mint.to_account_info(),
            to: ctx.accounts.fee_vault.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let vault_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            vault_cpi_accounts,
            signer_seeds,
        );
        token::mint_to(vault_cpi_ctx, redemption_fee_shares)?;

        let fee_settlement = &mut ctx.accounts.fee_settlement;
        init_fee_settlement_if_needed(
            fee_settlement,
            reserve_key,
            ctx.bumps.fee_settlement,
            ctx.program_id,
        )?;
        fee_settlement.protocol_shares_in_vault = fee_settlement
            .protocol_shares_in_vault
            .checked_add(protocol_fee_shares)
            .ok_or(error!(SsrError::MathOverflow))?;
        fee_settlement.manager_shares_in_vault = fee_settlement
            .manager_shares_in_vault
            .checked_add(manager_fee_shares)
            .ok_or(error!(SsrError::MathOverflow))?;

        emit!(FeeVaultCredited {
            reserve: reserve_key,
            protocol_shares: protocol_fee_shares,
            manager_shares: manager_fee_shares,
            source: ManagerFeeAccrualSource::RedemptionFee,
            ts: Clock::get()?.unix_timestamp,
        });
    }

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
