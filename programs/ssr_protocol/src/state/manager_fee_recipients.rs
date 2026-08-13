use anchor_lang::prelude::*;

use crate::constants::MAX_FEE_RECIPIENTS;

/// Caller-supplied instruction argument for `initialize_manager_fee_recipients`
/// and `update_fee_recipients` -- one entry per desired recipient. Validated
/// by `instructions::common::validate_fee_recipient_inputs` before ever
/// being written into a [`FeeRecipientSlot`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct FeeRecipientInput {
    pub wallet: Pubkey,
    pub allocation_bps: u16,
}

/// One Manager fee recipient slot. `allocation_bps` is the recipient's share
/// of the MANAGER's pool (never of the total assessed fee -- see DEC-0094).
/// `pending_fee_shares` is combined mint-fee + TVL-fee accrual, credited at
/// accrual time (not lazily computed at collection), so a later routing
/// change can never reallocate what's already accrued to this slot.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeRecipientSlot {
    pub wallet: Pubkey,
    pub allocation_bps: u16,
    pub pending_fee_shares: u64,
    pub collected_fee_shares: u64,
}

impl FeeRecipientSlot {
    pub const SPACE: usize = 32 + 2 + 8 + 8;
}

/// Up to `MAX_FEE_RECIPIENTS` Manager fee recipients for one Reserve. A
/// separate, additive account (NOT a field grown onto `Reserve`/`FeeConfig`)
/// specifically so no already-initialized `Reserve` account on live DevNet
/// ever needs a realloc/migration -- see DEC-0094. PDA:
/// `[MANAGER_FEE_RECIPIENTS_SEED, reserve.key()]`.
///
/// Fixed-size regardless of `recipient_count`: the array is always allocated
/// at max capacity, so a future routing change (`update_fee_recipients`)
/// never needs to grow this account either. Slots at index >= recipient_count
/// are zeroed/unused.
///
/// A Reserve with no `ManagerFeeRecipients` account at all (the common case
/// immediately after this program upgrade, for every pre-existing Reserve)
/// is NOT "broken" or "not migrated" in an error sense -- it simply keeps
/// using the legacy single-destination path (`fee_config.fee_destination` /
/// `fee_config.pending_manager_fee_shares`) indefinitely, exactly as before
/// this feature existed. This account only comes into being when a Reserve's
/// manager explicitly opts in via `initialize_manager_fee_recipients`.
#[account]
pub struct ManagerFeeRecipients {
    pub schema_version: u8,
    pub reserve: Pubkey,
    /// 1..=MAX_FEE_RECIPIENTS. Slots `recipient_count..MAX_FEE_RECIPIENTS`
    /// are inactive (`Default`-zeroed) and must never be read as live.
    pub recipient_count: u8,
    pub recipients: [FeeRecipientSlot; MAX_FEE_RECIPIENTS as usize],
    /// Unix timestamp of the routing configuration currently in effect --
    /// set at `initialize_manager_fee_recipients` and every
    /// `update_fee_recipients`. Never affects already-accrued
    /// `pending_fee_shares`.
    pub routing_updated_at: i64,
    pub bump: u8,
}

impl ManagerFeeRecipients {
    pub const SPACE: usize = 8 // discriminator
        + 1 // schema_version
        + 32 // reserve
        + 1 // recipient_count
        + FeeRecipientSlot::SPACE * MAX_FEE_RECIPIENTS as usize
        + 8 // routing_updated_at
        + 1; // bump

    /// Index of `wallet` among the active (`< recipient_count`) slots, if any.
    pub fn find_recipient_index(&self, wallet: &Pubkey) -> Option<usize> {
        self.recipients[..self.recipient_count as usize]
            .iter()
            .position(|r| r.wallet == *wallet)
    }

    /// True iff every active recipient's `pending_fee_shares` is zero --
    /// the invariant that must hold before routing can be changed, so a
    /// routing change can never reallocate fees already accrued to the old
    /// configuration.
    pub fn all_pending_collected(&self) -> bool {
        self.recipients[..self.recipient_count as usize]
            .iter()
            .all(|r| r.pending_fee_shares == 0)
    }
}
