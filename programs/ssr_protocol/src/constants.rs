//! Protocol-wide constants. Seed prefixes here are load-bearing: every PDA
//! derivation in `state/` and every `#[account(seeds = ...)]` constraint in
//! `instructions/` must use these exact byte strings, or account derivation
//! silently diverges between client and program.

/// PDA seed for the singleton `ProtocolConfig` account.
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";
/// PDA seed prefix for a `Reserve` account (combined with `reserve_id.to_le_bytes()`).
pub const RESERVE_SEED: &[u8] = b"reserve";
/// PDA seed prefix for a `ReserveAsset` account (combined with `reserve` + `asset_mint`).
pub const RESERVE_ASSET_SEED: &[u8] = b"reserve_asset";
/// PDA seed prefix for a Reserve Vault token account (combined with `reserve` + `asset_mint`).
pub const RESERVE_VAULT_SEED: &[u8] = b"reserve_vault";
/// PDA seed prefix for a Reserve's signer-only vault authority (combined with `reserve`).
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
/// PDA seed prefix for a Reserve Token mint (combined with `reserve`).
pub const RESERVE_TOKEN_MINT_SEED: &[u8] = b"reserve_token_mint";
/// PDA seed prefix for a Reserve Token mint's signer-only mint authority (combined with `reserve`).
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
/// PDA seed prefix for a `Delegate` account (combined with `reserve` + `wallet`).
pub const DELEGATE_SEED: &[u8] = b"delegate";
/// PDA seed prefix for a `ManagerFeeRecipients` account (combined with `reserve`).
/// See DEC-0094 (multi-recipient Manager fees) and state/manager_fee_recipients.rs.
pub const MANAGER_FEE_RECIPIENTS_SEED: &[u8] = b"manager_fee_recipients";
/// PDA seed prefix for a `TvlAccrual` account (combined with `reserve`). See
/// state/tvl_accrual.rs -- the time-weighted average TVL accumulator behind
/// the Annualized TVL fee's weekly settlement (2026-08-14 pass, see
/// docs/project/DECISION_LOG.md).
pub const TVL_ACCRUAL_SEED: &[u8] = b"tvl_accrual";
/// PDA seed prefix for a `FeeSettlement` account (combined with `reserve`).
/// See state/fee_settlement.rs -- USDC fee-settlement pipeline (2026-08-21
/// pass, see docs/project/DECISION_LOG.md). Also the seed prefix for two
/// further, non-state PDAs derived the same way: `FEE_VAULT_AUTHORITY_SEED`
/// (owns the fee-vault Reserve Token ATA) and `SETTLEMENT_AUTHORITY_SEED`
/// (owns every per-asset/USDC settlement staging ATA) -- kept as separate
/// seed prefixes, not the same authority, so the fee-vault's mint/burn
/// authority is never the same signing key as the one that can approve a
/// keeper's delegated spending allowance.
pub const FEE_SETTLEMENT_SEED: &[u8] = b"fee_settlement";
pub const FEE_VAULT_AUTHORITY_SEED: &[u8] = b"fee_vault_authority";
pub const SETTLEMENT_AUTHORITY_SEED: &[u8] = b"settlement_authority";
/// PDA seed for the singleton `SettlementKeeperConfig` account (no
/// per-Reserve component -- one keeper, protocol-wide). See
/// state/settlement_keeper_config.rs's header for why this is a SEPARATE
/// account from `ProtocolConfig` rather than a field grown onto it.
pub const SETTLEMENT_KEEPER_CONFIG_SEED: &[u8] = b"settlement_keeper_config";

/// Reserve Token decimals. See docs/protocol/SSR_ARCHITECTURE.md section 2.
pub const RESERVE_TOKEN_DECIMALS: u8 = 6;

/// Basis-point denominator used throughout (10_000 = 100%).
pub const BPS_DENOMINATOR: u16 = 10_000;

/// v1 DevNet default cap on Reserve Assets per Reserve. Stored (not
/// hardcoded) on `ProtocolConfig.max_reserve_assets`; this is only the
/// initial value written at `initialize_protocol`. See DEC-0014.
pub const DEFAULT_MAX_RESERVE_ASSETS: u8 = 12;

