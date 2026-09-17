//! SSR Protocol: an independent, Solana-native tokenized-reserve program.
//! Reference material only from Reserve Protocol's Folio (EVM/Solidity) --
//! see docs/protocol/RESERVE_REFERENCE_ANALYSIS.md. Not an EVM port, not
//! affiliated with Reserve Protocol.
//!
//! Terminology: Reserve, Reserve Token, Reserve Asset, Reserve Manager,
//! Reserve Factory, Reserve Vault -- see CLAUDE.md.
//!
//! Targets anchor-lang/anchor-spl 1.1.2 (verified current via crates.io).
//!
//! Two non-obvious things this file (and instructions/mod.rs) get right,
//! documented because both cost significant debugging time to discover:
//!
//! 1. Every dispatch function below explicitly unifies
//!    `Context<'info, T<'info>>` rather than eliding it as `Context<T>` --
//!    eliding it creates TWO independent anonymous lifetimes (one for
//!    `Context` itself, one for `T`'s internal parameter) instead of one
//!    shared lifetime, which fails to compile the moment a handler passes
//!    two different `ctx.accounts` fields (or `ctx.accounts` and
//!    `ctx.remaining_accounts`) to the same downstream call, since
//!    `Account`/`AccountInfo` are invariant over their lifetime parameter.
//! 2. `pub use instructions::*;` (glob, not a named re-export) is required:
//!    `#[derive(Accounts)]` generates a companion `__client_accounts_<name>`
//!    module as a sibling of each `Accounts` struct, which the `#[program]`
//!    macro's generated crate-root `pub mod accounts { pub use
//!    crate::__client_accounts_<name>::*; }` block expects to find at the
//!    crate root. A named re-export doesn't carry that sibling module along,
//!    surfacing as a confusing "unresolved import `crate`" pointing at the
//!    `#[program]` attribute itself rather than at the real cause.
//!
//! See docs/protocol/DEVNET_RUNBOOK.md.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod fee_math;
pub mod instructions;
pub mod state;

pub use instructions::*;

// Dedicated Mainnet program keypair (~/.config/solana/mainnet-program-keypair.json,
// generated outside this repo, never committed -- see the Mainnet deployment
// manifest / DECISION_LOG.md for the pass that created it). Distinct from the
// DevNet program ID (2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW, still live
// and unchanged on DevNet, see docs/protocol/DEVNET_RUNBOOK.md) -- Mainnet
// intentionally never reuses a DevNet program ID.
declare_id!("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");

#[program]
pub mod ssr_protocol {
    use super::*;

