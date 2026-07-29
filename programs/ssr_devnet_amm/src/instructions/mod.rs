//! See `ssr_protocol/src/instructions/mod.rs` for why glob re-exports are
//! required here (the `#[program]` macro's generated `pub mod accounts`
//! block needs each `Accounts` struct's companion `__client_accounts_*`
//! module, which only a glob re-export carries along) -- identical
//! reasoning applies to this crate.
#![allow(ambiguous_glob_reexports)]

pub mod common;

pub mod add_liquidity;
pub mod create_pool;
pub mod initialize_amm_config;
pub mod pause_amm;
pub mod remove_liquidity;
pub mod swap;
pub mod unpause_amm;

pub use add_liquidity::*;
pub use create_pool::*;
pub use initialize_amm_config::*;
pub use pause_amm::*;
pub use remove_liquidity::*;
pub use swap::*;
pub use unpause_amm::*;
