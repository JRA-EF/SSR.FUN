use anchor_lang::prelude::*;
use anchor_spl::token::Mint as SplMint;

use super::common::credit_manager_fee_shares;
use crate::constants::{
    BPS_DENOMINATOR, MANAGER_FEE_RECIPIENTS_SEED, PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS, RESERVE_SEED,
    RESERVE_TOKEN_MINT_SEED, SECONDS_PER_DAY,
};
use crate::errors::SsrError;
use crate::events::{FeesAccrued, ManagerFeeAccrualSource};
use crate::fee_math::{split_configured_bps, split_total_fee};
use crate::state::{ManagerFeeRecipients, Reserve};

/// Permissionless, matching the reference protocol's own `distributeFees`
/// being callable by anyone (RESERVE_REFERENCE_ANALYSIS.md section 8) --
/// accrual is pure accounting, it never moves a token, so there is no
/// reason to gate who can trigger the checkpoint.
///
/// SIMPLIFICATION FROM THE REFERENCE PROTOCOL: this uses simple (linear)
/// interest over elapsed whole days, not Folio's true exponential
/// compounding (`supply * D18/(D18-fee)^elapsed - supply`, which needs a
/// fixed-point `pow`/`ln` implementation). Given fee VALUES are already
/// documented as provisional placeholders (DEC-0013) and this workspace has
/// no working toolchain to verify a fixed-point math dependency against,
/// linear accrual is deterministic, simple to audit, and close enough at
/// the fee magnitudes involved (single-digit % APY) for a first DevNet
/// release -- revisit before Mainnet if exact compounding parity matters.
///
/// DEC-0094: this is now ALSO called internally (via [`checkpoint_tvl_fee`])
/// from `mint_reserve_tokens_in_kind` and `redeem_reserve_tokens_in_kind`, so
/// a normal mint/redeem checkpoints the TVL fee for free in the same
/// transaction ("settle during normal Reserve transactions" -- see the
/// task's cadence requirement). This standalone instruction remains the
/// permissionless fallback for a dormant Reserve -- see
/// `api/devnet/accrue-fees-cron.ts`'s weekly keeper, which guarantees this
/// runs at least every ~25-30 days even with zero organic activity.
#[derive(Accounts)]
pub struct AccrueFees<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
    )]
    pub reserve_token_mint: Account<'info, SplMint>,

    /// Optional (DEC-0094): pass the program ID itself as a "None" sentinel
    /// for a Reserve that hasn't opted into multi-recipient routing. See
    /// `state/manager_fee_recipients.rs` and `common::credit_manager_fee_shares`.
    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,
}

pub fn handler<'info>(ctx: Context<'info, AccrueFees<'info>>) -> Result<()> {
    let supply = ctx.accounts.reserve_token_mint.supply;
    checkpoint_tvl_fee(
        &mut ctx.accounts.reserve,
        &mut ctx.accounts.manager_fee_recipients,
        supply,
    )
}

/// Core TVL-fee checkpoint, shared by the standalone `accrue_fees`
/// instruction and the mint/redeem piggyback call sites. A safe no-op if
/// less than one full day has elapsed since the last checkpoint -- callers
/// may invoke this as often as they like (e.g. every single mint/redeem)
/// with zero risk of double-charging.
pub fn checkpoint_tvl_fee<'info>(
    reserve: &mut Account<'info, Reserve>,
    manager_fee_recipients: &mut Option<Account<'info, ManagerFeeRecipients>>,
    reserve_token_mint_supply: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let elapsed_seconds = now
        .checked_sub(reserve.fee_config.last_fee_accrual_ts)
        .ok_or(error!(SsrError::MathUnderflow))?;
    let elapsed_days = elapsed_seconds / SECONDS_PER_DAY;

    if elapsed_days <= 0 {
        // No-op: nothing has crossed a full day boundary yet. Not an error --
        // callers (including every mint/redeem) may poke this frequently
        // without penalty.
        return Ok(());
    }

    let supply = reserve_token_mint_supply as u128;
    let configured_bps = reserve.fee_config.annual_tvl_fee_bps;
    let (protocol_bps, manager_bps) = split_configured_bps(configured_bps, PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS);
    let effective_total_bps = (protocol_bps as u128) + (manager_bps as u128);

    let numerator = supply
        .checked_mul(effective_total_bps)
        .ok_or(error!(SsrError::MathOverflow))?
        .checked_mul(elapsed_days as u128)
        .ok_or(error!(SsrError::MathOverflow))?;
    let denominator = (BPS_DENOMINATOR as u128) * 365u128;
    // Ceiling division -- fees round in the protocol's favor throughout
    // (DEC-0009 / RESERVE_REFERENCE_ANALYSIS.md section 14).
    let total_fee_shares_u128 = numerator
        .checked_add(denominator - 1)
        .ok_or(error!(SsrError::MathOverflow))?
        / denominator;
    let total_fee_shares =
        u64::try_from(total_fee_shares_u128).map_err(|_| error!(SsrError::MathOverflow))?;

    let (protocol_fee_shares, manager_fee_shares) =
        split_total_fee(total_fee_shares, protocol_bps, manager_bps)?;

    let accrued_until_ts = reserve
        .fee_config
        .last_fee_accrual_ts
        .checked_add(
            elapsed_days
                .checked_mul(SECONDS_PER_DAY)
                .ok_or(error!(SsrError::MathOverflow))?,
        )
        .ok_or(error!(SsrError::MathOverflow))?;

    reserve.fee_config.pending_protocol_fee_shares = reserve
        .fee_config
        .pending_protocol_fee_shares
        .checked_add(protocol_fee_shares)
        .ok_or(error!(SsrError::MathOverflow))?;
    reserve.fee_config.last_fee_accrual_ts = accrued_until_ts;

    credit_manager_fee_shares(
        reserve,
        manager_fee_recipients,
        manager_fee_shares,
        ManagerFeeAccrualSource::AnnualTvlFee,
    )?;

    emit!(FeesAccrued {
        reserve: reserve.key(),
        manager_fee_shares_accrued: manager_fee_shares,
        protocol_fee_shares_accrued: protocol_fee_shares,
        accrued_until_ts,
    });

    Ok(())
}
