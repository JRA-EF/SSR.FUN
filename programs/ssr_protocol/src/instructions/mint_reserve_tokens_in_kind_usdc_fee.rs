//! In-kind mint with the mint fee paid in USDC in the same instruction
//! (DEC-0235). Identical to `mint_reserve_tokens_in_kind` except for the fee:
//! the depositor receives the FULL `reserve_tokens_requested` (no fee shares
//! are minted, so no fee vault is touched), and `usdc_fee` moves from the
//! depositor's USDC account to the Protocol treasury and the Manager fee
//! recipients. `usdc_fee` must be co-signed by the fee quote signer -- see
//! `usdc_mint_fee.rs` for why and for what that signer can and cannot do.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount as ClassicTokenAccount};
use anchor_spl::token_interface::{self, Mint as SplMint, MintTo, TokenInterface, TokenAccount as SplTokenAccount};

use super::accrue_fees::checkpoint_tvl_accrual;
use super::common::{load_asset_legs, mul_div_ceil, transfer_into_vault};
use super::usdc_mint_fee::{pay_usdc_mint_fee, require_fee_quote_signer};
use crate::constants::{
    MANAGER_FEE_RECIPIENTS_SEED, MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED,
    PROTOCOL_MIN_MINT_FEE_BPS, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED,
    SETTLEMENT_KEEPER_CONFIG_SEED, TVL_ACCRUAL_SEED,
};
use crate::errors::SsrError;
use crate::events::{MintFeePaidUsdc, ReserveTokensMinted};
use crate::fee_math::split_configured_bps;
use crate::state::{
    ManagerFeeRecipients, ProtocolConfig, Reserve, ReserveStatus, SettlementKeeperConfig,
    TvlAccrual,
};

#[derive(Accounts)]
pub struct MintReserveTokensInKindUsdcFee<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
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
    pub reserve_token_mint: InterfaceAccount<'info, SplMint>,

    /// CHECK: signer-only PDA, verified purely by seeds against the cached bump.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_program,
    )]
    pub depositor_reserve_token_account: InterfaceAccount<'info, SplTokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = TvlAccrual::SPACE,
        seeds = [TVL_ACCRUAL_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub tvl_accrual: Account<'info, TvlAccrual>,

    #[account(seeds = [SETTLEMENT_KEEPER_CONFIG_SEED], bump = settlement_keeper_config.bump)]
    pub settlement_keeper_config: Account<'info, SettlementKeeperConfig>,

    /// SSR's fee quote signer (the configured keeper). Its signature binds
    /// `usdc_fee` and the rest of this transaction.
    pub fee_quote_signer: Signer<'info>,

    /// Real Circle USDC on Mainnet (classic SPL Token). Not hardcoded
    /// on-chain, same as `distribute_fee_usdc`; the fee quote signer only
    /// co-signs transactions that pass the genuine USDC mint.
    pub usdc_mint: Account<'info, ClassicMint>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = depositor,
        token::token_program = usdc_token_program,
    )]
    pub depositor_usdc_account: Account<'info, ClassicTokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = protocol_fee_destination,
        associated_token::token_program = usdc_token_program,
    )]
    pub protocol_usdc_destination: Account<'info, ClassicTokenAccount>,

    /// CHECK: only the ATA authority above; must be the Protocol treasury
    /// configured on ProtocolConfig.
    #[account(address = protocol_config.default_protocol_fee_destination @ SsrError::InvalidFeeShareSplit)]
    pub protocol_fee_destination: UncheckedAccount<'info>,

    /// Optional (pass the program id as None) -- same convention as
    /// `distribute_fee_usdc`.
    #[account(
        seeds = [MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts:
    //   1. reserve.asset_count groups of
    //      [reserve_asset, vault, depositor_asset_token_account, mint, token_program]
    //      in ReserveAsset.order_index order (see common.rs::load_asset_legs);
    //   2. then the Manager's USDC destination ATAs: one per active
    //      ManagerFeeRecipients slot in slot order, or exactly one (the legacy
    //      fee_destination's USDC ATA) when manager_fee_recipients is None.
}

