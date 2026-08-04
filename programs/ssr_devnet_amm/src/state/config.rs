use anchor_lang::prelude::*;

/// Singleton config for the DevNet Test AMM. See DEC-0051 for why the
/// authority reuses the existing DevNet swap-authority/manager keypair
/// (deliberate zero-new-secrets reuse, same as devUSDC's mint authority).
#[account]
pub struct AmmConfig {
    pub authority: Pubkey,
    /// The hub asset every pool's `mint_a` must equal (see create_pool.rs).
    /// Runtime-configured (set once at initialize_amm_config, immutable
    /// afterward) rather than a compile-time constant, so this program
    /// isn't permanently coupled to one specific mint address -- see
    /// constants.rs's header comment for why.
    pub hub_mint: Pubkey,
    pub default_fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

impl AmmConfig {
    pub const SPACE: usize = 8 // discriminator
        + 32 // authority
        + 32 // hub_mint
        + 2 // default_fee_bps
        + 1 // paused
        + 1; // bump
}
