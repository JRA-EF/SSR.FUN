use anchor_lang::prelude::*;

use crate::constants::{MAX_METADATA_URI_LEN, SCHEMA_VERSION};
use crate::errors::SsrError;

/// Tracks resumable multi-step creation (see DEC-0019) and pause state.
/// `Created -> AssetsInitializing -> Seeded -> Active`, with `Paused` layered
/// on top of `Active` (a Reserve pauses/unpauses from and back to `Active`
/// only -- pausing mid-creation is not a reachable state, since creation
/// itself isn't gated by pause checks).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReserveStatus {
    /// `create_reserve` has run; no assets registered yet.
    Created,
    /// At least one `initialize_reserve_asset` has run; not yet seeded.
    AssetsInitializing,
    /// `seed_reserve` has run; Reserve Tokens exist and mint/redeem are live.
    Active,
    /// Manager/delegate-initiated pause. Mint, target updates, and rebalance
    /// actions are blocked; redemption remains available (DEC-0016).
    Paused,
}

/// All fee values here are explicit DevNet placeholders, not final economics.
/// See DEC-0013.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct FeeConfig {
    pub mint_fee_bps: u16,
    pub redemption_fee_bps: u16,
    pub annual_tvl_fee_bps: u16,
    /// Manager's share of the collected fee pool, out of BPS_DENOMINATOR.
    pub manager_fee_share_bps: u16,
    /// Protocol's share of the collected fee pool, out of BPS_DENOMINATOR.
    /// `manager_fee_share_bps + protocol_fee_share_bps` need not equal
    /// BPS_DENOMINATOR; any residual is intentionally left unminted (burned
    /// in effect, mirroring the reference protocol's `folioFeeForSelf`
    /// concept) rather than silently dropped or misattributed.
    pub protocol_fee_share_bps: u16,
    pub fee_destination: Pubkey,
    /// Unix timestamp of the last `accrue_fees` checkpoint. TVL fee accrues
    /// on full elapsed days since this timestamp (discrete daily snapshots,
    /// not continuous per-second streaming -- see
    /// RESERVE_REFERENCE_ANALYSIS.md section 8).
    pub last_fee_accrual_ts: i64,
    /// Accounted-but-not-yet-minted Reserve Token amounts, owed to the
    /// manager and to the protocol respectively. Only `collect_fees` actually
    /// mints these. See docs/protocol/ACCOUNT_MODEL.md FeeConfig table.
    pub pending_manager_fee_shares: u64,
    pub pending_protocol_fee_shares: u64,
}

impl FeeConfig {
    pub const SPACE: usize = 2 + 2 + 2 + 2 + 2 + 32 + 8 + 8 + 8;
}

/// Canonical per-Reserve state. See docs/protocol/ACCOUNT_MODEL.md "Reserve".
#[account]
pub struct Reserve {
    pub schema_version: u8,
    pub reserve_id: u64,
    pub manager: Pubkey,
    pub reserve_token_mint: Pubkey,
    pub status: ReserveStatus,
    pub asset_count: u8,
    pub total_target_weight_bps: u16,
    pub created_at: i64,
    pub configured_at: i64,
    pub fee_config: FeeConfig,
    pub metadata_uri: String,
    pub delegate_count: u8,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub mint_authority_bump: u8,
}

impl Reserve {
    pub const SPACE: usize = 8 // discriminator
        + 1 // schema_version
        + 8 // reserve_id
        + 32 // manager
        + 32 // reserve_token_mint
        + 1 // status (enum, borsh encodes as u8 variant index + no payload here)
        + 1 // asset_count
        + 2 // total_target_weight_bps
        + 8 // created_at
        + 8 // configured_at
        + FeeConfig::SPACE
        + 4 + MAX_METADATA_URI_LEN // String: 4-byte len prefix + max bytes
        + 1 // delegate_count
        + 1 // bump
        + 1 // vault_authority_bump
        + 1; // mint_authority_bump

    pub fn require_not_paused(&self) -> Result<()> {
        require!(self.status != ReserveStatus::Paused, SsrError::ReservePaused);
        Ok(())
    }

    pub fn require_active_or_paused(&self) -> Result<()> {
        require!(
            self.status == ReserveStatus::Active || self.status == ReserveStatus::Paused,
            SsrError::UnexpectedReserveStatus
        );
        Ok(())
    }
}
