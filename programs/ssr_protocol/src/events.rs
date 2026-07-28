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
