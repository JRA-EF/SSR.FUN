//! SSR DevNet Test AMM -- a dedicated, DevNet-only, single-authority
//! constant-product swap program. Built to resolve DEC-0045 (see
//! docs/project/DECISION_LOG.md's DEC-0051 for the full architecture,
//! security invariants, alternatives considered, limitations, and Mainnet
//! migration path).
//!
//! This is NOT `ssr_protocol` (separate program ID, disjoint PDA seed
//! namespace, zero shared accounts, no CPI either direction -- see
//! DEC-0051's securityInvariants for why that isolation, not an
//! access-control check, is what makes cross-Reserve contamination and
//! manager extraction of holder-owned Reserve assets impossible). This is
//! NOT Jupiter and NOT production-ready -- it exists solely so DevNet
//! testing has a genuine, verifiable, on-chain swap primitive with real
//! liquidity and real price formation, in place of a fixed exchange rate.
//!
//! Genesis-hash-based DevNet-only enforcement happens at the application
//! layer (every client entry point calls `assertDevnetCluster` before
//! building a transaction against this program) -- see
//! `packages/sdk/src/network.ts`. Solana programs have no on-chain "which
//! cluster" syscall, so there is no on-chain equivalent; this program is
//! simply never deployed anywhere but DevNet.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use instructions::*;

// Real generated dev keypair (target/deploy/ssr_devnet_amm-keypair.json,
// NOT committed -- gitignored). DevNet-only development authority, entirely
// separate from ssr_protocol's own program ID -- see DEC-0051.
declare_id!("AJbXGWSU1x9LtJW7uRKJCwS3JZYqXwqHXpX6erY7dS6c");

#[program]
pub mod ssr_devnet_amm {
    use super::*;

    pub fn initialize_amm_config(ctx: Context<InitializeAmmConfig>, default_fee_bps: u16) -> Result<()> {
        instructions::initialize_amm_config::handler(ctx, default_fee_bps)
    }

    pub fn create_pool(ctx: Context<CreatePool>, fee_bps: u16) -> Result<()> {
        instructions::create_pool::handler(ctx, fee_bps)
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
        instructions::add_liquidity::handler(ctx, amount_a, amount_b)
    }

    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
        instructions::remove_liquidity::handler(ctx, amount_a, amount_b)
    }

    pub fn swap(ctx: Context<Swap>, amount_in: u64, minimum_amount_out: u64, a_to_b: bool) -> Result<()> {
        instructions::swap::handler(ctx, amount_in, minimum_amount_out, a_to_b)
    }

    pub fn pause_amm(ctx: Context<PauseAmm>) -> Result<()> {
        instructions::pause_amm::handler(ctx)
    }

    pub fn unpause_amm(ctx: Context<UnpauseAmm>) -> Result<()> {
        instructions::unpause_amm::handler(ctx)
    }
}
