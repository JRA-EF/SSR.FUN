use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::common::validate_asset_mint_extensions;
use crate::constants::{
    PROTOCOL_CONFIG_SEED, RESERVE_ASSET_SEED, RESERVE_SEED, RESERVE_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveAssetInitialized;
use crate::state::{ProtocolConfig, Reserve, ReserveAsset, ReserveStatus, TokenProgramKind};

#[derive(Accounts)]
pub struct InitializeReserveAsset<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        has_one = manager @ SsrError::NotReserveManager,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        init,
        payer = manager,
        space = ReserveAsset::SPACE,
        seeds = [RESERVE_ASSET_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub reserve_asset: Account<'info, ReserveAsset>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = manager,
        seeds = [RESERVE_VAULT_SEED, reserve.key().as_ref(), asset_mint.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault_authority,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: signer-only PDA, never holds data; verified purely by seeds
    /// (bump cached on `Reserve.vault_authority_bump` at `create_reserve`
    /// time, so it's re-derived-and-checked here rather than trusted blind).
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeReserveAsset>, target_weight_bps: u16) -> Result<()> {
    let reserve = &ctx.accounts.reserve;
    require!(
        reserve.status == ReserveStatus::Created || reserve.status == ReserveStatus::AssetsInitializing,
        SsrError::UnexpectedReserveStatus
    );
    require!(
        reserve.asset_count < ctx.accounts.protocol_config.max_reserve_assets,
        SsrError::ReserveAssetLimitReached
    );
    require!(
        reserve
            .total_target_weight_bps
            .checked_add(target_weight_bps)
            .ok_or(error!(SsrError::MathOverflow))?
            <= crate::constants::BPS_DENOMINATOR,
        SsrError::TargetWeightExceedsTotal
    );

    let token_program_id = ctx.accounts.token_program.key();
    validate_asset_mint_extensions(&ctx.accounts.asset_mint.to_account_info(), &token_program_id)?;
    let token_program_kind = if token_program_id == anchor_spl::token::ID {
        TokenProgramKind::SplToken
    } else {
        TokenProgramKind::Token2022
    };

    let order_index = reserve.asset_count;
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.reserve_asset.set_inner(ReserveAsset {
        reserve: reserve.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        vault: ctx.accounts.vault.key(),
        token_program: token_program_kind,
        decimals: ctx.accounts.asset_mint.decimals,
        target_weight_bps,
        enabled: true,
        order_index,
        bump: ctx.bumps.reserve_asset,
    });

    let reserve = &mut ctx.accounts.reserve;
    reserve.asset_count = reserve
        .asset_count
        .checked_add(1)
        .ok_or(error!(SsrError::MathOverflow))?;
    reserve.total_target_weight_bps = reserve
        .total_target_weight_bps
        .checked_add(target_weight_bps)
        .ok_or(error!(SsrError::MathOverflow))?;
    reserve.configured_at = now;
    if reserve.status == ReserveStatus::Created {
        reserve.status = ReserveStatus::AssetsInitializing;
    }

    emit!(ReserveAssetInitialized {
        reserve: reserve.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        vault: ctx.accounts.vault.key(),
        target_weight_bps,
        order_index,
        ts: now,
    });

    Ok(())
}
