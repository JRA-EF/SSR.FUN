use anchor_lang::prelude::*;

/// Time-weighted average TVL accumulator (2026-08-14 pass, see
/// docs/project/DECISION_LOG.md) -- a Uniswap V2-style cumulative
/// accumulator, using Reserve Token SUPPLY as the TVL proxy (the deployed
/// protocol has no oracle; this mirrors the fee system's existing
/// convention of treating supply as the fee base). A separate, additive PDA
/// (NOT a field grown onto `Reserve`/`FeeConfig`) for the same reason as
/// `ManagerFeeRecipients` (DEC-0094): no already-initialized `Reserve`
/// account on live DevNet ever needs a realloc/migration. PDA:
/// `[TVL_ACCRUAL_SEED, reserve.key()]`.
///
/// The math: `period_supply_seconds` is `supply` integrated over elapsed
/// time (sum of `supply * elapsed_seconds` since `last_settled_ts`).
/// Settling divides it by the fee's `SECONDS_PER_YEAR` denominator directly
/// (`period_supply_seconds * annualized_bps / (BPS_DENOMINATOR *
/// SECONDS_PER_YEAR)`), which is algebraically identical to "time-weighted
/// average TVL during the period x annualized fee rate x elapsed seconds /
/// 31,536,000" -- the elapsed-seconds terms cancel, so no separate average
/// needs to be computed, and any elapsed period (a full week, a partial
/// week, or several overdue weeks at once) is billed exactly.
#[account]
pub struct TvlAccrual {
    pub schema_version: u8,
    pub reserve: Pubkey,
    /// Sum of `supply * elapsed_seconds` accumulated since `last_settled_ts`
    /// -- reset to 0 on every successful settlement.
    pub period_supply_seconds: u128,
    /// Timestamp this account's `period_supply_seconds` reflects reality up
    /// to. Advanced by every checkpoint (a mint/redeem/seed piggyback, or
    /// the settlement instruction itself bringing it current before
    /// billing).
    pub last_checkpoint_ts: i64,
    /// Timestamp of the last successful fee settlement -- the start of the
    /// currently-open accrual period. Persisted so settlement is safe to
    /// retry after a failed keeper run: nothing is charged twice, since
    /// `period_supply_seconds` only resets once settlement actually
    /// succeeds, and a partial period is billed exactly rather than rounded
    /// to a fixed weekly snapshot.
    pub last_settled_ts: i64,
    pub bump: u8,
}

impl TvlAccrual {
    pub const SPACE: usize = 8 // discriminator
        + 1 // schema_version
        + 32 // reserve
        + 16 // period_supply_seconds
        + 8 // last_checkpoint_ts
        + 8 // last_settled_ts
        + 1; // bump
}