/// Absolute ceiling on `max_reserve_assets` even if `ProtocolConfig` is later
/// reconfigured -- a safety rail against misconfiguration, not a business
/// decision. Comfortably above DEFAULT_MAX_RESERVE_ASSETS to allow room to
/// raise the configured cap without a program upgrade, while still bounding
/// worst-case compute/account-list size in mint/redeem.
pub const ABSOLUTE_MAX_RESERVE_ASSETS: u8 = 24;

/// Max length in bytes of `Reserve.metadata_uri`.
pub const MAX_METADATA_URI_LEN: usize = 200;

/// Current on-chain schema version for `ProtocolConfig` and `Reserve`.
/// Bump when the account layout changes; see docs/protocol/SSR_ARCHITECTURE.md
/// section on upgrade policy.
///
/// Bumped 1 -> 2 for the Mainnet two-admin `ProtocolConfig` change (adds
/// `admin_2`; see DEC entry for the Mainnet authority-model pass) -- no
/// pre-existing accounts to migrate since this predates any Mainnet
/// initialization.
pub const SCHEMA_VERSION: u8 = 2;

/// Minimum seed value (in the seed asset's smallest unit, summed across all
/// assets at their provisional 1:1 unit convention -- see `seed_reserve`)
/// required to create a Reserve's first Reserve Token supply. Prevents a
/// creator from minting a large `initialShares`-equivalent against a
/// negligible real deposit (the gap Folio leaves open only because it has no
/// permissionless first-mint moment -- SSR does, so this closes it). See
/// DEC-0009 / RESERVE_REFERENCE_ANALYSIS.md section 6.
pub const MIN_SEED_AMOUNT_PER_ASSET: u64 = 1_000; // smallest-unit amount, pre-decimals-aware scaling done in seed_reserve

/// Provisional DevNet fee defaults -- NOT final economics. See DEC-0013.
pub const DEFAULT_MINT_FEE_BPS: u16 = 50; // 0.50%
pub const DEFAULT_REDEMPTION_FEE_BPS: u16 = 0; // not charged in v1
pub const DEFAULT_ANNUAL_TVL_FEE_BPS: u16 = 100; // 1.00% / year

/// SSR.fun Protocol/Manager fee-split formula (DEC-0094): applied
/// independently to the Mint fee and the Annualized TVL fee, computed fresh
/// at every accrual (never a caller-chosen ratio -- see fee_math.rs):
///   protocol_bps = max(PROTOCOL_MIN_..._FEE_BPS, configured_bps / 2)
///   manager_bps  = max(configured_bps - protocol_bps, 0)
/// Both floors are 0.5% today; kept as two separate constants (rather than
/// one shared one) because the task's rules name them independently and a
/// future divergence between mint/TVL floors should not require touching
/// unrelated call sites.
pub const PROTOCOL_MIN_MINT_FEE_BPS: u16 = 50; // 0.5%
pub const PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS: u16 = 50; // 0.5%

/// Absolute caps no FeeConfig update may exceed, regardless of who's
/// authorized to change fees -- distinct from the *default* values above.
pub const MAX_MINT_FEE_BPS: u16 = 500; // 5%
pub const MAX_REDEMPTION_FEE_BPS: u16 = 500; // 5%
pub const MAX_ANNUAL_TVL_FEE_BPS: u16 = 1000; // 10%/year, matches reference protocol's own cap

/// Maximum number of Manager fee recipients a Reserve may configure at once,
/// including the Primary Fee Destination. See DEC-0094 / state/manager_fee_recipients.rs.
pub const MAX_FEE_RECIPIENTS: u8 = 10;

/// Seconds in a day, used for the daily-boundary TVL fee accrual checkpoint
/// (adopting the reference protocol's discrete-daily-snapshot pattern rather
/// than continuous per-second streaming -- see RESERVE_REFERENCE_ANALYSIS.md
/// section 8).
pub const SECONDS_PER_DAY: i64 = 86_400;
pub const SECONDS_PER_YEAR: u128 = 365 * 86_400;
