//! Initial seed with the mint fee paid in USDC in the same instruction
//! (DEC-0238). Identical to `seed_reserve` except for the fee: the creator
//! receives the FULL `initial_reserve_tokens` (no fee shares, no fee vault),
//! and `usdc_fee` moves from the creator's USDC account to the Protocol
//! treasury and the Manager fee recipients. `usdc_fee` must be co-signed by
//! the fee quote signer -- see `usdc_mint_fee.rs`.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount as ClassicTokenAccount};
use anchor_spl::token_interface::{self, Mint as SplMint, MintTo, TokenInterface, TokenAccount as SplTokenAccount};

use super::accrue_fees::checkpoint_tvl_accrual;
use super::common::{load_asset_legs, transfer_into_vault};
use super::usdc_mint_fee::{load_manager_fee_recipients, pay_usdc_mint_fee, require_fee_quote_signer};
use crate::constants::{
    MANAGER_FEE_RECIPIENTS_SEED, MINT_AUTHORITY_SEED, MIN_SEED_AMOUNT_PER_ASSET,
    PROTOCOL_CONFIG_SEED, PROTOCOL_MIN_MINT_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    SETTLEMENT_KEEPER_CONFIG_SEED, TVL_ACCRUAL_SEED,
};
use crate::errors::SsrError;
use crate::events::{MintFeePaidUsdc, ReserveSeeded};
use crate::fee_math::split_configured_bps;
use crate::state::{
    ProtocolConfig, Reserve, ReserveStatus, SettlementKeeperConfig,
    TvlAccrual,
};

#[derive(Accounts)]
pub struct SeedReserveUsdcFee<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        has_one = manager @ SsrError::NotReserveManager,
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Box<Account<'info, Reserve>>,

    #[account(
        mut,
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
    )]
    pub reserve_token_mint: Box<InterfaceAccount<'info, SplMint>>,

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
        associated_token::token_program = token_program,
    )]
    pub manager_reserve_token_account: Box<InterfaceAccount<'info, SplTokenAccount>>,

    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        init_if_needed,
        payer = manager,
        space = TvlAccrual::SPACE,
        seeds = [TVL_ACCRUAL_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub tvl_accrual: Box<Account<'info, TvlAccrual>>,

    #[account(seeds = [SETTLEMENT_KEEPER_CONFIG_SEED], bump = settlement_keeper_config.bump)]
    pub settlement_keeper_config: Box<Account<'info, SettlementKeeperConfig>>,

    /// SSR's fee quote signer (the configured keeper).
    pub fee_quote_signer: Signer<'info>,

    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = manager,
        token::token_program = usdc_token_program,
    )]
    pub manager_usdc_account: Box<Account<'info, ClassicTokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = protocol_fee_destination,
        associated_token::token_program = usdc_token_program,
    )]
    pub protocol_usdc_destination: Box<Account<'info, ClassicTokenAccount>>,

    /// CHECK: only the ATA authority above; must be the Protocol treasury
    /// configured on ProtocolConfig.
    #[account(address = protocol_config.default_protocol_fee_destination @ SsrError::InvalidFeeShareSplit)]
    pub protocol_fee_destination: UncheckedAccount<'info>,

    /// CHECK: always this Reserve's ManagerFeeRecipients PDA (seeds checked).
    /// Uninitialized means the Reserve has not opted into multi-recipient
    /// routing, so the manager half goes to the legacy `fee_destination`. The
    /// program decides that from the account itself, never from the caller.
    #[account(seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()], bump)]
    pub manager_fee_recipients: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: the seed_reserve leg groups, then the Manager's
    // USDC destination ATAs -- same layout as
    // mint_reserve_tokens_in_kind_usdc_fee.
}

