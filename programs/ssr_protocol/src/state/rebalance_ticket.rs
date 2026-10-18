use anchor_lang::prelude::*;

/// DEC-0250: the short-lived link between `rebalance_swap_begin` and
/// `rebalance_swap_end` inside ONE transaction. Created by begin, closed by
/// end (rent back to the signer), so it never outlives the transaction:
/// begin refuses to run unless end follows it in the same transaction, and
/// the transaction is atomic. One per Reserve at a time (seeded by the
/// Reserve), so two swaps can never interleave.
#[account]
pub struct RebalanceTicket {
    pub reserve: Pubkey,
    pub mint_sell: Pubkey,
    pub mint_buy: Pubkey,
    /// The Reserve's vault for `mint_buy` -- where end must deposit.
    pub vault_buy: Pubkey,
    /// The signer's token account for `mint_buy` the swap pays into.
    pub signer_buy_account: Pubkey,
    /// Its balance when begin ran: end deposits only what arrived after it.
    pub buy_balance_before: u64,
    pub amount_in: u64,
    /// The least `mint_buy` the vault must receive, set by SSR's quote signer.
    pub min_out: u64,
    pub bump: u8,
}

impl RebalanceTicket {
    pub const SPACE: usize = 8 + 32 * 5 + 8 * 3 + 1;
}
