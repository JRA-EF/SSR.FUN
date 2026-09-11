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
    pub admin_2: Pubkey,
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
    /// NET Reserve Token units minted to the creator -- the seed mint fee
    /// (see `mint_fee_reserve_tokens` below) has already been deducted, same
    /// convention as `ReserveTokensMinted.reserve_tokens_out`.
    pub initial_reserve_tokens: u64,
    /// Protocol + Manager fee, in Reserve Token units, taken from the gross
    /// seed request. The initial seed mint is fee-charged like any other
    /// mint -- previously fee-free, a confirmed bug.
    pub mint_fee_reserve_tokens: u64,
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

/// Emitted whenever a mint's (Buy or seed) Protocol fee share is minted
/// directly to the Protocol treasury in the SAME transaction as the mint --
/// see docs/project/DECISION_LOG.md's entry for this pass. Distinct from
/// `ProtocolFeeCollected` (a separate, later-triggered weekly-settlement
/// transfer for the TVL fee, or a legacy drain of a pre-this-pass pending
/// balance) so the Activity Log can show "instant mint-fee transfer" as its
/// own category, per the explicit requirement to record amount, asset
/// (the Reserve Token mint), treasury wallet, and signature for this exact
/// event.
#[event]
pub struct ProtocolMintFeeTransferred {
    pub reserve: Pubkey,
    pub reserve_token_mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    pub ts: i64,
}

/// Emitted by the standalone `accrue_fees` instruction whenever it actually
/// settles a TVL-fee period (2026-08-14 pass, see
/// docs/project/DECISION_LOG.md) -- a no-op call (nothing accumulated since
/// `last_settled_ts`) emits nothing. `period_start_ts`/`period_end_ts` are
/// `TvlAccrual.last_settled_ts` before/after this settlement; the Protocol's
/// share is minted directly to `protocol_destination` in this SAME
/// transaction (never left pending), matching `ProtocolMintFeeTransferred`'s
/// instant-transfer semantics. The Manager's share accrues to its
/// recipient(s) exactly like a mint-fee accrual (see
/// `ManagerFeeShareAccrued`, source = `AnnualTvlFee`).
#[event]
pub struct TvlFeeSettled {
    pub reserve: Pubkey,
    pub reserve_token_mint: Pubkey,
    pub period_start_ts: i64,
    pub period_end_ts: i64,
    /// `period_supply_seconds / (period_end_ts - period_start_ts)` -- the
    /// time-weighted average Reserve Token supply over the settled period,
    /// surfaced for transparency (Activity Log / audit), never used for
    /// control flow.
    pub time_weighted_avg_supply: u64,
    pub protocol_fee_shares: u64,
    pub manager_fee_shares: u64,
    pub protocol_destination: Pubkey,
    pub settled_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ProtocolFeeCollected {
    pub reserve: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    pub collected_by: Pubkey,
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
pub struct ProtocolPausedSet {
    pub authority: Pubkey,
    pub paused: bool,
    pub ts: i64,
}

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
    /// DEC-0173: the redemption fee, routed into the fee vault instead of
    /// the old burn-for-holders mechanic. Appended (never reordered) so
    /// existing Borsh decoders keep decoding the first two variants
    /// unchanged.
    RedemptionFee,
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

// --- USDC fee-settlement pipeline (2026-08-21 pass) -------------------------

/// Emitted whenever `mint_reserve_tokens_in_kind`/`accrue_fees` crystallizes
/// a fee into the shared fee vault (replacing the old instant-mint-to-
/// treasury / pending-counter destinations for any Reserve that has been
/// upgraded onto this path). `source` distinguishes which fee generated
/// this credit, reusing the existing `ManagerFeeAccrualSource` enum (Mint or
/// AnnualTvl) even though this event covers BOTH Protocol and Manager
/// shares together (unlike `ManagerFeeShareAccrued`, which is Manager-only).
#[event]
pub struct FeeVaultCredited {
    pub reserve: Pubkey,
    pub protocol_shares: u64,
    pub manager_shares: u64,
    pub source: ManagerFeeAccrualSource,
    pub ts: i64,
}

/// Emitted by `redeem_fee_vault_shares` -- burns `shares` from the fee vault
/// and stages the proportional per-asset entitlement into each asset's own
/// settlement staging ATA. `protocol_shares_redeemed`/`manager_shares_redeemed`
/// are this redemption's own split (see fee_math::split_fee_vault_redemption),
/// added to `FeeSettlement`'s running pending-settlement counters.
#[event]
pub struct FeeSharesRedeemed {
    pub reserve: Pubkey,
    pub shares_redeemed: u64,
    pub protocol_shares_redeemed: u64,
    pub manager_shares_redeemed: u64,
    pub asset_mints: Vec<Pubkey>,
    pub asset_amounts_staged: Vec<u64>,
    pub redeemed_by: Pubkey,
    pub ts: i64,
}

/// Emitted by `approve_settlement_swap` -- the ONE step in this pipeline
/// that hands bounded spending power to an off-chain keeper wallet (an SPL
/// `Approve`, not a transfer -- nothing has moved yet). The keeper is
/// expected to build and submit an ordinary Jupiter swap transaction next,
/// signing as the SPL delegate for exactly this approved amount.
#[event]
pub struct SettlementSwapApproved {
    pub reserve: Pubkey,
    pub asset_mint: Pubkey,
    pub amount: u64,
    pub keeper: Pubkey,
    pub ts: i64,
}

/// Emitted by `distribute_fee_usdc` -- pays out whatever USDC is CURRENTLY
/// sitting in the settlement USDC staging account (never a claimed/expected
/// number) to the Protocol Treasury and the Reserve's configured Manager fee
/// recipient(s), split by the current pending-settlement ratio. Naturally
/// idempotent: a call that finds a zero staging balance still emits this
/// event with `usdc_distributed: 0` (a genuine, harmless no-op), never an
/// error -- see distribute_fee_usdc.rs's own header.
#[event]
pub struct FeeUsdcDistributed {
    pub reserve: Pubkey,
    pub usdc_distributed: u64,
    pub protocol_usdc: u64,
    pub manager_usdc: u64,
    pub protocol_destination: Pubkey,
    pub manager_recipients: Vec<Pubkey>,
    pub manager_amounts: Vec<u64>,
    pub distributed_by: Pubkey,
    pub ts: i64,
}

/// Emitted once by `set_fee_settlement_keeper` whenever the Protocol Admin
/// changes the configured keeper wallet (including its very first
/// configuration, where `old_keeper` is the default/zero address).
#[event]
pub struct FeeSettlementKeeperSet {
    pub authority: Pubkey,
    pub old_keeper: Pubkey,
    pub new_keeper: Pubkey,
    pub ts: i64,
}

/// A Reserve Token mint's Metaplex metadata account was created (DEC-0200).
/// Emitted once per mint: the instruction no-ops when the account already
/// exists, so this event marks the transition from "no metadata anywhere" to
/// "wallets and explorers can finally name this token".
#[event]
pub struct TokenMetadataPublished {
    pub reserve: Pubkey,
    pub reserve_token_mint: Pubkey,
    pub metadata: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub published_by: Pubkey,
    pub ts: i64,
}
