use anchor_lang::prelude::*;

/// One hub-and-spoke pool: `mint_a` is always the canonical wrapped-SOL
/// mint (enforced in `create_pool`), `mint_b` is the paired representative
/// test asset (mockX/Y/Z or devUSDC). No LP-token mint exists -- the sole
/// liquidity authority's position is read directly from live vault
/// balances, since there is exactly one depositor by construction (see
/// DEC-0051).
#[account]
pub struct Pool {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub created_at: i64,
}

impl Pool {
    pub const SPACE: usize = 8 // discriminator
        + 32 // mint_a
        + 32 // mint_b
        + 32 // vault_a
        + 32 // vault_b
        + 2 // fee_bps
        + 1 // bump
        + 1 // vault_authority_bump
        + 8; // created_at
}
