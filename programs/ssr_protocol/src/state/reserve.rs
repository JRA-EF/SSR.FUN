use anchor_lang::prelude::*;

use crate::constants::MAX_METADATA_URI_LEN;
use crate::errors::SsrError;

/// Tracks resumable multi-step creation (see DEC-0019), pause state, and
/// wind-down. `Created -> AssetsInitializing -> Seeded -> Active`, with
/// `Paused` layered on top of `Active` (a Reserve pauses/unpauses from and
/// back to `Active` only -- pausing mid-creation is not a reachable state,
/// since creation itself isn't gated by pause checks). `WindDown` and
/// `Closed` are appended AFTER `Paused` deliberately: Borsh encodes this enum
/// by variant index (see `Reserve::SPACE`'s comment), so appending new unit
/// variants at the end is backward-compatible with every already-initialized
/// `Reserve` account on live DevNet -- `Created`=0/`AssetsInitializing`=1/
/// `Active`=2/`Paused`=3 keep their existing encoded values. See Phase G
/// security analysis in docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md.
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
    /// One-way transition from `Active` via `initiate_wind_down` (root
    /// manager only). Blocks new issuance (the existing `status == Active`
    /// check in `mint_reserve_tokens_in_kind` already covers this with zero
    /// code changes there) while deliberately still allowing redemption --
    /// see `Reserve::require_redemption_allowed` -- and fee collection, since
    /// `close_reserve` requires the Reserve Token supply to reach zero, which
    /// is only reachable if holders can still redeem out during `WindDown`.
    WindDown,
    /// Terminal. Set by `close_reserve` once supply and every registered
    /// asset's vault balance are both zero. No instruction transitions out of
    /// `Closed`.
    Closed,
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
        require!(
            self.status != ReserveStatus::Paused,
            SsrError::ReservePaused
        );
        Ok(())
    }

    /// Redemption is allowed in `Active`, `Paused` (DEC-0016 -- redemption is
    /// exempt from pause), and `WindDown` (deliberately -- see the
    /// `ReserveStatus::WindDown` doc comment: `close_reserve` requires supply
    /// to reach zero, which requires holders to still be able to redeem out
    /// while winding down). Named for what it now actually gates, not the
    /// narrower `Active`-or-`Paused` set it was originally written for --
    /// this method has exactly one call site (`redeem_reserve_tokens_in_kind`).
    pub fn require_redemption_allowed(&self) -> Result<()> {
        require!(
            self.status == ReserveStatus::Active
                || self.status == ReserveStatus::Paused
                || self.status == ReserveStatus::WindDown,
            SsrError::UnexpectedReserveStatus
        );
        Ok(())
    }
}
