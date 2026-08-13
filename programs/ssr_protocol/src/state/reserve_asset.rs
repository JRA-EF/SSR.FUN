use anchor_lang::prelude::*;

// NOTE (final terminology, 2026-08-04, DEC-0074, see CLAUDE.md "Mandatory
// terminology" and docs/project/DECISION_LOG.md): "Reserve" is the whole
// basket/product and "reserve assets" are its underlying holdings -- this
// struct's name already matches that sense, so no meaning mismatch is
// carried forward. Documented here only because `ReserveAsset` is a
// deployed Anchor account struct: Anchor derives its on-chain discriminator
// from the struct name at compile time, so renaming it (even to something
// that would read identically today) would break deserialization of every
// already-initialized `ReserveAsset` account on live DevNet. Treat the name
// as a legacy technical identifier that happens to already be correct, not
// something to casually touch.

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
