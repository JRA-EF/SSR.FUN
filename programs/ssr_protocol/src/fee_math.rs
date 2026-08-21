//! SSR.fun Protocol/Manager fee-split math (DEC-0094). Shared by
//! `mint_reserve_tokens_in_kind.rs` and `accrue_fees.rs` -- both apply this
//! same three-step chain independently to the Mint fee and the Annualized
//! TVL fee:
//!
//! 1. [`split_configured_bps`] -- derive `(protocol_bps, manager_bps)` from
//!    the Reserve's configured fee rate and the Protocol's minimum.
//!    Whenever a manager configures a NONZERO fee, the Protocol's share is
//!    floored at `protocol_min_bps` (`protocol_bps + manager_bps` can then
//!    exceed `configured_bps` when it's below the floor). A manager who
//!    genuinely configures 0% pays no floor at all -- `configured_bps == 0`
//!    always yields `(0, 0)`, a real zero-fee mint/TVL-accrual. There is no
//!    forced minimum fee; the floor only governs how a NONZERO fee splits.
//! 2. [`split_total_fee`] -- given the total fee shares already computed
//!    from the effective total bps, split into `(protocol_total,
//!    manager_total)` via floor+exact-remainder (protocol-favored rounding,
//!    matching this program's existing convention).
//! 3. [`apportion_to_recipients`] -- split `manager_total` across up to
//!    `MAX_FEE_RECIPIENTS` recipients via largest-remainder (Hamilton)
//!    apportionment.
//!
//! Every step is exact-integer, no floats, and the whole chain guarantees
//! `protocol_total + sum(recipient increments) == total_fee_shares` always.
//! A TypeScript mirror of all three functions lives in
//! `packages/sdk/src/feeMath.ts` -- keep both in exact sync.

use anchor_lang::prelude::*;

use crate::constants::MAX_FEE_RECIPIENTS;
use crate::errors::SsrError;
use crate::instructions::common::mul_div_floor;
use crate::state::FeeRecipientSlot;

/// `protocol_bps = max(protocol_min_bps, configured_bps / 2)`
/// `manager_bps  = max(configured_bps - protocol_bps, 0)`
///
/// Floor division for the "50% of configured" half: matches every example
/// in the task's own table exactly (all even bps values), and for an odd
/// `configured_bps` simply leaves the extra basis point with the Manager
/// rather than the Protocol -- an arbitrary but deterministic tie-break,
/// not a rounding bug (`protocol_bps` is always still >= `protocol_min_bps`).
pub fn split_configured_bps(configured_bps: u16, protocol_min_bps: u16) -> (u16, u16) {
    if configured_bps == 0 {
        return (0, 0);
    }
    let half = configured_bps / 2;
    let protocol_bps = protocol_min_bps.max(half);
    let manager_bps = configured_bps.saturating_sub(protocol_bps);
    (protocol_bps, manager_bps)
}

/// Splits `total_fee_shares` into `(protocol_total, manager_total)` given
/// the effective `(protocol_bps, manager_bps)` from [`split_configured_bps`].
/// Divides by `protocol_bps + manager_bps` (the EFFECTIVE total bps that
/// `total_fee_shares` was itself computed from), not `BPS_DENOMINATOR` --
/// unlike the pre-DEC-0094 scheme, `protocol_bps + manager_bps` generally
/// does not equal 10,000. `manager_total` is floor-rounded; `protocol_total`
/// is the exact remainder, so the two always sum to `total_fee_shares`
/// exactly, with zero rounding dust ever silently unallocated.
///
/// `effective_total_bps` (`protocol_bps + manager_bps`) is zero exactly when
/// `configured_bps` was genuinely 0 (see `split_configured_bps`'s zero-fee
/// case) -- handled explicitly below (both shares 0, no division at all)
/// rather than relying on `mul_div_floor`'s zero-divisor guard, since that
/// guard would otherwise turn a legitimate 0%-fee mint/accrual into a
/// spurious `DivisionByZero` failure.
pub fn split_total_fee(
    total_fee_shares: u64,
    protocol_bps: u16,
    manager_bps: u16,
) -> Result<(u64, u64)> {
    let effective_total_bps = (protocol_bps as u64)
        .checked_add(manager_bps as u64)
        .ok_or(error!(SsrError::MathOverflow))?;
    if effective_total_bps == 0 {
        return Ok((0, 0));
    }
    let manager_total = mul_div_floor(total_fee_shares, manager_bps as u64, effective_total_bps)?;
    let protocol_total = total_fee_shares
        .checked_sub(manager_total)
        .ok_or(error!(SsrError::MathUnderflow))?;
    Ok((protocol_total, manager_total))
}

