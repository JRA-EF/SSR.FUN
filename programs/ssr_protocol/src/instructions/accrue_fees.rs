use anchor_lang::prelude::*;
use anchor_spl::token::Mint as SplMint;

use crate::constants::{BPS_DENOMINATOR, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED, SECONDS_PER_DAY};
use crate::errors::SsrError;
use crate::events::FeesAccrued;
use crate::state::Reserve;

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
}

pub fn handler<'info>(ctx: Context<'info, AccrueFees<'info>>) -> Result<()> {
    let reserve = &ctx.accounts.reserve;
    let now = Clock::get()?.unix_timestamp;
    let elapsed_seconds = now
        .checked_sub(reserve.fee_config.last_fee_accrual_ts)
        .ok_or(error!(SsrError::MathUnderflow))?;
    let elapsed_days = elapsed_seconds / SECONDS_PER_DAY;

    if elapsed_days <= 0 {
        // No-op: nothing has crossed a full day boundary yet. Not an error --
        // callers may poke this frequently without penalty.
        return Ok(());
    }

    let supply = ctx.accounts.reserve_token_mint.supply as u128;
    let numerator = supply
        .checked_mul(reserve.fee_config.annual_tvl_fee_bps as u128)
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

    let manager_fee_shares = ((total_fee_shares as u128)
        * (reserve.fee_config.manager_fee_share_bps as u128)
        / (BPS_DENOMINATOR as u128)) as u64;
    let protocol_fee_shares = ((total_fee_shares as u128)
        * (reserve.fee_config.protocol_fee_share_bps as u128)
        / (BPS_DENOMINATOR as u128)) as u64;

    let accrued_until_ts = reserve
        .fee_config
        .last_fee_accrual_ts
        .checked_add(
            elapsed_days
                .checked_mul(SECONDS_PER_DAY)
                .ok_or(error!(SsrError::MathOverflow))?,
        )
        .ok_or(error!(SsrError::MathOverflow))?;

    let reserve = &mut ctx.accounts.reserve;
    reserve.fee_config.pending_manager_fee_shares = reserve
        .fee_config
        .pending_manager_fee_shares
        .checked_add(manager_fee_shares)
        .ok_or(error!(SsrError::MathOverflow))?;
    reserve.fee_config.pending_protocol_fee_shares = reserve
        .fee_config
        .pending_protocol_fee_shares
        .checked_add(protocol_fee_shares)
        .ok_or(error!(SsrError::MathOverflow))?;
    reserve.fee_config.last_fee_accrual_ts = accrued_until_ts;

    emit!(FeesAccrued {
        reserve: reserve.key(),
        manager_fee_shares_accrued: manager_fee_shares,
        protocol_fee_shares_accrued: protocol_fee_shares,
        accrued_until_ts,
    });

    Ok(())
}
