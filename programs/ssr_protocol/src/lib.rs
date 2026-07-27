//! SSR Protocol: an independent, Solana-native tokenized-reserve program.
//! Reference material only from Reserve Protocol's Folio (EVM/Solidity) --
//! see docs/protocol/RESERVE_REFERENCE_ANALYSIS.md. Not an EVM port, not
//! affiliated with Reserve Protocol.
//!
//! Terminology: Reserve, Reserve Token, Reserve Asset, Reserve Manager,
//! Reserve Factory, Reserve Vault -- see CLAUDE.md.
//!
//! UNCOMPILED NOTICE: this program was written without access to a working
//! Rust/Solana/Anchor toolchain (none was available in the environment this
//! was authored in). It targets anchor-lang/anchor-spl 1.1.2 (verified
//! current via crates.io at the time of writing) using the stable
//! `#[program]`/`#[derive(Accounts)]`/constraint DSL, which Anchor's own
//! CHANGELOG confirms was NOT part of the 1.0 breaking-change set (only
//! CLI/IDL/TS-package surfaces moved). Run `anchor build` (or `cargo
//! build-sbf`) before trusting this compiles -- see
//! docs/protocol/DEVNET_RUNBOOK.md for the exact toolchain gap and how to
//! close it.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

// PLACEHOLDER -- must be replaced with the real generated program keypair's
// pubkey (`anchor keys list` after a real `anchor build`) before any
// build/deploy. Must match Anchor.toml's [programs.*] entries.
declare_id!("SSRPro11111111111111111111111111111111111");

#[program]
pub mod ssr_protocol {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        max_reserve_assets: u8,
        default_protocol_fee_bps: u16,
        default_protocol_fee_destination: Pubkey,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(
            ctx,
            max_reserve_assets,
            default_protocol_fee_bps,
            default_protocol_fee_destination,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_reserve(
        ctx: Context<CreateReserve>,
        metadata_uri: String,
        mint_fee_bps: u16,
        redemption_fee_bps: u16,
        annual_tvl_fee_bps: u16,
        manager_fee_share_bps: u16,
        protocol_fee_share_bps: u16,
        fee_destination: Pubkey,
    ) -> Result<()> {
        instructions::create_reserve::handler(
            ctx,
            metadata_uri,
            mint_fee_bps,
            redemption_fee_bps,
            annual_tvl_fee_bps,
            manager_fee_share_bps,
            protocol_fee_share_bps,
            fee_destination,
        )
    }

    pub fn initialize_reserve_asset(ctx: Context<InitializeReserveAsset>, target_weight_bps: u16) -> Result<()> {
        instructions::initialize_reserve_asset::handler(ctx, target_weight_bps)
    }

    pub fn seed_reserve(ctx: Context<SeedReserve>, seed_amounts: Vec<u64>, initial_reserve_tokens: u64) -> Result<()> {
        instructions::seed_reserve::handler(ctx, seed_amounts, initial_reserve_tokens)
    }

    pub fn mint_reserve_tokens_in_kind(
        ctx: Context<MintReserveTokensInKind>,
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

    pub fn redeem_reserve_tokens_in_kind(
        ctx: Context<RedeemReserveTokensInKind>,
        reserve_tokens_to_redeem: u64,
        min_asset_amounts_out: Vec<u64>,
    ) -> Result<()> {
        instructions::redeem_reserve_tokens_in_kind::handler(ctx, reserve_tokens_to_redeem, min_asset_amounts_out)
    }

    pub fn update_targets(ctx: Context<UpdateTargets>, new_target_weights_bps: Vec<u16>) -> Result<()> {
        instructions::update_targets::handler(ctx, new_target_weights_bps)
    }

    pub fn add_delegate(
        ctx: Context<AddDelegate>,
        delegate_wallet: Pubkey,
        permissions: u16,
        restricted: bool,
    ) -> Result<()> {
        instructions::add_delegate::handler(ctx, delegate_wallet, permissions, restricted)
    }

    pub fn update_delegate_permissions(ctx: Context<UpdateDelegatePermissions>, new_permissions: u16) -> Result<()> {
        instructions::update_delegate_permissions::handler(ctx, new_permissions)
    }

    pub fn remove_delegate(ctx: Context<RemoveDelegate>) -> Result<()> {
        instructions::remove_delegate::handler(ctx)
    }

    pub fn transfer_reserve_manager(ctx: Context<TransferReserveManager>, new_manager: Pubkey) -> Result<()> {
        instructions::transfer_reserve_manager::handler(ctx, new_manager)
    }

    pub fn pause_reserve(ctx: Context<PauseReserve>) -> Result<()> {
        instructions::pause_reserve::handler(ctx)
    }

    pub fn unpause_reserve(ctx: Context<UnpauseReserve>) -> Result<()> {
        instructions::unpause_reserve::handler(ctx)
    }

    pub fn accrue_fees(ctx: Context<AccrueFees>) -> Result<()> {
        instructions::accrue_fees::handler(ctx)
    }

    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        instructions::collect_fees::handler(ctx)
    }

    pub fn record_rebalance(ctx: Context<RecordRebalance>, balances_before: Vec<u64>, note: String) -> Result<()> {
        instructions::record_rebalance::handler(ctx, balances_before, note)
    }

    pub fn update_metadata(ctx: Context<UpdateMetadata>, new_metadata_uri: String) -> Result<()> {
        instructions::update_metadata::handler(ctx, new_metadata_uri)
    }
}
