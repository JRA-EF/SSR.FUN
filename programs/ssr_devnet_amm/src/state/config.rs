use anchor_lang::prelude::*;

/// Singleton config for the DevNet Test AMM. See DEC-0051 for why the
/// authority reuses the existing DevNet swap-authority/manager keypair
/// (deliberate zero-new-secrets reuse, same as devUSDC's mint authority).
#[account]
pub struct AmmConfig {
    pub authority: Pubkey,
    pub default_fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

impl AmmConfig {
    pub const SPACE: usize = 8 // discriminator
        + 32 // authority
        + 2 // default_fee_bps
        + 1 // paused
        + 1; // bump
}
