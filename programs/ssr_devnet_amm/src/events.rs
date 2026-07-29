use anchor_lang::prelude::*;

#[event]
pub struct AmmConfigInitialized {
    pub authority: Pubkey,
    pub default_fee_bps: u16,
    pub ts: i64,
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub fee_bps: u16,
    pub ts: i64,
}

#[event]
pub struct LiquidityAdded {
    pub pool: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub ts: i64,
}

#[event]
pub struct LiquidityRemoved {
    pub pool: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub ts: i64,
}

#[event]
pub struct SwapExecuted {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub a_to_b: bool,
    pub amount_in: u64,
    pub fee_amount: u64,
    pub amount_out: u64,
    pub reserve_in_after: u64,
    pub reserve_out_after: u64,
    pub ts: i64,
}

#[event]
pub struct AmmPausedEvent {
    pub paused_by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct AmmUnpausedEvent {
    pub unpaused_by: Pubkey,
    pub ts: i64,
}
