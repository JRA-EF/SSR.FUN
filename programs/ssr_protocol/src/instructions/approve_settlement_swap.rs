//! USDC fee-settlement pipeline, step 2 of 3 (2026-08-21 pass, see
//! docs/project/DECISION_LOG.md): the ONLY instruction in this whole
//! pipeline that hands spending power to an off-chain actor. CPIs an SPL
//! `ApproveChecked` from `settlement_authority` (the program-controlled
//! owner of every settlement staging ATA) to the configured keeper wallet,
//! for exactly `amount` on exactly one asset's staging ATA -- never a
//! standing/unlimited approval, never more than the caller-chosen amount up
//! to that ATA's real current balance.
//!
//! **Keeper-gated**: `keeper` must equal `protocol_config.fee_settlement_keeper`
//! (set via `set_fee_settlement_keeper`) -- the one and only place in this
//! program that trusts a specific off-chain wallet with anything beyond
//! "can trigger a permissionless, fixed-destination instruction." Nothing is
//! transferred by this instruction itself; the keeper is expected to build
//! and submit an ordinary Jupiter swap transaction next, signing as the SPL
//! delegate this approval just created (the program never signs a swap,
//! matching api/mainnet/jupiter-swap.ts's "server never signs a Mainnet
//! write" convention). A failed/expired/never-attempted swap simply leaves
//! the (unspent or partially spent) staged balance in place -- nothing is
//! lost, nothing needs a rollback, and a fresh `approve_settlement_swap`
//! call safely re-approves (SPL `Approve` always sets an absolute new
//! amount, it does not add to a prior one).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use crate::constants::{RESERVE_SEED, SETTLEMENT_AUTHORITY_SEED, SETTLEMENT_KEEPER_CONFIG_SEED};
use crate::errors::SsrError;
use crate::events::SettlementSwapApproved;
use crate::state::{Reserve, SettlementKeeperConfig};

#[derive(Accounts)]
pub struct ApproveSettlementSwap<'info> {
    #[account(seeds = [SETTLEMENT_KEEPER_CONFIG_SEED], bump = settlement_keeper_config.bump)]
    pub settlement_keeper_config: Account<'info, SettlementKeeperConfig>,

    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = asset_mint,
        associated_token::authority = settlement_authority,
    )]
    pub staging_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: signer-only PDA that owns every settlement staging ATA,
    /// verified purely by seeds -- the delegate-granting authority for this
    /// CPI. `bump` is re-derived here (not cached) since this instruction
    /// doesn't otherwise touch `FeeSettlement`; a wrong bump simply fails to
    /// match the seeds constraint, same safety property either way.
    #[account(seeds = [SETTLEMENT_AUTHORITY_SEED, reserve.key().as_ref()], bump)]
    pub settlement_authority: UncheckedAccount<'info>,

    /// CHECK: only used as the delegate address for the Approve CPI below;
    /// verified against `protocol_config.fee_settlement_keeper` in the
    /// handler. Does NOT need to sign this instruction -- granting a
    /// delegate approval never requires the delegate's own signature, only
    /// the token account owner's (`settlement_authority`, a program PDA).
    pub keeper: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler<'info>(
    ctx: Context<'info, ApproveSettlementSwap<'info>>,
    amount: u64,
) -> Result<()> {
    let configured_keeper = ctx.accounts.settlement_keeper_config.keeper;
    require!(
        configured_keeper != Pubkey::default(),
        SsrError::FeeSettlementKeeperNotConfigured
    );
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        configured_keeper,
        SsrError::NotFeeSettlementKeeper
    );
    require!(amount > 0, SsrError::ZeroValue);
    require!(
        amount <= ctx.accounts.staging_ata.amount,
        SsrError::FeeSettlementInsufficientBalance
    );

    let reserve_key = ctx.accounts.reserve.key();
    let settlement_authority_bump = ctx.bumps.settlement_authority;
    let settlement_authority_seeds: &[&[u8]] = &[
        SETTLEMENT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[settlement_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[settlement_authority_seeds];

    let cpi_accounts = token_interface::ApproveChecked {
        to: ctx.accounts.staging_ata.to_account_info(),
        mint: ctx.accounts.asset_mint.to_account_info(),
        delegate: ctx.accounts.keeper.to_account_info(),
        authority: ctx.accounts.settlement_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::approve_checked(cpi_ctx, amount, ctx.accounts.asset_mint.decimals)?;

    emit!(SettlementSwapApproved {
        reserve: reserve_key,
        asset_mint: ctx.accounts.asset_mint.key(),
        amount,
        keeper: configured_keeper,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