pub fn handler<'info>(
    ctx: Context<'info, SeedReserveUsdcFee<'info>>,
    seed_amounts: Vec<u64>,
    initial_reserve_tokens: u64,
    usdc_fee: u64,
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
    require_fee_quote_signer(
        &ctx.accounts.settlement_keeper_config,
        &ctx.accounts.fee_quote_signer,
    )?;

    let leg_account_count = ctx.accounts.reserve.asset_count as usize * 5;
    require!(
        ctx.remaining_accounts.len() >= leg_account_count,
        SsrError::RemainingAccountsMismatch
    );
    let (leg_accounts, manager_usdc_accounts) = ctx.remaining_accounts.split_at(leg_account_count);

    let reserve_key = ctx.accounts.reserve.key();
    let mut legs = load_asset_legs(&ctx.accounts.reserve, &reserve_key, leg_accounts, ctx.program_id)?;

    let mut asset_mints = Vec::with_capacity(legs.len());
    let mut asset_amounts = Vec::with_capacity(legs.len());

    for (leg, &amount) in legs.iter_mut().zip(seed_amounts.iter()) {
        require!(
            amount >= MIN_SEED_AMOUNT_PER_ASSET,
            SsrError::SeedAmountTooLow
        );
        transfer_into_vault(leg, &ctx.accounts.manager.to_account_info(), amount)?;
        leg.vault.reload()?;
        require!(leg.vault.amount > 0, SsrError::SeedAmountTooLow);
        asset_mints.push(leg.mint.key());
        asset_amounts.push(amount);
    }

    let (protocol_bps, manager_bps) = split_configured_bps(
        ctx.accounts.reserve.fee_config.mint_fee_bps,
        PROTOCOL_MIN_MINT_FEE_BPS,
    );

    let now = Clock::get()?.unix_timestamp;
    checkpoint_tvl_accrual(
        &mut ctx.accounts.tvl_accrual,
        reserve_key,
        ctx.bumps.tvl_accrual,
        0,
        now,
    )?;
    {
        let reserve = &mut ctx.accounts.reserve;
        reserve.status = ReserveStatus::Active;
        reserve.configured_at = now;
        reserve.fee_config.manager_fee_share_bps = manager_bps;
        reserve.fee_config.protocol_fee_share_bps = protocol_bps;
    }

    let recipients = load_manager_fee_recipients(
        &ctx.accounts.manager_fee_recipients.to_account_info(),
        ctx.program_id,
    )?;
    let paid = pay_usdc_mint_fee(
        usdc_fee,
        protocol_bps,
        manager_bps,
        &ctx.accounts.manager.to_account_info(),
        &ctx.accounts.manager_usdc_account.to_account_info(),
        &ctx.accounts.usdc_mint.key(),
        &ctx.accounts.protocol_usdc_destination.to_account_info(),
        &ctx.accounts.usdc_token_program.key(),
        recipients.as_deref(),
        &reserve_key,
        &ctx.accounts.reserve.fee_config.fee_destination,
        manager_usdc_accounts,
    )?;

    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[ctx.accounts.reserve.mint_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[mint_authority_seeds];
    let cpi_accounts = MintTo {
        mint: ctx.accounts.reserve_token_mint.to_account_info(),
        to: ctx.accounts.manager_reserve_token_account.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    token_interface::mint_to(
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds),
        initial_reserve_tokens,
    )?;

    emit!(MintFeePaidUsdc {
        reserve: reserve_key,
        payer: ctx.accounts.manager.key(),
        is_seed: true,
        reserve_tokens_out: initial_reserve_tokens,
        usdc_fee,
        protocol_usdc: paid.protocol_usdc,
        manager_usdc: paid.manager_usdc,
        protocol_destination: ctx.accounts.protocol_fee_destination.key(),
        manager_recipients: paid.manager_recipients,
        manager_amounts: paid.manager_amounts,
        fee_quote_signer: ctx.accounts.fee_quote_signer.key(),
        ts: now,
    });
    emit!(ReserveSeeded {
        reserve: reserve_key,
        initial_reserve_tokens,
        mint_fee_reserve_tokens: 0,
        asset_mints,
        asset_amounts,
        ts: now,
    });

    Ok(())
}
