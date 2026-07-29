//! Seed prefixes and protocol-wide constants for the DevNet Test AMM. See
//! DEC-0051 (docs/project/DECISION_LOG.md) for the full architecture and
//! security rationale -- in particular why every seed here is namespaced
//! disjointly from `ssr_protocol`'s own seeds (`reserve`, `reserve_vault`,
//! `vault_authority`, ...): that disjointness is what makes it structurally
//! impossible for this program to ever derive a valid signature for an
//! `ssr_protocol` PDA, not merely a convention.

use anchor_lang::prelude::*;

pub const AMM_CONFIG_SEED: &[u8] = b"amm_config";
pub const AMM_POOL_SEED: &[u8] = b"amm_pool";
pub const AMM_VAULT_AUTHORITY_SEED: &[u8] = b"amm_vault_authority";
pub const AMM_VAULT_SEED: &[u8] = b"amm_vault";

/// The canonical SPL wrapped-SOL mint -- identical address on every Solana
/// cluster (DevNet, Mainnet, ...). Every pool's `mint_a` must equal this
/// (enforced in `create_pool`) -- v1 is deliberately hub-and-spoke, not
/// general pairwise pools; see DEC-0051 "alternativesConsidered".
pub const WRAPPED_SOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Basis-point denominator (10_000 = 100%), matching `ssr_protocol`'s own
/// convention for consistency, even though this is an entirely separate
/// program.
pub const BPS_DENOMINATOR: u16 = 10_000;

/// Absolute ceiling on any pool's fee_bps, regardless of who configures it
/// -- a safety rail against misconfiguration, not a business decision.
pub const MAX_FEE_BPS: u16 = 1_000; // 10%
