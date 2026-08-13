use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::constants::{
    BPS_DENOMINATOR, MAX_ANNUAL_TVL_FEE_BPS, MAX_METADATA_URI_LEN, MAX_MINT_FEE_BPS,
    MAX_REDEMPTION_FEE_BPS, MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED, RESERVE_SEED,
    RESERVE_TOKEN_DECIMALS, RESERVE_TOKEN_MINT_SEED, SCHEMA_VERSION, VAULT_AUTHORITY_SEED,
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

#[allow(clippy::too_many_arguments)]
pub fn handler<'info>(
    ctx: Context<'info, CreateReserve<'info>>,
    metadata_uri: String,
    mint_fee_bps: u16,
    redemption_fee_bps: u16,
    annual_tvl_fee_bps: u16,
    manager_fee_share_bps: u16,
    protocol_fee_share_bps: u16,
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
    require!(
        manager_fee_share_bps <= BPS_DENOMINATOR && protocol_fee_share_bps <= BPS_DENOMINATOR,
        SsrError::InvalidFeeShareSplit
    );
    // Tightened from `<= BPS_DENOMINATOR` to exactly `== BPS_DENOMINATOR`
    // (2026-08-13 corrective pass): manager_fee_share_bps/protocol_fee_share_bps
    // are presented everywhere (UI, docs, this reference) as splitting a single
    // fee between exactly two parties, with no third destination. Under the
    // old `<=` rule a Reserve could theoretically be created with a split that
    // summed to less than 100% (e.g. 4000+4000), and mint_reserve_tokens_in_kind
    // / accrue_fees would then have no principled way to allocate the
    // resulting per-recipient rounding remainder without either (a) crediting
    // it to one recipient regardless of that recipient's own share possibly
    // already being 0, or (b) letting it silently evaporate (never credited
    // to anyone) -- see mul_div_floor/exact-remainder split below. Requiring
    // the two shares to sum to exactly 100% removes that ambiguity entirely:
    // this is a strictly more conservative constraint than every real Reserve
    // already satisfies (confirmed live: every existing DevNet Reserve uses
    // either 8000/2000 or 5000/5000, both already exactly 10000), so no
    // already-created Reserve's immutable FeeConfig is affected.
    require!(
        manager_fee_share_bps
            .checked_add(protocol_fee_share_bps)
            .ok_or(error!(SsrError::MathOverflow))?
            == BPS_DENOMINATOR,
        SsrError::InvalidFeeShareSplit
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
            manager_fee_share_bps,
            protocol_fee_share_bps,
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
