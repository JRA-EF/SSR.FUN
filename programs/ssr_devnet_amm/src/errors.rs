use anchor_lang::prelude::*;

#[error_code]
pub enum AmmError {
    #[msg("Signer is not the AMM authority.")]
    NotAmmAuthority,
    #[msg("A pool's mint_a must be the canonical wrapped-SOL mint (hub-and-spoke v1 -- see DEC-0051).")]
    MintAMustBeWrappedSol,
    #[msg("Requested fee exceeds the absolute maximum allowed.")]
    FeeExceedsMaximum,
    #[msg("The AMM is currently paused; swaps are not permitted.")]
    AmmPaused,
    #[msg("The supplied pool does not match the expected PDA for these mints.")]
    InvalidPool,
    #[msg("The supplied vault does not match the expected PDA for this pool and mint.")]
    InvalidVault,
    #[msg("The supplied mint does not match this pool's registered mint_a/mint_b.")]
    MintMismatch,
    #[msg("Value is zero where a nonzero value is required.")]
    ZeroValue,
    #[msg("Requested output is below the caller's specified minimum (slippage protection).")]
    SlippageMinOutputNotMet,
    #[msg("Requested liquidity removal exceeds the pool vault's current balance.")]
    InsufficientVaultBalance,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Division by zero.")]
    DivisionByZero,
}
