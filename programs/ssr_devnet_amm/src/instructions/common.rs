//! Shared math + validation helpers. `mul_div_floor` mirrors
//! `ssr_protocol`'s own helper of the same name (rounding down, in the
//! pool's favor) -- duplicated here rather than shared via a library crate
//! since it's ~10 lines and this program is deliberately independent of
//! `ssr_protocol` (see DEC-0051: zero shared code/accounts/CPI is part of
//! the isolation guarantee, not just an implementation convenience).

use anchor_lang::prelude::*;

use crate::errors::AmmError;

/// Floor-division `a * b / c`, widened to u128 to avoid overflow.
pub fn mul_div_floor(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c != 0, AmmError::DivisionByZero);
    let product = (a as u128)
        .checked_mul(b as u128)
        .ok_or(error!(AmmError::MathOverflow))?;
    let result = product / (c as u128);
    u64::try_from(result).map_err(|_| error!(AmmError::MathOverflow))
}

/// Constant-product swap quote: given reserves and a (post-fee) amount in,
/// returns the amount out. `amount_out = reserve_out - (reserve_in *
/// reserve_out) / (reserve_in + amount_in_after_fee)`, computed via u128 to
/// avoid overflow and rounded down (protocol/pool-favor), matching
/// ssr_protocol's rounding-direction policy.
pub fn constant_product_amount_out(
    reserve_in: u64,
    reserve_out: u64,
    amount_in_after_fee: u64,
) -> Result<u64> {
    let reserve_in = reserve_in as u128;
    let reserve_out = reserve_out as u128;
    let amount_in_after_fee = amount_in_after_fee as u128;

    let k = reserve_in
        .checked_mul(reserve_out)
        .ok_or(error!(AmmError::MathOverflow))?;
    let new_reserve_in = reserve_in
        .checked_add(amount_in_after_fee)
        .ok_or(error!(AmmError::MathOverflow))?;
    require!(new_reserve_in != 0, AmmError::DivisionByZero);
    let new_reserve_out = k / new_reserve_in;
    let amount_out = reserve_out
        .checked_sub(new_reserve_out)
        .ok_or(error!(AmmError::MathOverflow))?;

    u64::try_from(amount_out).map_err(|_| error!(AmmError::MathOverflow))
}