pub fn handler<'info>(
    ctx: Context<'info, MintReserveTokensInKindUsdcFee<'info>>,
    reserve_tokens_requested: u64,
    min_reserve_tokens_out: u64,
    max_asset_amounts: Vec<u64>,
    usdc_fee: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.paused,
        SsrError::ProtocolPaused
    );
    require!(
        ctx.accounts.reserve.status == ReserveStatus::Active,
        SsrError::UnexpectedReserveStatus
    );
    require!(reserve_tokens_requested > 0, SsrError::ZeroValue);
    require!(
        reserve_tokens_requested >= min_reserve_tokens_out,
        SsrError::SlippageMinOutputNotMet
    );
    require_eq!(
        max_asset_amounts.len(),
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

    let total_supply_before = ctx.accounts.reserve_token_mint.supply;
    require!(total_supply_before > 0, SsrError::ZeroSupply);

    let reserve_key = ctx.accounts.reserve.key();
    let now = Clock::get()?.unix_timestamp;
    checkpoint_tvl_accrual(
        &mut ctx.accounts.tvl_accrual,
        reserve_key,
        ctx.bumps.tvl_accrual,
        total_supply_before,
        now,
    )?;

    let legs = load_asset_legs(&ctx.accounts.reserve, &reserve_key, leg_accounts, ctx.program_id)?;

    let mut asset_mints = Vec::with_capacity(legs.len());
    let mut asset_amounts_in = Vec::with_capacity(legs.len());

    for (i, leg) in legs.iter().enumerate() {
        let required_amount = mul_div_ceil(
            reserve_tokens_requested,
            leg.vault.amount,
            total_supply_before,
        )?;
        require!(
            required_amount <= max_asset_amounts[i],
            SsrError::SlippageMaxInputExceeded
        );
        transfer_into_vault(
            leg,
            &ctx.accounts.depositor.to_account_info(),
            required_amount,
        )?;
        asset_mints.push(leg.mint.key());
        asset_amounts_in.push(required_amount);
    }

    // Same split as the share fee this replaces (DEC-0094).
    let (protocol_bps, manager_bps) = split_configured_bps(
        ctx.accounts.reserve.fee_config.mint_fee_bps,
        PROTOCOL_MIN_MINT_FEE_BPS,
    );
    {
        let reserve = &mut ctx.accounts.reserve;
        reserve.fee_config.manager_fee_share_bps = manager_bps;
        reserve.fee_config.protocol_fee_share_bps = protocol_bps;
    }

    let paid = pay_usdc_mint_fee(
        usdc_fee,
        protocol_bps,
        manager_bps,
        &ctx.accounts.depositor.to_account_info(),
        &ctx.accounts.depositor_usdc_account.to_account_info(),
        &ctx.accounts.usdc_mint.key(),
        &ctx.accounts.protocol_usdc_destination.to_account_info(),
        &ctx.accounts.usdc_token_program.key(),
        ctx.accounts.manager_fee_recipients.as_deref(),
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
        to: ctx
            .accounts
            .depositor_reserve_token_account
            .to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    token_interface::mint_to(
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds),
        reserve_tokens_requested,
    )?;

    emit!(MintFeePaidUsdc {
        reserve: reserve_key,
        payer: ctx.accounts.depositor.key(),
        is_seed: false,
        reserve_tokens_out: reserve_tokens_requested,
        usdc_fee,
        protocol_usdc: paid.protocol_usdc,
        manager_usdc: paid.manager_usdc,
        protocol_destination: ctx.accounts.protocol_fee_destination.key(),
        manager_recipients: paid.manager_recipients,
        manager_amounts: paid.manager_amounts,
        fee_quote_signer: ctx.accounts.fee_quote_signer.key(),
        ts: now,
    });
    emit!(ReserveTokensMinted {
        reserve: reserve_key,
        depositor: ctx.accounts.depositor.key(),
        reserve_tokens_out: reserve_tokens_requested,
        mint_fee_reserve_tokens: 0,
        asset_mints,
        asset_amounts_in,
        ts: now,
    });

    Ok(())
}