    pub fn initialize_protocol<'info>(
        ctx: Context<'info, InitializeProtocol<'info>>,
        admin_2: Pubkey,
        max_reserve_assets: u8,
        default_protocol_fee_bps: u16,
        default_protocol_fee_destination: Pubkey,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(
            ctx,
            admin_2,
            max_reserve_assets,
            default_protocol_fee_bps,
            default_protocol_fee_destination,
        )
    }

    pub fn create_reserve<'info>(
        ctx: Context<'info, CreateReserve<'info>>,
        metadata_uri: String,
        mint_fee_bps: u16,
        redemption_fee_bps: u16,
        annual_tvl_fee_bps: u16,
        fee_destination: Pubkey,
    ) -> Result<()> {
        instructions::create_reserve::handler(
            ctx,
            metadata_uri,
            mint_fee_bps,
            redemption_fee_bps,
            annual_tvl_fee_bps,
            fee_destination,
        )
    }

    pub fn initialize_reserve_asset<'info>(
        ctx: Context<'info, InitializeReserveAsset<'info>>,
        target_weight_bps: u16,
    ) -> Result<()> {
        instructions::initialize_reserve_asset::handler(ctx, target_weight_bps)
    }

    pub fn seed_reserve<'info>(
        ctx: Context<'info, SeedReserve<'info>>,
        seed_amounts: Vec<u64>,
        initial_reserve_tokens: u64,
    ) -> Result<()> {
        instructions::seed_reserve::handler(ctx, seed_amounts, initial_reserve_tokens)
    }

    pub fn mint_reserve_tokens_in_kind<'info>(
        ctx: Context<'info, MintReserveTokensInKind<'info>>,
        reserve_tokens_requested: u64,
        min_reserve_tokens_out: u64,
        max_asset_amounts: Vec<u64>,
    ) -> Result<()> {
        instructions::mint_reserve_tokens_in_kind::handler(
            ctx,
            reserve_tokens_requested,
            min_reserve_tokens_out,
            max_asset_amounts,
        )
    }

    pub fn redeem_reserve_tokens_in_kind<'info>(
        ctx: Context<'info, RedeemReserveTokensInKind<'info>>,
        reserve_tokens_to_redeem: u64,
        min_asset_amounts_out: Vec<u64>,
    ) -> Result<()> {
        instructions::redeem_reserve_tokens_in_kind::handler(
            ctx,
            reserve_tokens_to_redeem,
            min_asset_amounts_out,
        )
    }

    pub fn update_targets<'info>(
        ctx: Context<'info, UpdateTargets<'info>>,
        new_target_weights_bps: Vec<u16>,
    ) -> Result<()> {
        instructions::update_targets::handler(ctx, new_target_weights_bps)
    }

    pub fn add_delegate<'info>(
        ctx: Context<'info, AddDelegate<'info>>,
        delegate_wallet: Pubkey,
        permissions: u16,
        restricted: bool,
    ) -> Result<()> {
        instructions::add_delegate::handler(ctx, delegate_wallet, permissions, restricted)
    }

    pub fn update_delegate_permissions<'info>(
        ctx: Context<'info, UpdateDelegatePermissions<'info>>,
        new_permissions: u16,
    ) -> Result<()> {
        instructions::update_delegate_permissions::handler(ctx, new_permissions)
    }

    pub fn remove_delegate<'info>(ctx: Context<'info, RemoveDelegate<'info>>) -> Result<()> {
        instructions::remove_delegate::handler(ctx)
    }

    pub fn transfer_reserve_manager<'info>(
        ctx: Context<'info, TransferReserveManager<'info>>,
        new_manager: Pubkey,
    ) -> Result<()> {
        instructions::transfer_reserve_manager::handler(ctx, new_manager)
    }

    pub fn pause_reserve<'info>(ctx: Context<'info, PauseReserve<'info>>) -> Result<()> {
        instructions::pause_reserve::handler(ctx)
    }

    pub fn unpause_reserve<'info>(ctx: Context<'info, UnpauseReserve<'info>>) -> Result<()> {
        instructions::unpause_reserve::handler(ctx)
    }

    pub fn accrue_fees<'info>(ctx: Context<'info, AccrueFees<'info>>) -> Result<()> {
        instructions::accrue_fees::handler(ctx)
    }

    pub fn collect_fees<'info>(ctx: Context<'info, CollectFees<'info>>) -> Result<()> {
        instructions::collect_fees::handler(ctx)
    }

    /// Collects ONLY the Protocol's pending fee share -- see
    /// instructions/collect_protocol_fee.rs's header. Fully additive;
    /// collect_fees above is unchanged and still collects both sides.
    pub fn collect_protocol_fee<'info>(
        ctx: Context<'info, CollectProtocolFee<'info>>,
    ) -> Result<()> {
        instructions::collect_protocol_fee::handler(ctx)
    }

    // --- DEC-0094: multi-recipient Manager fees ---

    pub fn initialize_manager_fee_recipients<'info>(
        ctx: Context<'info, InitializeManagerFeeRecipients<'info>>,
        recipients: Vec<crate::state::FeeRecipientInput>,
    ) -> Result<()> {
        instructions::initialize_manager_fee_recipients::handler(ctx, recipients)
    }

    pub fn update_fee_recipients<'info>(
        ctx: Context<'info, UpdateFeeRecipients<'info>>,
        recipients: Vec<crate::state::FeeRecipientInput>,
    ) -> Result<()> {
        instructions::update_fee_recipients::handler(ctx, recipients)
    }

    pub fn collect_manager_fee_share<'info>(
        ctx: Context<'info, CollectManagerFeeShare<'info>>,
    ) -> Result<()> {
        instructions::collect_manager_fee_share::handler(ctx)
    }

    pub fn record_rebalance<'info>(
        ctx: Context<'info, RecordRebalance<'info>>,
        balances_before: Vec<u64>,
        note: String,
    ) -> Result<()> {
        instructions::record_rebalance::handler(ctx, balances_before, note)
    }

    /// One CPI'd swap leg via ssr_devnet_amm, genuinely moving this
    /// Reserve's own vault assets -- see instructions/execute_rebalance_leg.rs
    /// for the full design and its documented limitations. Coexists with
    /// record_rebalance above; does not replace it.
    pub fn execute_rebalance_leg<'info>(
        ctx: Context<'info, ExecuteRebalanceLeg<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        instructions::execute_rebalance_leg::handler(ctx, amount_in, minimum_amount_out)
    }

    pub fn update_metadata<'info>(
        ctx: Context<'info, UpdateMetadata<'info>>,
        new_metadata_uri: String,
    ) -> Result<()> {
        instructions::update_metadata::handler(ctx, new_metadata_uri)
    }

    pub fn set_reserve_token_metadata<'info>(
        ctx: Context<'info, SetReserveTokenMetadata<'info>>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::set_reserve_token_metadata::handler(ctx, name, symbol, uri)
    }

    pub fn update_protocol_config<'info>(
        ctx: Context<'info, UpdateProtocolConfig<'info>>,
        new_default_protocol_fee_destination: Pubkey,
        new_default_protocol_fee_bps: u16,
    ) -> Result<()> {
        instructions::update_protocol_config::handler(
            ctx,
            new_default_protocol_fee_destination,
            new_default_protocol_fee_bps,
        )
    }

    pub fn set_protocol_paused<'info>(
        ctx: Context<'info, SetProtocolPaused<'info>>,
        paused: bool,
    ) -> Result<()> {
        instructions::set_protocol_paused::handler(ctx, paused)
    }

    // --- USDC fee-settlement pipeline (2026-08-21 pass) ---

    pub fn set_fee_settlement_keeper<'info>(
        ctx: Context<'info, SetFeeSettlementKeeper<'info>>,
        new_keeper: Pubkey,
    ) -> Result<()> {
        instructions::set_fee_settlement_keeper::handler(ctx, new_keeper)
    }

    pub fn redeem_fee_vault_shares<'info>(
        ctx: Context<'info, RedeemFeeVaultShares<'info>>,
        shares: u64,
    ) -> Result<()> {
        instructions::redeem_fee_vault_shares::handler(ctx, shares)
    }

    pub fn approve_settlement_swap<'info>(
        ctx: Context<'info, ApproveSettlementSwap<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::approve_settlement_swap::handler(ctx, amount)
    }

    pub fn distribute_fee_usdc<'info>(
        ctx: Context<'info, DistributeFeeUsdc<'info>>,
    ) -> Result<()> {
        instructions::distribute_fee_usdc::handler(ctx)
    }

    // --- Phase F: composition management (config-only) ---

    pub fn add_reserve_asset_active<'info>(
        ctx: Context<'info, AddReserveAssetActive<'info>>,
        target_weight_bps: u16,
    ) -> Result<()> {
        instructions::add_reserve_asset_active::handler(ctx, target_weight_bps)
    }

    pub fn fund_new_reserve_asset<'info>(
        ctx: Context<'info, FundNewReserveAsset<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::fund_new_reserve_asset::handler(ctx, amount)
    }

    pub fn remove_reserve_asset<'info>(
        ctx: Context<'info, RemoveReserveAsset<'info>>,
    ) -> Result<()> {
        instructions::remove_reserve_asset::handler(ctx)
    }

    // --- Phase G: wind-down lifecycle ---

    pub fn initiate_wind_down<'info>(
        ctx: Context<'info, InitiateWindDown<'info>>,
    ) -> Result<()> {
        instructions::initiate_wind_down::handler(ctx)
    }

    pub fn close_reserve<'info>(ctx: Context<'info, CloseReserve<'info>>) -> Result<()> {
        instructions::close_reserve::handler(ctx)
    }
}
