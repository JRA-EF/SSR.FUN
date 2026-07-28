//! Every instruction module exports an `Accounts` struct and a `handler`
//! function. Re-exported via glob (`pub use module::*`) rather than named
//! re-exports: `#[derive(Accounts)]` generates a companion
//! `__client_accounts_<name>` module as a SIBLING of each `Accounts` struct
//! (used by the `#[program]` macro's crate-root-level `pub mod accounts {
//! pub use crate::__client_accounts_<name>::*; }` block) -- a named
//! re-export (`pub use module::AccountsStruct;`) does NOT bring that sibling
//! module along, which surfaces as a confusing "unresolved import `crate`"
//! error pointing at the `#[program]` attribute itself, not at the actual
//! missing item. Glob re-exporting here, plus `pub use instructions::*;` in
//! lib.rs, propagates it all the way to the crate root where `#[program]`
//! expects it.
//!
//! Every module also defines a function literally named `handler` -- glob
//! re-exporting makes that name ambiguous if referenced bare, but nothing
//! here ever does: `lib.rs` always calls it fully module-qualified (e.g.
//! `instructions::create_reserve::handler(...)`), so the ambiguity is never
//! actually triggered.

// The glob re-exports below intentionally make `handler` ambiguous if ever
// referenced unqualified (see the module doc comment above) -- nothing here
// does that, so the warning is expected noise, not a real problem.
#![allow(ambiguous_glob_reexports)]

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
pub mod update_protocol_config;
pub mod update_targets;

pub use accrue_fees::*;
pub use add_delegate::*;
pub use collect_fees::*;
pub use create_reserve::*;
pub use initialize_protocol::*;
pub use initialize_reserve_asset::*;
pub use mint_reserve_tokens_in_kind::*;
pub use pause_reserve::*;
pub use record_rebalance::*;
pub use redeem_reserve_tokens_in_kind::*;
pub use remove_delegate::*;
pub use seed_reserve::*;
pub use transfer_reserve_manager::*;
pub use unpause_reserve::*;
pub use update_delegate_permissions::*;
pub use update_metadata::*;
pub use update_protocol_config::*;
pub use update_targets::*;
