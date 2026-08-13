//! DEC-0094: replaces an already-migrated Reserve's Manager fee routing
//! atomically. Blocked while any CURRENT recipient still has an uncollected
//! `pending_fee_shares` balance -- the simplest invariant that makes "a
//! routing change can never reallocate already-accrued fees" airtight (no
//! by-wallet carry-forward logic for pending balances to get subtly wrong).
//! The frontend is expected to auto-bundle a "collect everyone's pending
//! balance first" step into the same signed transaction when needed (see
//! `src/merge/lib/managementClient.ts`'s `executeUpdateFeeRecipients`).
//!
//! `collected_fee_shares` (a purely informational lifetime-collected stat,
//! never fund-custody-bearing) IS carried forward by wallet identity across
//! the change, so a recipient who stays on the list (even at a different
//! slot index, or with a different allocation) doesn't lose their history.

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

    require!(
        ctx.accounts.manager_fee_recipients.all_pending_collected(),
        SsrError::PendingFeesBlockRoutingChange
    );

    validate_fee_recipient_inputs(&recipients)?;

    let old_recipients = ctx.accounts.manager_fee_recipients.recipients;
    let old_count = ctx.accounts.manager_fee_recipients.recipient_count as usize;

    let mut slots: [FeeRecipientSlot; MAX_FEE_RECIPIENTS as usize] = Default::default();
    for (i, r) in recipients.iter().enumerate() {
        let carried_collected = old_recipients[..old_count]
            .iter()
            .find(|s| s.wallet == r.wallet)
            .map(|s| s.collected_fee_shares)
            .unwrap_or(0);
        slots[i] = FeeRecipientSlot {
            wallet: r.wallet,
            allocation_bps: r.allocation_bps,
            pending_fee_shares: 0,
            collected_fee_shares: carried_collected,
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
