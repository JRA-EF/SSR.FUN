//! Structured events for every state-changing instruction. Deliberately
//! includes dedicated mint/redeem events with full per-asset breakdowns --
//! see DEC-0018 / RESERVE_REFERENCE_ANALYSIS.md section 16 for why this
//! improves on the reference protocol's own indexing gap (which relies on
//! indexers correlating a share-token Transfer with separate basket-token
//! Transfers).

use anchor_lang::prelude::*;

#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub max_reserve_assets: u8,
    pub ts: i64,
}

#[event]
pub struct ReserveCreated {
    pub reserve: Pubkey,
    pub reserve_id: u64,
    pub manager: Pubkey,
    pub reserve_token_mint: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReserveAssetInitialized {
    pub reserve: Pubkey,
    pub asset_mint: Pubkey,
    pub vault: Pubkey,
    pub target_weight_bps: u16,
    pub order_index: u8,
    pub ts: i64,
}

#[event]
pub struct ReserveAssetAdded {
    pub reserve: Pubkey,
    pub asset_mint: Pubkey,
    pub vault: Pubkey,
    pub target_weight_bps: u16,
    pub order_index: u8,
    pub added_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReserveAssetFunded {
    pub reserve: Pubkey,
    pub asset_mint: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub funded_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReserveAssetRemoved {
    pub reserve: Pubkey,
    pub asset_mint: Pubkey,
    pub vault: Pubkey,
    pub removed_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct WindDownInitiated {
    pub reserve: Pubkey,
    pub initiated_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReserveClosed {
    pub reserve: Pubkey,
    pub closed_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReserveSeeded {
    pub reserve: Pubkey,
    pub initial_reserve_tokens: u64,
    pub asset_mints: Vec<Pubkey>,
    pub asset_amounts: Vec<u64>,
    pub ts: i64,
}

#[event]
pub struct ReserveTokensMinted {
    pub reserve: Pubkey,
    pub depositor: Pubkey,
    pub reserve_tokens_out: u64,
    pub mint_fee_reserve_tokens: u64,
    pub asset_mints: Vec<Pubkey>,
    pub asset_amounts_in: Vec<u64>,
    pub ts: i64,
}

#[event]
pub struct ReserveTokensRedeemed {
    pub reserve: Pubkey,
    pub redeemer: Pubkey,
    pub reserve_tokens_burned: u64,
    pub redemption_fee_reserve_tokens: u64,
    pub asset_mints: Vec<Pubkey>,
    pub asset_amounts_out: Vec<u64>,
    pub ts: i64,
}

#[event]
pub struct TargetsUpdated {
    pub reserve: Pubkey,
    pub asset_mints: Vec<Pubkey>,
    pub new_target_weights_bps: Vec<u16>,
    pub updated_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct DelegateAdded {
    pub reserve: Pubkey,
    pub delegate: Pubkey,
    pub permissions: u16,
    pub restricted: bool,
    pub ts: i64,
}

#[event]
pub struct DelegatePermissionsUpdated {
    pub reserve: Pubkey,
    pub delegate: Pubkey,
    pub old_permissions: u16,
    pub new_permissions: u16,
    pub ts: i64,
}

#[event]
pub struct DelegateRemoved {
    pub reserve: Pubkey,
    pub delegate: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReserveManagerTransferred {
    pub reserve: Pubkey,
    pub old_manager: Pubkey,
    pub new_manager: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReservePaused {
    pub reserve: Pubkey,
    pub paused_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ReserveUnpaused {
    pub reserve: Pubkey,
    pub unpaused_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct FeesAccrued {
    pub reserve: Pubkey,
    pub manager_fee_shares_accrued: u64,
    pub protocol_fee_shares_accrued: u64,
    pub accrued_until_ts: i64,
}

#[event]
pub struct FeesCollected {
    pub reserve: Pubkey,
    pub manager_fee_shares_minted: u64,
    pub protocol_fee_shares_minted: u64,
    pub manager_destination: Pubkey,
    pub protocol_destination: Pubkey,
    pub ts: i64,
}

#[event]
pub struct RebalanceRecorded {
    pub reserve: Pubkey,
    pub asset_mints: Vec<Pubkey>,
    pub balances_before: Vec<u64>,
    pub balances_after: Vec<u64>,
    pub executed_by: Pubkey,
    pub note: String,
    pub ts: i64,
}

/// Emitted by `execute_rebalance_leg` -- unlike `RebalanceRecorded`'s
/// caller-supplied `balances_before`, every field here is derived from the
/// real CPI'd swap itself (see instructions/execute_rebalance_leg.rs), so
/// this event is intrinsically trustworthy on its own; a client should NOT
/// also call `record_rebalance` after an AMM-routed leg.
#[event]
pub struct RebalanceLegExecuted {
    pub reserve: Pubkey,
    pub mint_sell: Pubkey,
    pub mint_buy: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub executed_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct MetadataUpdated {
    pub reserve: Pubkey,
    pub new_metadata_uri: String,
    pub updated_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ProtocolConfigUpdated {
    pub authority: Pubkey,
    pub old_default_protocol_fee_destination: Pubkey,
    pub new_default_protocol_fee_destination: Pubkey,
    pub old_default_protocol_fee_bps: u16,
    pub new_default_protocol_fee_bps: u16,
    pub ts: i64,
}

// --- Manager fee recipients (DEC-0094) ---

/// Emitted by both `initialize_manager_fee_recipients` (first-ever routing
/// for this Reserve) and `update_fee_recipients` (a subsequent change).
/// `recipients`/`allocations_bps` are parallel arrays, in slot order.
#[event]
pub struct ManagerFeeRecipientsConfigured {
    pub reserve: Pubkey,
    pub recipients: Vec<Pubkey>,
    pub allocations_bps: Vec<u16>,
    pub configured_by: Pubkey,
    pub routing_updated_at: i64,
    pub ts: i64,
}

/// Emitted once per mint/accrue call that credits a migrated Reserve's
/// per-recipient balances (largest-remainder apportionment of the
/// Manager's total fee shares that accrual). `recipients`/`amounts` are
/// parallel arrays, active slots only. `source` distinguishes which fee
/// generated this accrual so it's never conflated with the other.
#[event]
pub struct ManagerFeeShareAccrued {
    pub reserve: Pubkey,
    pub recipients: Vec<Pubkey>,
    pub amounts: Vec<u64>,
    pub source: ManagerFeeAccrualSource,
    pub ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ManagerFeeAccrualSource {
    MintFee,
    AnnualTvlFee,
}

/// Emitted by `collect_manager_fee_share` -- one recipient's own pending
/// balance paid out and zeroed.
#[event]
pub struct ManagerFeeShareCollected {
    pub reserve: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub collected_by: Pubkey,
    pub ts: i64,
}
