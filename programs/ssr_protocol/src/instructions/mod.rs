//! Every instruction module exports an `Accounts` struct and a `handler`
//! function. Only the `Accounts` structs are re-exported by name here (NOT
//! via glob `pub use module::*`) since every module defines a function
//! literally named `handler` -- a glob re-export would create an ambiguous
//! name collision across all 17 modules. `lib.rs` calls each handler fully
//! module-qualified (e.g. `instructions::create_reserve::handler(...)`).

pub mod common;

pub mod accrue_fees;
pub mod add_delegate;
pub mod collect_fees;
pub mod create_reserve;
pub mod initialize_protocol;
pub mod initialize_reserve_asset;
pub mod mint_reserve_tokens_in_kind;
pub mod pause_reserve;
pub mod record_rebalance;
pub mod redeem_reserve_tokens_in_kind;
pub mod remove_delegate;
pub mod seed_reserve;
pub mod transfer_reserve_manager;
pub mod unpause_reserve;
pub mod update_delegate_permissions;
pub mod update_metadata;
pub mod update_targets;

pub use accrue_fees::AccrueFees;
pub use add_delegate::AddDelegate;
pub use collect_fees::CollectFees;
pub use create_reserve::CreateReserve;
pub use initialize_protocol::InitializeProtocol;
pub use initialize_reserve_asset::InitializeReserveAsset;
pub use mint_reserve_tokens_in_kind::MintReserveTokensInKind;
pub use pause_reserve::PauseReserve;
pub use record_rebalance::RecordRebalance;
pub use redeem_reserve_tokens_in_kind::RedeemReserveTokensInKind;
pub use remove_delegate::RemoveDelegate;
pub use seed_reserve::SeedReserve;
pub use transfer_reserve_manager::TransferReserveManager;
pub use unpause_reserve::UnpauseReserve;
pub use update_delegate_permissions::UpdateDelegatePermissions;
pub use update_metadata::UpdateMetadata;
pub use update_targets::UpdateTargets;
