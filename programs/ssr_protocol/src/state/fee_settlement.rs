use anchor_lang::prelude::*;

/// USDC fee-settlement pipeline (2026-08-21 pass, see
/// docs/project/DECISION_LOG.md): a separate, additive PDA (NOT a field
/// grown onto `Reserve`/`FeeConfig`), matching the exact same rationale as
/// `TvlAccrual`/`ManagerFeeRecipients` before it -- no already-initialized
/// `Reserve` account on live Mainnet ever needs a realloc/migration. PDA:
/// `[FEE_SETTLEMENT_SEED, reserve.key()]`, lazily `init_if_needed` the first
/// time a Reserve's fee vault is ever credited.
///
/// Tracks two independent things, both purely in Reserve-Token-SHARE units
/// (never asset- or USDC-denominated, so this needs no price oracle):
/// 1. `protocol_shares_in_vault`/`manager_shares_in_vault` -- how much of the
///    fee vault's CURRENT real Reserve Token balance belongs to each side.
///    Crystallized (minted) here by `mint_reserve_tokens_in_kind`/
///    `accrue_fees` instead of their old instant-mint-to-destination /
///    pending-counter behavior; reduced by `redeem_fee_vault_shares` as
///    shares are burned out of the vault.
/// 2. `protocol_shares_pending_settlement`/`manager_shares_pending_settlement`
///    -- the share-weighted split RATIO to apply to whatever USDC is
///    currently sitting in the settlement staging account. Accumulated
///    (added to) by every `redeem_fee_vault_shares` call since the last
///    distribution; RESET TO ZERO by `distribute_fee_usdc` once it actually
///    moves a nonzero amount (see that instruction's own header for the
///    honest, documented reasoning: with no price oracle anywhere in this
///    protocol, there is no exact way to attribute a USDC amount that
///    resulted from a DELAYED swap of an asset staged in an earlier,
///    different-ratio redemption -- a real but bounded, fund-safe
///    imprecision, never a security issue, since money only ever reaches
///    the fixed Protocol Treasury and the Reserve's configured Manager
///    recipient(s) either way). `distribute_fee_usdc` always splits the
///    REAL current USDC balance by this ratio, never a remembered/expected
///    total, which is what keeps the whole pipeline idempotent and immune
///    to a partial/failed swap ever losing state.
#[account]
pub struct FeeSettlement {
    pub schema_version: u8,
    pub reserve: Pubkey,
    pub fee_vault_authority_bump: u8,
    pub settlement_authority_bump: u8,
    pub protocol_shares_in_vault: u64,
    pub manager_shares_in_vault: u64,
    pub protocol_shares_pending_settlement: u64,
    pub manager_shares_pending_settlement: u64,
    pub bump: u8,
}

impl FeeSettlement {
    pub const SPACE: usize = 8 // discriminator
        + 1 // schema_version
        + 32 // reserve
        + 1 // fee_vault_authority_bump
        + 1 // settlement_authority_bump
        + 8 // protocol_shares_in_vault
        + 8 // manager_shares_in_vault
        + 8 // protocol_shares_pending_settlement
        + 8 // manager_shares_pending_settlement
        + 1; // bump
}
