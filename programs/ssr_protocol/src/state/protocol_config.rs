use anchor_lang::prelude::*;

use crate::constants::SCHEMA_VERSION;

/// Singleton global configuration account. See docs/protocol/ACCOUNT_MODEL.md
/// "ProtocolConfig" and docs/protocol/SSR_ARCHITECTURE.md section 7 for the
/// narrow-authority rationale: this account can pause creation/mint
/// protocol-wide and set defaults for *new* Reserves, but can never move a
/// single token out of any already-created Reserve's vaults.
#[account]
pub struct ProtocolConfig {
    pub schema_version: u8,
    pub authority: Pubkey,
    pub paused: bool,
    pub max_reserve_assets: u8,
    pub default_protocol_fee_bps: u16,
    pub default_protocol_fee_destination: Pubkey,
    /// Monotonic counter; also used as the seed for the next `create_reserve`
    /// call's Reserve PDA (`reserve_id`). See DEC-0012.
    pub reserve_count: u64,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const SPACE: usize = 8 // discriminator
        + 1 // schema_version
        + 32 // authority
        + 1 // paused
        + 1 // max_reserve_assets
        + 2 // default_protocol_fee_bps
        + 32 // default_protocol_fee_destination
        + 8 // reserve_count
        + 1; // bump

    pub fn initial(
        authority: Pubkey,
        max_reserve_assets: u8,
        default_protocol_fee_bps: u16,
        default_protocol_fee_destination: Pubkey,
        bump: u8,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            authority,
            paused: false,
            max_reserve_assets,
            default_protocol_fee_bps,
            default_protocol_fee_destination,
            reserve_count: 0,
            bump,
        }
    }
}