/// Splits `manager_total` across the active (`< recipient_count`) slots of
/// `recipients` via largest-remainder (Hamilton) apportionment: each
/// recipient's exact share is `manager_total * allocation_bps / 10_000`;
/// every active recipient gets `floor` of that, and the leftover raw units
/// (`manager_total - sum(floors)`, always `< recipient_count` since
/// `sum(allocation_bps) == 10_000` exactly) go one-by-one to the recipients
/// with the largest fractional remainder, ties broken by lowest slot index
/// for determinism. Exact: `sum(returned increments) == manager_total`
/// always. Returns a full `MAX_FEE_RECIPIENTS`-length array; inactive slots
/// (index `>= recipient_count`) are always 0.
pub fn apportion_to_recipients(
    manager_total: u64,
    recipients: &[FeeRecipientSlot; MAX_FEE_RECIPIENTS as usize],
    recipient_count: u8,
) -> Result<[u64; MAX_FEE_RECIPIENTS as usize]> {
    let count = recipient_count as usize;
    let mut increments = [0u64; MAX_FEE_RECIPIENTS as usize];
    let mut remainders = [0u128; MAX_FEE_RECIPIENTS as usize];

    let mut sum_floor: u64 = 0;
    for i in 0..count {
        let numerator = (manager_total as u128)
            .checked_mul(recipients[i].allocation_bps as u128)
            .ok_or(error!(SsrError::MathOverflow))?;
        let floor_share = u64::try_from(numerator / 10_000u128)
            .map_err(|_| error!(SsrError::MathOverflow))?;
        increments[i] = floor_share;
        remainders[i] = numerator % 10_000u128;
        sum_floor = sum_floor
            .checked_add(floor_share)
            .ok_or(error!(SsrError::MathOverflow))?;
    }

    let leftover = manager_total
        .checked_sub(sum_floor)
        .ok_or(error!(SsrError::MathUnderflow))?;

    // Rank active slots by remainder descending, index ascending on ties --
    // O(count^2) selection is trivial at count <= MAX_FEE_RECIPIENTS (10).
    let mut order: Vec<usize> = (0..count).collect();
    order.sort_by(|&a, &b| remainders[b].cmp(&remainders[a]).then(a.cmp(&b)));

    for &i in order.iter().take(leftover as usize) {
        increments[i] = increments[i]
            .checked_add(1)
            .ok_or(error!(SsrError::MathOverflow))?;
    }

    Ok(increments)
}

