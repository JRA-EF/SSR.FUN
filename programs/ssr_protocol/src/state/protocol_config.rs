use anchor_lang::prelude::*;

use crate::constants::SCHEMA_VERSION;

/// Singleton global configuration account. See docs/protocol/ACCOUNT_MODEL.md
/// "ProtocolConfig" and docs/protocol/SSR_ARCHITECTURE.md section 7 for the
/// narrow-authority rationale: this account can pause creation/mint
/// protocol-wide and set defaults for *new* Reserves, but can never move a
/// single token out of any already-created Reserve's vaults.
///
/// Two independent Protocol Admins (`authority`, `admin_2`) rather than one --
/// both approved Mainnet admin wallets must be able to act independently, and
/// there is deliberately no multisig/threshold layer here (see the Mainnet
/// authority-model decision entry). Neither field grants any path to Reserve
/// vault custody; see `collect_protocol_fee.rs` for why fee collection can
/// only mint pre-accounted Reserve Token shares to the fixed configured
/// destination, never touch raw Reserve Assets.
///
/// DELIBERATELY never grown with new fields after Mainnet genesis (2026-08-21
/// pass, see docs/project/DECISION_LOG.md): every instruction in this
/// program reads this account, so adding a field here would require Anchor
/// to successfully deserialize the NEW, larger struct shape against the
/// EXISTING, still-smaller on-chain account data -- which fails immediately
/// on every single instruction call, for every Reserve, the moment a program
/// upgrade lands, since a realloc can only happen inside an instruction that
/// itself first needs a successful deserialization to run at all. Any new
/// protocol-wide setting (e.g. `SettlementKeeperConfig`) must be its own,
/// separate, additive singleton PDA instead -- the same lesson this program
/// already learned once for `TvlAccrual`/`ManagerFeeRecipients` at the
/// per-Reserve level.
#[account]
pub struct ProtocolConfig {
    pub schema_version: u8,
    pub authority: Pubkey,
    pub admin_2: Pubkey,
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
        + 32 // admin_2
        + 1 // paused
        + 1 // max_reserve_assets
        + 2 // default_protocol_fee_bps
        + 32 // default_protocol_fee_destination
        + 8 // reserve_count
        + 1; // bump

    pub fn initial(
        authority: Pubkey,
        admin_2: Pubkey,
        max_reserve_assets: u8,
        default_protocol_fee_bps: u16,
        default_protocol_fee_destination: Pubkey,
        bump: u8,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            authority,
            admin_2,
            paused: false,
            max_reserve_assets,
            default_protocol_fee_bps,
            default_protocol_fee_destination,
            reserve_count: 0,
            bump,
        }
    }

    /// True if `key` is either approved Protocol Admin. Both admins are
    /// equally authorized for every protocol-admin-gated instruction --
    /// neither is a fallback/backup for the other.
    pub fn is_admin(&self, key: &Pubkey) -> bool {
        *key == self.authority || *key == self.admin_2
    }
}
