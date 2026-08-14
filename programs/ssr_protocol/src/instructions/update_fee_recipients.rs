//! DEC-0094: replaces an already-migrated Reserve's Manager fee routing
//! atomically.
//!
//! 2026-08-14 corrective pass (see docs/project/DECISION_LOG.md): originally
//! this required EVERY current recipient's `pending_fee_shares` to be zero,
//! with the frontend auto-bundling a "collect everyone's pending balance
//! first" step into the same transaction. That bundling relied on the
//! Manager/delegate signer collecting on OTHER recipients' behalf, which is
//! exactly what claimant-only enforcement in `collect_manager_fee_share.rs`
//! (a `Signer` constraint tying the payout to the recipient's own wallet)
//! now makes impossible. So the invariant changed: `pending_fee_shares` is
//! carried forward by wallet identity for any recipient who STAYS on the
//! list (same as `collected_fee_shares` always was), and the zero-pending
//! requirement now applies ONLY to a recipient being REMOVED from the list
//! entirely -- since a removed wallet's slot ceases to exist, an uncollected
//! balance there would become permanently unreachable otherwise. A removed
//! recipient must collect its own balance first (only its own wallet can);
//! a recipient who simply stays on the list (even at a different slot
//! index, or with a different allocation) is never blocked and never loses
//! anything already accrued to it.
//!
//! `collected_fee_shares` (a purely informational lifetime-collected stat,
//! never fund-custody-bearing) is likewise carried forward by wallet
//! identity across the change.

use anchor_lang::prelude::*;

use super::common::{require_reserve_permission, validate_fee_recipient_inputs};
use crate::constants::{MANAGER_FEE_RECIPIENTS_SEED, MAX_FEE_RECIPIENTS, RESERVE_SEED};
use crate::errors::SsrError;
use crate::events::ManagerFeeRecipientsConfigured;
use crate::state::{permission_flags, FeeRecipientInput, FeeRecipientSlot, ManagerFeeRecipients, Reserve};

#[derive(Accounts)]
pub struct UpdateFeeRecipients<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
        constraint = manager_fee_recipients.reserve == reserve.key() @ SsrError::ManagerFeeRecipientsMismatch,
    )]
    pub manager_fee_recipients: Account<'info, ManagerFeeRecipients>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

pub fn handler<'info>(
    ctx: Context<'info, UpdateFeeRecipients<'info>>,
    recipients: Vec<FeeRecipientInput>,
) -> Result<()> {
    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::MANAGE_FEES,
        ctx.program_id,
    )?;

    validate_fee_recipient_inputs(&recipients)?;

    let old_recipients = ctx.accounts.manager_fee_recipients.recipients;
    let old_count = ctx.accounts.manager_fee_recipients.recipient_count as usize;

    // Any CURRENT recipient not present in the new list is being removed --
    // its slot is about to cease existing, so an uncollected balance there
    // must be zero first (only that wallet's own signature could ever
    // collect it, see collect_manager_fee_share.rs's claimant-only
    // constraint). A recipient who stays on the list is never blocked; its
    // pending balance is carried forward below instead.
    for old in old_recipients[..old_count].iter() {
        let stays = recipients.iter().any(|r| r.wallet == old.wallet);
        if !stays {
            require!(
                old.pending_fee_shares == 0,
                SsrError::PendingFeesBlockRoutingChange
            );
        }
    }

    let mut slots: [FeeRecipientSlot; MAX_FEE_RECIPIENTS as usize] = Default::default();
    for (i, r) in recipients.iter().enumerate() {
        let carried = old_recipients[..old_count].iter().find(|s| s.wallet == r.wallet);
        slots[i] = FeeRecipientSlot {
            wallet: r.wallet,
            allocation_bps: r.allocation_bps,
            pending_fee_shares: carried.map(|s| s.pending_fee_shares).unwrap_or(0),
            collected_fee_shares: carried.map(|s| s.collected_fee_shares).unwrap_or(0),
        };
    }

    let now = Clock::get()?.unix_timestamp;
    {
        let recipients_account = &mut ctx.accounts.manager_fee_recipients;
        recipients_account.recipient_count = recipients.len() as u8;
        recipients_account.recipients = slots;
        recipients_account.routing_updated_at = now;
    }

    emit!(ManagerFeeRecipientsConfigured {
        reserve: reserve_key,
        recipients: recipients.iter().map(|r| r.wallet).collect(),
        allocations_bps: recipients.iter().map(|r| r.allocation_bps).collect(),
        configured_by: ctx.accounts.signer.key(),
        routing_updated_at: now,
        ts: now,
    });

    Ok(())
}
