use anchor_lang::prelude::*;

use super::common::{load_reserve_asset_configs, require_reserve_permission};
use crate::constants::{BPS_DENOMINATOR, RESERVE_SEED};
use crate::errors::SsrError;
use crate::events::TargetsUpdated;
use crate::state::{permission_flags, Reserve};

/// Changes intent only -- moves nothing. See docs/protocol/SSR_ARCHITECTURE.md
/// section 0 (rebalancing is a distinct, separate step) and DEC-0017.
#[derive(Accounts)]
pub struct UpdateTargets<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: only deserialized/validated when `signer != reserve.manager`;
    /// see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
    // Remaining accounts: reserve.asset_count `ReserveAsset` accounts, in
    // order_index order. See instructions/common.rs::load_reserve_asset_configs.
}

pub fn handler<'info>(ctx: Context<'info, UpdateTargets<'info>>, new_target_weights_bps: Vec<u16>) -> Result<()> {
    ctx.accounts.reserve.require_not_paused()?;
    require_eq!(
        new_target_weights_bps.len(),
        ctx.accounts.reserve.asset_count as usize,
        SsrError::RemainingAccountsMismatch
    );

    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::UPDATE_TARGETS,
        ctx.program_id,
    )?;

    let mut configs = load_reserve_asset_configs(&ctx.accounts.reserve, &reserve_key, ctx.remaining_accounts, ctx.program_id)?;

    let mut new_total: u16 = 0;
    let mut asset_mints = Vec::with_capacity(configs.len());
    for (config, &new_weight) in configs.iter_mut().zip(new_target_weights_bps.iter()) {
        require!(config.enabled || new_weight == 0, SsrError::ReserveAssetDisabled);
        new_total = new_total.checked_add(new_weight).ok_or(error!(SsrError::MathOverflow))?;
        config.target_weight_bps = new_weight;
        asset_mints.push(config.asset_mint);
        config.exit(ctx.program_id)?;
    }
    require!(new_total <= BPS_DENOMINATOR, SsrError::TargetWeightExceedsTotal);

    let now = Clock::get()?.unix_timestamp;
    let reserve = &mut ctx.accounts.reserve;
    reserve.total_target_weight_bps = new_total;
    reserve.configured_at = now;

    emit!(TargetsUpdated {
        reserve: reserve_key,
        asset_mints,
        new_target_weights_bps,
        updated_by: ctx.accounts.signer.key(),
        ts: now,
    });

    Ok(())
}
