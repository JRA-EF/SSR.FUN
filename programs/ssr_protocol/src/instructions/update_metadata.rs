use anchor_lang::prelude::*;

use super::common::require_reserve_permission;
use crate::constants::{MAX_METADATA_URI_LEN, RESERVE_SEED};
use crate::errors::SsrError;
use crate::events::MetadataUpdated;
use crate::state::{permission_flags, Reserve};

#[derive(Accounts)]
pub struct UpdateMetadata<'info> {
    #[account(
        mut,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

pub fn handler<'info>(ctx: Context<'info, UpdateMetadata<'info>>, new_metadata_uri: String) -> Result<()> {
    require!(new_metadata_uri.len() <= MAX_METADATA_URI_LEN, SsrError::MetadataUriTooLong);

    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.signer.key(),
        permission_flags::UPDATE_METADATA,
        ctx.program_id,
    )?;

    ctx.accounts.reserve.metadata_uri = new_metadata_uri.clone();
    ctx.accounts.reserve.configured_at = Clock::get()?.unix_timestamp;

    emit!(MetadataUpdated {
        reserve: reserve_key,
        new_metadata_uri,
        updated_by: ctx.accounts.signer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
