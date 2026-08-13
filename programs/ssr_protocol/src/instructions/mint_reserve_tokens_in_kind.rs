use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use super::accrue_fees::checkpoint_tvl_fee;
use super::common::{credit_manager_fee_shares, load_asset_legs, mul_div_ceil, transfer_into_vault};
use crate::constants::{
    BPS_DENOMINATOR, MANAGER_FEE_RECIPIENTS_SEED, MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED,
    PROTOCOL_MIN_MINT_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
};
use crate::errors::SsrError;
use crate::events::{ManagerFeeAccrualSource, ReserveTokensMinted};
use crate::fee_math::{split_configured_bps, split_total_fee};
use crate::state::{ManagerFeeRecipients, ProtocolConfig, Reserve, ReserveStatus};

#[derive(Accounts)]
pub struct MintReserveTokensInKind<'info> {
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
        payer = depositor,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = depositor,
    )]
    pub depositor_reserve_token_account: Account<'info, SplTokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Optional (DEC-0094): pass the program ID itself as a "None" sentinel
    /// for a Reserve that hasn't opted into multi-recipient routing. See
    /// `state/manager_fee_recipients.rs` and `common::credit_manager_fee_shares`.
    /// Also used to credit the TVL-fee piggyback checkpoint this call
    /// triggers (see `accrue_fees::checkpoint_tvl_fee`).
    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, depositor_asset_token_account, mint, token_program]
    // in ReserveAsset.order_index order. See instructions/common.rs::load_asset_legs.
}

pub fn handler<'info>(
    ctx: Context<'info, MintReserveTokensInKind<'info>>,
    reserve_tokens_requested: u64,
    min_reserve_tokens_out: u64,
    max_asset_amounts: Vec<u64>,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.paused,
        SsrError::ProtocolPaused
    );
    require!(
        ctx.accounts.reserve.status == ReserveStatus::Active,
        SsrError::UnexpectedReserveStatus
    );
    require!(reserve_tokens_requested > 0, SsrError::ZeroValue);
    require_eq!(
        max_asset_amounts.len(),
        ctx.accounts.reserve.asset_count as usize,
        SsrError::RemainingAccountsMismatch
    );

    // Snapshot supply/balances BEFORE any transfer -- the entire mint
    // requirement is computed on the pre-transaction ratio, matching the
    // reference protocol's `_toAssets(shares, Ceil)` (RESERVE_REFERENCE_ANALYSIS.md
    // section 4/14).
    let total_supply_before = ctx.accounts.reserve_token_mint.supply;
    require!(total_supply_before > 0, SsrError::ZeroSupply);

    // DEC-0094: piggyback the TVL-fee checkpoint onto this mint, on the
    // pre-mint supply -- "settle during normal Reserve transactions" so an
    // active Reserve accrues TVL fees for free, with no separate
    // `accrue_fees` transaction needed. Safe no-op if <1 day has elapsed.
    checkpoint_tvl_fee(
        &mut ctx.accounts.reserve,
        &mut ctx.accounts.manager_fee_recipients,
        total_supply_before,
    )?;

    let reserve_key = ctx.accounts.reserve.key();
    let legs = load_asset_legs(
        &ctx.accounts.reserve,
        &reserve_key,
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    let mut asset_mints = Vec::with_capacity(legs.len());
    let mut asset_amounts_in = Vec::with_capacity(legs.len());

    for (i, leg) in legs.iter().enumerate() {
        let vault_balance_before = leg.vault.amount;
        let required_amount = mul_div_ceil(
            reserve_tokens_requested,
            vault_balance_before,
            total_supply_before,
        )?;
        require!(
            required_amount <= max_asset_amounts[i],
            SsrError::SlippageMaxInputExceeded
        );

        transfer_into_vault(
            leg,
            &ctx.accounts.depositor.to_account_info(),
            required_amount,
        )?;

        asset_mints.push(leg.mint.key());
        asset_amounts_in.push(required_amount);
    }

    // DEC-0094: `mint_fee_bps` is the configured (manager-set) gross rate;
    // the EFFECTIVE total actually charged is derived fresh here via the
    // SSR.fun fee formula, and can exceed `mint_fee_bps` when it's below
    // the Protocol's 0.5% floor -- see fee_math::split_configured_bps.
    let configured_mint_fee_bps = ctx.accounts.reserve.fee_config.mint_fee_bps;
    let (protocol_bps, manager_bps) =
        split_configured_bps(configured_mint_fee_bps, PROTOCOL_MIN_MINT_FEE_BPS);
    let effective_total_bps = (protocol_bps as u64)
        .checked_add(manager_bps as u64)
        .ok_or(error!(SsrError::MathOverflow))?;
    let mint_fee_shares = mul_div_ceil(
        reserve_tokens_requested,
        effective_total_bps,
        BPS_DENOMINATOR as u64,
    )?;
    let net_shares_out = reserve_tokens_requested
        .checked_sub(mint_fee_shares)
        .ok_or(error!(SsrError::MathUnderflow))?;
    require!(net_shares_out > 0, SsrError::ZeroAmountAfterFeesOrRounding);
    require!(
        net_shares_out >= min_reserve_tokens_out,
        SsrError::SlippageMinOutputNotMet
    );

    // protocol_fee_shares floor+exact-remainder split from manager_fee_shares
    // (DEC-0094: divides by effective_total_bps, NOT BPS_DENOMINATOR -- see
    // fee_math::split_total_fee's doc comment for why the pre-DEC-0094
    // divisor would be wrong here). manager_fee_shares is then apportioned
    // across up to MAX_FEE_RECIPIENTS recipients (or credited to the legacy
    // aggregate) by credit_manager_fee_shares -- the full chain
    // `protocol_fee_shares + sum(recipient credits) == mint_fee_shares`
    // holds exactly at every step.
    let (protocol_fee_shares, manager_fee_shares) =
        split_total_fee(mint_fee_shares, protocol_bps, manager_bps)?;

    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    {
        let reserve = &mut ctx.accounts.reserve;
        reserve.fee_config.pending_protocol_fee_shares = reserve
            .fee_config
            .pending_protocol_fee_shares
            .checked_add(protocol_fee_shares)
            .ok_or(error!(SsrError::MathOverflow))?;
        // Informational telemetry only (DEC-0094) -- see the doc comment on
        // these two fields in state/reserve.rs. Reflects the mint fee's
        // effective split specifically (not the TVL fee's, which can
        // differ); never read for control flow.
        reserve.fee_config.manager_fee_share_bps = manager_bps;
        reserve.fee_config.protocol_fee_share_bps = protocol_bps;
    }
    credit_manager_fee_shares(
        &mut ctx.accounts.reserve,
        &mut ctx.accounts.manager_fee_recipients,
        manager_fee_shares,
        ManagerFeeAccrualSource::MintFee,
    )?;

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
            .depositor_reserve_token_account
            .to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
    token::mint_to(cpi_ctx, net_shares_out)?;

    emit!(ReserveTokensMinted {
        reserve: reserve_key,
        depositor: ctx.accounts.depositor.key(),
        reserve_tokens_out: net_shares_out,
        mint_fee_reserve_tokens: mint_fee_shares,
        asset_mints,
        asset_amounts_in,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
