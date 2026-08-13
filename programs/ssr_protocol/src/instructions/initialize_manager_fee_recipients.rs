//! DEC-0094: opts a Reserve into multi-recipient Manager fee routing for the
//! first time. Plain `init` (not `init_if_needed`) -- this codebase's own
//! established pattern for create/mutate/remove lifecycles is separate
//! single-purpose instructions (see `add_delegate`/`update_delegate_permissions`/
//! `remove_delegate`); a second call for an already-initialized Reserve
//! fails with Anchor's standard "already in use" account error, and callers
//! should use `update_fee_recipients` instead.
//!
//! A Reserve with no `ManagerFeeRecipients` account is NOT "unmigrated" in
//! an error sense -- it simply keeps using the legacy single-destination
//! path (`fee_config.fee_destination`) indefinitely. This instruction is
//! purely an opt-in.

use anchor_lang::prelude::*;

use super::common::{require_reserve_permission, validate_fee_recipient_inputs};
use crate::constants::{MANAGER_FEE_RECIPIENTS_SEED, MAX_FEE_RECIPIENTS, RESERVE_SEED, SCHEMA_VERSION};
use crate::errors::SsrError;
use crate::events::ManagerFeeRecipientsConfigured;
use crate::state::{permission_flags, FeeRecipientInput, FeeRecipientSlot, ManagerFeeRecipients, Reserve};

#[derive(Accounts)]
pub struct InitializeManagerFeeRecipients<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        init,
        payer = payer,
        space = ManagerFeeRecipients::SPACE,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub manager_fee_recipients: Account<'info, ManagerFeeRecipients>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'info, InitializeManagerFeeRecipients<'info>>,
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

    // Opting into multi-recipient routing must not disturb any fee already
    // accrued under the legacy single-destination path -- collect it first
    // via the existing, untouched `collect_fees`.
    require!(
        ctx.accounts.reserve.fee_config.pending_manager_fee_shares == 0,
        SsrError::PendingFeesBlockRoutingChange
    );

    validate_fee_recipient_inputs(&recipients)?;

    let mut slots: [FeeRecipientSlot; MAX_FEE_RECIPIENTS as usize] = Default::default();
    for (i, r) in recipients.iter().enumerate() {
        slots[i] = FeeRecipientSlot {
            wallet: r.wallet,
            allocation_bps: r.allocation_bps,
            pending_fee_shares: 0,
            collected_fee_shares: 0,
        };
    }

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.manager_fee_recipients.set_inner(ManagerFeeRecipients {
        schema_version: SCHEMA_VERSION,
        reserve: reserve_key,
        recipient_count: recipients.len() as u8,
        recipients: slots,
        routing_updated_at: now,
        bump: ctx.bumps.manager_fee_recipients,
    });

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