/// USDC fee-settlement pipeline (2026-08-21 pass): splits `amount` between
/// Protocol and Manager proportionally to their CURRENT weights -- e.g.
/// `FeeSettlement.protocol_shares_in_vault` vs `manager_shares_in_vault` at
/// redemption time, or `protocol_shares_pending_settlement` vs
/// `manager_shares_pending_settlement` at USDC-distribution time. Same
/// floor+exact-remainder pattern as [`split_total_fee`] above (Manager
/// floor-rounded, Protocol gets the exact remainder -- protocol-favored,
/// matching this program's existing convention throughout), generalized to
/// arbitrary `u64` weights instead of a fixed bps denominator: the fee
/// vault's real split ratio isn't a configured bps value, it's whatever the
/// vault's/pending-settlement's actual current composition happens to be.
/// Returns `(0, 0)` when both weights are zero (nothing to split -- an empty
/// vault or a distribution with nothing pending) rather than a division
/// error. Exact: `protocol_share + manager_share == amount` always.
pub fn split_by_weight(amount: u64, protocol_weight: u64, manager_weight: u64) -> Result<(u64, u64)> {
    let total_weight = protocol_weight
        .checked_add(manager_weight)
        .ok_or(error!(SsrError::MathOverflow))?;
    if total_weight == 0 {
        return Ok((0, 0));
    }
    let manager_share = mul_div_floor(amount, manager_weight, total_weight)?;
    let protocol_share = amount
        .checked_sub(manager_share)
        .ok_or(error!(SsrError::MathUnderflow))?;
    Ok((protocol_share, manager_share))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(allocation_bps: u16) -> FeeRecipientSlot {
        FeeRecipientSlot {
            wallet: Pubkey::new_unique(),
            allocation_bps,
            pending_fee_shares: 0,
            collected_fee_shares: 0,
        }
    }

    fn recipients_array(bps: &[u16]) -> ([FeeRecipientSlot; MAX_FEE_RECIPIENTS as usize], u8) {
        let mut arr: [FeeRecipientSlot; MAX_FEE_RECIPIENTS as usize] = Default::default();
        for (i, &b) in bps.iter().enumerate() {
            arr[i] = slot(b);
        }
        (arr, bps.len() as u8)
    }

    #[test]
    fn table_from_task_mint_and_tvl() {
        // (configured_bps, expected_protocol_bps, expected_manager_bps). A
        // genuine 0% configuration yields a genuine 0% effective fee -- no
        // forced minimum -- while any NONZERO configuration still floors
        // the Protocol's share at 50bps (0.5%).
        let cases = [(0u16, 0u16, 0u16), (50, 50, 0), (100, 50, 50), (200, 100, 100), (500, 250, 250)];
        for (configured, expected_protocol, expected_manager) in cases {
            let (protocol_bps, manager_bps) = split_configured_bps(configured, 50);
            assert_eq!(protocol_bps, expected_protocol, "configured={configured}");
            assert_eq!(manager_bps, expected_manager, "configured={configured}");
            assert!(protocol_bps as u32 + manager_bps as u32 >= configured as u32);
        }
    }

    #[test]
    fn split_total_fee_is_exact_and_protocol_favored() {
        let (protocol_bps, manager_bps) = split_configured_bps(500, 50); // 250/250
        let (protocol_total, manager_total) = split_total_fee(985_341, protocol_bps, manager_bps).unwrap();
        assert_eq!(protocol_total + manager_total, 985_341);
        // Odd total split 50/50: manager floor-rounded, protocol gets the remainder.
        assert_eq!(manager_total, 492_670);
        assert_eq!(protocol_total, 492_671);
    }

    #[test]
    fn apportion_single_recipient_gets_everything() {
        let (recipients, count) = recipients_array(&[10_000]);
        let increments = apportion_to_recipients(777_777, &recipients, count).unwrap();
        assert_eq!(increments[0], 777_777);
        assert_eq!(increments[1..].iter().sum::<u64>(), 0);
    }

    #[test]
    fn apportion_ten_recipients_exact_sum_and_no_negative() {
        let bps = [1_000u16; 10]; // 10 x 10% = 10,000
        let (recipients, count) = recipients_array(&bps);
        let increments = apportion_to_recipients(1_000_003, &recipients, count).unwrap();
        assert_eq!(increments.iter().sum::<u64>(), 1_000_003);
        // 1,000,003 / 10 = 100,000 remainder 3 -- exactly 3 recipients get +1.
        let plus_one_count = increments.iter().filter(|&&x| x == 100_001).count();
        assert_eq!(plus_one_count, 3);
    }

    #[test]
    fn apportion_sweep_always_exact() {
        for recipient_count in 1u8..=10 {
            // Evenly-as-possible split summing to exactly 10,000.
            let base = 10_000u16 / recipient_count as u16;
            let mut bps: Vec<u16> = vec![base; recipient_count as usize];
            let short = 10_000u16 - bps.iter().sum::<u16>();
            bps[0] += short;
            let (recipients, count) = recipients_array(&bps);
            for total in [0u64, 1, 7, 100, 999, 1_000_000, 123_456_789] {
                let increments = apportion_to_recipients(total, &recipients, count).unwrap();
                assert_eq!(increments.iter().sum::<u64>(), total);
            }
        }
    }

    #[test]
    fn full_chain_exact_end_to_end() {
        use crate::instructions::common::mul_div_ceil;
        let bps = [6_000u16, 4_000u16];
        let (recipients, count) = recipients_array(&bps);
        for configured in [0u16, 50, 100, 200, 500] {
            let (protocol_bps, manager_bps) = split_configured_bps(configured, 50);
            let effective_total_bps = (protocol_bps + manager_bps) as u64;
            for reserve_tokens_requested in [1u64, 3, 1_000, 987_654] {
                let total_fee_shares =
                    mul_div_ceil(reserve_tokens_requested, effective_total_bps, 10_000).unwrap();
                let (protocol_total, manager_total) =
                    split_total_fee(total_fee_shares, protocol_bps, manager_bps).unwrap();
                let increments = apportion_to_recipients(manager_total, &recipients, count).unwrap();
                assert_eq!(
                    protocol_total + increments.iter().sum::<u64>(),
                    total_fee_shares,
                    "configured={configured} requested={reserve_tokens_requested}"
                );
            }
        }
    }

    // --- USDC fee-settlement pipeline (2026-08-21 pass): split_by_weight ---

    #[test]
    fn split_by_weight_is_exact_and_protocol_favored_on_odd_amounts() {
        let (protocol_share, manager_share) = split_by_weight(985_341, 250, 250).unwrap();
        assert_eq!(protocol_share + manager_share, 985_341);
        assert_eq!(manager_share, 492_670); // floor(985341 * 250/500)
        assert_eq!(protocol_share, 492_671); // exact remainder
    }

    #[test]
    fn split_by_weight_both_weights_zero_returns_zero_never_a_division_error() {
        assert_eq!(split_by_weight(1_000_000, 0, 0).unwrap(), (0, 0));
    }

    #[test]
    fn split_by_weight_all_protocol_weight_gives_protocol_everything() {
        assert_eq!(split_by_weight(777, 100, 0).unwrap(), (777, 0));
    }

    #[test]
    fn split_by_weight_all_manager_weight_gives_manager_everything() {
        assert_eq!(split_by_weight(777, 0, 100).unwrap(), (0, 777));
    }

    #[test]
    fn split_by_weight_zero_amount_splits_to_zero_regardless_of_weights() {
        assert_eq!(split_by_weight(0, 250, 750).unwrap(), (0, 0));
    }

    #[test]
    fn split_by_weight_sweep_always_exact() {
        for (pw, mw) in [(1u64, 1u64), (250, 750), (1, 999), (500_000, 1), (12_345, 67_890)] {
            for amount in [0u64, 1, 7, 100, 999, 1_000_000, 123_456_789] {
                let (p, m) = split_by_weight(amount, pw, mw).unwrap();
                assert_eq!(p + m, amount, "amount={amount} pw={pw} mw={mw}");
            }
        }
    }
}
