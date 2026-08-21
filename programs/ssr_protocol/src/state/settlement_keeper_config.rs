use anchor_lang::prelude::*;

/// USDC fee-settlement pipeline (2026-08-21 pass, see
/// docs/project/DECISION_LOG.md): a separate, additive, protocol-wide
/// singleton PDA (seeds: `[SETTLEMENT_KEEPER_CONFIG_SEED]`, no per-Reserve
/// component) -- DELIBERATELY not a field on `ProtocolConfig` (see that
/// struct's own header for why growing it is unsafe for an
/// already-initialized Mainnet account). Lazily `init_if_needed` by
/// `set_fee_settlement_keeper` the first time a Protocol Admin configures a
/// keeper.
///
/// Holds exactly one thing: the wallet ever granted a bounded, per-call SPL
/// delegate approval over a settlement staging account (see
/// `approve_settlement_swap.rs`) -- never a fund-custody role, never able to
/// move more than whatever was just explicitly approved for one specific
/// asset. Every keeper-gated instruction requires this account to exist and
/// hold a real, non-default address first.
#[account]
pub struct SettlementKeeperConfig {
    pub schema_version: u8,
    pub keeper: Pubkey,
    pub bump: u8,
}

impl SettlementKeeperConfig {
    pub const SPACE: usize = 8 // discriminator
        + 1 // schema_version
        + 32 // keeper
        + 1; // bump
}
