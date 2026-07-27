use anchor_lang::prelude::*;

/// Independently-grantable delegate permission flags. See
/// docs/protocol/ACCOUNT_MODEL.md "Delegate" for the full table and
/// docs/protocol/SSR_ARCHITECTURE.md section 7 for the root-vs-delegate
/// authority boundary these flags implement.
pub mod permission_flags {
    pub const UPDATE_METADATA: u16 = 1 << 0;
    pub const UPDATE_TARGETS: u16 = 1 << 1;
    pub const INITIATE_REBALANCE: u16 = 1 << 2;
    pub const EXECUTE_REBALANCE: u16 = 1 << 3;
    pub const MANAGE_FEES: u16 = 1 << 4;
    pub const MANAGE_LIQUIDITY_CONFIG: u16 = 1 << 5;
    pub const PAUSE_RESERVE: u16 = 1 << 6;
    pub const UNPAUSE_RESERVE: u16 = 1 << 7;
    pub const ADD_RESTRICTED_DELEGATE: u16 = 1 << 8;
    pub const REMOVE_RESTRICTED_DELEGATE: u16 = 1 << 9;

    /// Bits 10-15 are reserved and must be zero in v1 -- any instruction that
    /// accepts a caller-supplied permission bitmask must mask with this and
    /// reject if any reserved bit is set, so a future flag addition can't be
    /// silently pre-granted by an old, stale-encoded value.
    pub const ALL_V1_FLAGS: u16 = UPDATE_METADATA
        | UPDATE_TARGETS
        | INITIATE_REBALANCE
        | EXECUTE_REBALANCE
        | MANAGE_FEES
        | MANAGE_LIQUIDITY_CONFIG
        | PAUSE_RESERVE
        | UNPAUSE_RESERVE
        | ADD_RESTRICTED_DELEGATE
        | REMOVE_RESTRICTED_DELEGATE;
}

/// A scoped, revocable delegate for one Reserve. See
/// docs/protocol/ACCOUNT_MODEL.md "Delegate".
#[account]
pub struct Delegate {
    pub reserve: Pubkey,
    pub wallet: Pubkey,
    pub permissions: u16,
    /// `true` for an ordinary scoped delegate; `false` only for an
    /// "unrestricted" delegate the root manager has explicitly designated
    /// (may itself add/remove *restricted* delegates, but never the
    /// root-exclusive powers -- see docs/protocol/SSR_ARCHITECTURE.md
    /// section 7).
    pub restricted: bool,
    pub added_at: i64,
    pub bump: u8,
}

impl Delegate {
    pub const SPACE: usize = 8 // discriminator
        + 32 // reserve
        + 32 // wallet
        + 2 // permissions
        + 1 // restricted
        + 8 // added_at
        + 1; // bump

    pub fn has_permission(&self, flag: u16) -> bool {
        self.permissions & flag != 0
    }
}
