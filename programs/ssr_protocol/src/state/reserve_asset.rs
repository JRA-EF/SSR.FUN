use anchor_lang::prelude::*;

// NOTE (2026-07-29 terminology decision, see CLAUDE.md "Mandatory
// terminology" and docs/project/DECISION_LOG.md): product copy now uses
// "Reserve" for an underlying holding and "Decentralized Token Reserve" for
// the whole basket -- the inverse of this struct's name. `ReserveAsset` is
// intentionally NOT renamed: Anchor derives each account's on-chain
// discriminator from its struct name at compile time, so renaming it would
// break deserialization of every already-initialized `ReserveAsset` account
// on live DevNet. Treat this as a legacy technical identifier, not current
// product terminology.

/// Which token program owns this asset's mint/vault. SSR supports both,
/// validating Token-2022 extensions at registration time -- see
/// docs/protocol/SECURITY_INVARIANTS.md for the supported/rejected extension
/// list and DEC-0011 for the rationale.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TokenProgramKind {
    SplToken,
    Token2022,
}

/// One basket constituent of a Reserve. See docs/protocol/ACCOUNT_MODEL.md
/// "ReserveAsset".
#[account]
pub struct ReserveAsset {
    pub reserve: Pubkey,
    pub asset_mint: Pubkey,
    pub vault: Pubkey,
    pub token_program: TokenProgramKind,
    pub decimals: u8,
    pub target_weight_bps: u16,
    pub enabled: bool,
    /// Deterministic registration order -- clients and on-chain iteration
    /// always agree on asset ordering (see docs/protocol/ACCOUNT_MODEL.md).
    pub order_index: u8,
    pub bump: u8,
}

impl ReserveAsset {
    pub const SPACE: usize = 8 // discriminator
        + 32 // reserve
        + 32 // asset_mint
        + 32 // vault
        + 1 // token_program
        + 1 // decimals
        + 2 // target_weight_bps
        + 1 // enabled
        + 1 // order_index
        + 1; // bump
}
