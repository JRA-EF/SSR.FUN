use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, MintTo, Token, TokenAccount as SplTokenAccount};

use super::common::{credit_manager_fee_shares, load_asset_legs, mul_div_ceil, transfer_into_vault};
use crate::constants::{
    BPS_DENOMINATOR, MANAGER_FEE_RECIPIENTS_SEED, MINT_AUTHORITY_SEED, MIN_SEED_AMOUNT_PER_ASSET,
    PROTOCOL_CONFIG_SEED, PROTOCOL_MIN_MINT_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
};
use crate::errors::SsrError;
use crate::events::{ManagerFeeAccrualSource, ReserveSeeded};
use crate::fee_math::{split_configured_bps, split_total_fee};
use crate::state::{ManagerFeeRecipients, ProtocolConfig, Reserve, ReserveStatus};

#[derive(Accounts)]
pub struct SeedReserve<'info> {
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
        mut,
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
    )]
    pub reserve_token_mint: Account<'info, SplMint>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached
    /// bump from `create_reserve`.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = manager,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = manager,
    )]
    pub manager_reserve_token_account: Account<'info, SplTokenAccount>,

    #[account(mut)]
    pub manager: Signer<'info>,

    /// Optional (DEC-0094 sentinel pattern, see common::credit_manager_fee_shares):
    /// pass the program ID itself for a Reserve that hasn't opted into
    /// multi-recipient routing (the overwhelmingly common case at seed time,
    /// since seeding is the FIRST mint -- but a creator can bundle
    /// initializeManagerFeeRecipients into the same create-and-register
    /// transaction, so this must still be handled here too).
    #[account(
        mut,
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: reserve.asset_count groups of
    // [reserve_asset, vault, manager_asset_token_account, mint, token_program]
    // in ReserveAsset.order_index order. See instructions/common.rs::load_asset_legs.
}

pub fn handler<'info>(
    ctx: Context<'info, SeedReserve<'info>>,
    seed_amounts: Vec<u64>,
    initial_reserve_tokens: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.paused,
        SsrError::ProtocolPaused
    );
    require!(
        ctx.accounts.reserve.status == ReserveStatus::AssetsInitializing,
        SsrError::UnexpectedReserveStatus
    );
    require!(
        ctx.accounts.reserve.asset_count > 0,
        SsrError::UnexpectedReserveStatus
    );
    require!(initial_reserve_tokens > 0, SsrError::ZeroValue);
    require_eq!(
        seed_amounts.len(),
        ctx.accounts.reserve.asset_count as usize,
        SsrError::RemainingAccountsMismatch
    );

    let reserve_key = ctx.accounts.reserve.key();
    let mut legs = load_asset_legs(
        &ctx.accounts.reserve,
        &reserve_key,
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    let mut asset_mints = Vec::with_capacity(legs.len());
    let mut asset_amounts = Vec::with_capacity(legs.len());

    for (leg, &amount) in legs.iter_mut().zip(seed_amounts.iter()) {
        require!(
            amount >= MIN_SEED_AMOUNT_PER_ASSET,
            SsrError::SeedAmountTooLow
        );
        transfer_into_vault(leg, &ctx.accounts.manager.to_account_info(), amount)?;

        // Mirrors the reference protocol's own `initialize()` assertion
        // (Folio.sol lines 247-248): every basket asset's vault must
        // actually hold a nonzero balance before any Reserve Token is
        // minted. Reloading (rather than trusting the transfer call above
        // didn't error) is cheap insurance against a token program that
        // silently no-ops a transfer instead of erroring.
        leg.vault.reload()?;
        require!(leg.vault.amount > 0, SsrError::SeedAmountTooLow);

        asset_mints.push(leg.mint.key());
        asset_amounts.push(amount);
    }

    // The initial seed is a mint like any other -- see
    // mint_reserve_tokens_in_kind.rs's identical formula. Previously
    // fee-free (a genuine bug: the creator's own inception mint was the one
    // mint event that never generated Protocol or Manager revenue).
    // `initial_reserve_tokens` is treated as the GROSS requested amount,
    // exactly like `reserve_tokens_requested` in a normal mint; the creator
    // receives the NET amount after the fee, never the full gross figure.
    let configured_mint_fee_bps = ctx.accounts.reserve.fee_config.mint_fee_bps;
    let (protocol_bps, manager_bps) =
        split_configured_bps(configured_mint_fee_bps, PROTOCOL_MIN_MINT_FEE_BPS);
    let effective_total_bps = (protocol_bps as u64)
        .checked_add(manager_bps as u64)
        .ok_or(error!(SsrError::MathOverflow))?;
    let mint_fee_shares = mul_div_ceil(
        initial_reserve_tokens,
        effective_total_bps,
        BPS_DENOMINATOR as u64,
    )?;
    let net_shares_out = initial_reserve_tokens
        .checked_sub(mint_fee_shares)
        .ok_or(error!(SsrError::MathUnderflow))?;
    require!(net_shares_out > 0, SsrError::ZeroAmountAfterFeesOrRounding);
    let (protocol_fee_shares, manager_fee_shares) =
        split_total_fee(mint_fee_shares, protocol_bps, manager_bps)?;

    let mint_authority_bump = ctx.accounts.reserve.mint_authority_bump;
    let now = Clock::get()?.unix_timestamp;
    {
        let reserve = &mut ctx.accounts.reserve;
        reserve.status = ReserveStatus::Active;
        reserve.configured_at = now;
        reserve.fee_config.pending_protocol_fee_shares = reserve
            .fee_config
            .pending_protocol_fee_shares
            .checked_add(protocol_fee_shares)
            .ok_or(error!(SsrError::MathOverflow))?;
        // Informational telemetry only, mirroring mint_reserve_tokens_in_kind.rs.
        reserve.fee_config.manager_fee_share_bps = manager_bps;
        reserve.fee_config.protocol_fee_share_bps = protocol_bps;
    }
    credit_manager_fee_shares(
        &mut ctx.accounts.reserve,
        &mut ctx.accounts.manager_fee_recipients,
        manager_fee_shares,
        ManagerFeeAccrualSource::MintFee,
    )?;

    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[mint_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];

    let cpi_accounts = MintTo {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        to: ctx.accounts.manager_reserve_token_account.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
    token::mint_to(cpi_ctx, net_shares_out)?;

    emit!(ReserveSeeded {
        reserve: reserve_key,
        initial_reserve_tokens: net_shares_out,
        mint_fee_reserve_tokens: mint_fee_shares,
        asset_mints,
        asset_amounts,
        ts: now,
    });

    Ok(())
}
