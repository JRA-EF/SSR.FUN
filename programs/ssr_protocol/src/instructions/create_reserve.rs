use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::constants::{
    MAX_ANNUAL_TVL_FEE_BPS, MAX_METADATA_URI_LEN, MAX_MINT_FEE_BPS, MAX_REDEMPTION_FEE_BPS,
    MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED, RESERVE_SEED, RESERVE_TOKEN_DECIMALS,
    RESERVE_TOKEN_MINT_SEED, SCHEMA_VERSION, VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveCreated;
use crate::state::{FeeConfig, ProtocolConfig, Reserve, ReserveStatus};

#[derive(Accounts)]
pub struct CreateReserve<'info> {
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = manager,
        space = Reserve::SPACE,
        seeds = [RESERVE_SEED, protocol_config.reserve_count.to_le_bytes().as_ref()],
        bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: signer-only PDA, never holds data; verified purely by seeds.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = manager,
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        mint::decimals = RESERVE_TOKEN_DECIMALS,
        mint::authority = mint_authority,
    )]
    pub reserve_token_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `fee_destination` is the "Primary Fee Destination": the sole implicit
/// Manager fee recipient (100% of the Manager's share) unless/until the
/// creator additionally opts into `initialize_manager_fee_recipients` (bundled
/// into the same transaction when creating with >1 recipient -- see
/// `src/merge/lib/createReserveClient.ts`).
///
/// DEC-0094 removed `manager_fee_share_bps`/`protocol_fee_share_bps` as
/// caller-supplied parameters entirely: the Protocol/Manager split is no
/// longer a ratio the creator picks -- it's always derived fresh at every
/// mint/accrual from `mint_fee_bps`/`annual_tvl_fee_bps` alone via the
/// SSR.fun fee formula (see `fee_math::split_configured_bps`), applied
/// uniformly to every Reserve, old and new. The two `FeeConfig` fields of
/// the same name are kept (byte layout can never change for an
/// already-initialized account) but repurposed as program-maintained,
/// informational "last effective split" telemetry -- written by
/// `mint_reserve_tokens_in_kind`/`accrue_fees`, never read for control flow.
#[allow(clippy::too_many_arguments)]
pub fn handler<'info>(
    ctx: Context<'info, CreateReserve<'info>>,
    metadata_uri: String,
    mint_fee_bps: u16,
    redemption_fee_bps: u16,
    annual_tvl_fee_bps: u16,
    fee_destination: Pubkey,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.paused,
        SsrError::ProtocolPaused
    );
    require!(
        metadata_uri.len() <= MAX_METADATA_URI_LEN,
        SsrError::MetadataUriTooLong
    );
    require!(
        mint_fee_bps <= MAX_MINT_FEE_BPS,
        SsrError::FeeExceedsMaximum
    );
    require!(
        redemption_fee_bps <= MAX_REDEMPTION_FEE_BPS,
        SsrError::FeeExceedsMaximum
    );
    require!(
        annual_tvl_fee_bps <= MAX_ANNUAL_TVL_FEE_BPS,
        SsrError::FeeExceedsMaximum
    );

    let protocol_config = &mut ctx.accounts.protocol_config;
    let reserve_id = protocol_config.reserve_count;
    protocol_config.reserve_count = protocol_config
        .reserve_count
        .checked_add(1)
        .ok_or(error!(SsrError::MathOverflow))?;

    let now = Clock::get()?.unix_timestamp;
    let reserve_key = ctx.accounts.reserve.key();
    let (_vault_authority_key, vault_authority_bump) = Pubkey::find_program_address(
        &[VAULT_AUTHORITY_SEED, reserve_key.as_ref()],
        ctx.program_id,
    );

    ctx.accounts.reserve.set_inner(Reserve {
        schema_version: SCHEMA_VERSION,
        reserve_id,
        manager: ctx.accounts.manager.key(),
        reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        status: ReserveStatus::Created,
        asset_count: 0,
        total_target_weight_bps: 0,
        created_at: now,
        configured_at: now,
        fee_config: FeeConfig {
            mint_fee_bps,
            redemption_fee_bps,
            annual_tvl_fee_bps,
            // Repurposed telemetry (DEC-0094): populated by the first real
            // mint/accrual with the just-computed effective split, not
            // caller-chosen. 0/0 here means "not yet computed."
            manager_fee_share_bps: 0,
            protocol_fee_share_bps: 0,
            fee_destination,
            last_fee_accrual_ts: now,
            pending_manager_fee_shares: 0,
            pending_protocol_fee_shares: 0,
        },
        metadata_uri,
        delegate_count: 0,
        bump: ctx.bumps.reserve,
        vault_authority_bump,
        mint_authority_bump: ctx.bumps.mint_authority,
    });

    emit!(ReserveCreated {
        reserve: reserve_key,
        reserve_id,
        manager: ctx.accounts.manager.key(),
        reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        ts: now,
    });

    Ok(())
}
