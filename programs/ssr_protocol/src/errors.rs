use anchor_lang::prelude::*;

#[error_code]
pub enum SsrError {
    // --- Validation: general ---
    #[msg("Metadata URI exceeds the maximum allowed length.")]
    MetadataUriTooLong,
    #[msg("Value is zero where a nonzero value is required.")]
    ZeroValue,

    // --- Validation: ProtocolConfig ---
    #[msg("Requested max_reserve_assets exceeds the absolute protocol ceiling.")]
    MaxReserveAssetsTooHigh,
    #[msg("The protocol is currently paused; this action is not permitted.")]
    ProtocolPaused,

    // --- Validation: Reserve / ReserveAsset ---
    #[msg("This Reserve has reached its configured maximum number of Reserve Assets.")]
    ReserveAssetLimitReached,
    #[msg("This asset mint is already registered as a Reserve Asset for this Reserve.")]
    DuplicateReserveAsset,
    #[msg("Unsupported token program for this mint.")]
    UnsupportedTokenProgram,
    #[msg("This Token-2022 mint carries an extension SSR cannot safely account for (e.g. transfer fee or transfer hook).")]
    UnsupportedMintExtension,
    #[msg("Sum of target weights would exceed 10,000 basis points (100%).")]
    TargetWeightExceedsTotal,
    #[msg("This Reserve Asset is disabled and cannot receive a nonzero target weight.")]
    ReserveAssetDisabled,
    #[msg("Reserve is not in the expected status for this action.")]
    UnexpectedReserveStatus,
    #[msg("Reserve is paused; this action is not permitted while paused.")]
    ReservePaused,
    #[msg("Reserve is not paused.")]
    ReserveNotPaused,
    #[msg(
        "The supplied Reserve Vault does not match the expected PDA for this Reserve and asset."
    )]
    InvalidReserveVault,
    #[msg("The supplied ReserveAsset account does not belong to this Reserve.")]
    ReserveAssetMismatch,
    #[msg("Remaining accounts do not match the Reserve's registered asset list (count or order).")]
    RemainingAccountsMismatch,
    #[msg("This action is only permitted on the most-recently-registered Reserve Asset (highest order_index).")]
    AssetNotLastRegistered,
    #[msg("This action requires the Reserve Asset's vault balance to be exactly zero.")]
    VaultNotEmpty,
    #[msg("close_reserve requires the Reserve Token supply to be exactly zero.")]
    ReserveTokenSupplyNotZero,

    // --- Validation: seeding / minting / redemption ---
    #[msg("Seed amount for this asset is below the minimum required seed amount.")]
    SeedAmountTooLow,
    #[msg("Reserve has already been seeded.")]
    ReserveAlreadySeeded,
    #[msg("Reserve has not been seeded yet.")]
    ReserveNotSeeded,
    #[msg("Requested Reserve Token output is below the caller's specified minimum.")]
    SlippageMinOutputNotMet,
    #[msg("Required input for at least one Reserve Asset exceeds the caller's specified maximum.")]
    SlippageMaxInputExceeded,
    #[msg("Requested mint or redemption amount is zero after fees/rounding.")]
    ZeroAmountAfterFeesOrRounding,
    #[msg("Redemption amount exceeds the caller's proportional entitlement.")]
    RedemptionExceedsEntitlement,
    #[msg(
        "Reserve Token supply is zero; proportional math is undefined until the Reserve is seeded."
    )]
    ZeroSupply,

    // --- Authority / permissions ---
    #[msg("Signer is not the root Reserve Manager for this Reserve.")]
    NotReserveManager,
    #[msg("Signer is not an authorized delegate for this action.")]
    DelegatePermissionDenied,
    #[msg("Only the root Reserve Manager may grant or revoke an unrestricted delegate.")]
    UnrestrictedDelegateRequiresManager,
    #[msg("Delegate permission bitmask sets a reserved bit that must be zero in v1.")]
    ReservedPermissionBitSet,
    #[msg("Signer is not the ProtocolConfig authority.")]
    NotProtocolAuthority,
    #[msg("Cannot remove or modify a delegate that does not exist for this Reserve.")]
    DelegateNotFound,

    // --- Arithmetic ---
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Arithmetic underflow.")]
    MathUnderflow,
    #[msg("Division by zero.")]
    DivisionByZero,

    // --- Fees ---
    #[msg("Requested fee exceeds the absolute maximum allowed for this fee type.")]
    FeeExceedsMaximum,
    #[msg("Manager and protocol fee shares must each be within [0, 10000] basis points.")]
    InvalidFeeShareSplit,
    #[msg("There are no pending fee shares to collect.")]
    NoPendingFees,

    // --- Rebalancing (manual, v1) ---
    #[msg("Rebalance record does not match the currently pending rebalance intent.")]
    RebalanceMismatch,
    #[msg("No rebalance intent is currently pending for this Reserve.")]
    NoPendingRebalance,

    // --- Rebalancing execution (execute_rebalance_leg) ---
    #[msg("Requested leg amount exceeds the per-call circuit-breaker bound (half the sell asset's current vault balance).")]
    RebalanceLegExceedsCircuitBreaker,
    #[msg("The two rebalance legs must reference different asset mints.")]
    RebalanceLegSameAsset,
}
