//! USDC fee-settlement pipeline, step 3 of 3 (2026-08-21 pass, see
//! docs/project/DECISION_LOG.md): pays out whatever USDC is CURRENTLY
//! sitting in the settlement USDC staging ATA -- never a claimed/expected
//! number, always the real on-chain balance read fresh in this same
//! instruction -- to the Protocol Treasury and the Reserve's configured
//! Manager fee recipient(s), split by `FeeSettlement`'s current
//! `protocol_shares_pending_settlement : manager_shares_pending_settlement`
//! ratio (`fee_math::split_by_weight`).
//!
//! Permissionless, same reasoning as `redeem_fee_vault_shares`/
//! `accrue_fees`/`collect_protocol_fee`: every destination is fixed and
//! on-chain-configured (`protocol_config.default_protocol_fee_destination`,
//! the Reserve's own configured Manager recipient(s)) -- a caller can
//! trigger this but never redirect it.
//!
//! Idempotent by construction: a call that finds a zero staging balance
//! (nothing new since the last distribution) is a genuine, harmless no-op --
//! it still emits `FeeUsdcDistributed` with `usdc_distributed: 0` rather
//! than erroring, since "nothing to distribute right now" is not a failure
//! condition for a permissionless, keeper-compatible instruction that may be
//! called opportunistically at any time.
//!
//! KNOWN, DELIBERATE, DOCUMENTED IMPRECISION: after a distribution that
//! moves real USDC, `protocol_shares_pending_settlement`/
//! `manager_shares_pending_settlement` are reset to 0 (never partially
//! decremented) -- there is no price oracle anywhere in this protocol, so
//! there is no exact way to know what FRACTION of "everything still owed"
//! a given USDC amount represents when some redeemed assets are still
//! sitting unswapped (e.g. no Jupiter route yet -- requirement 10). If an
//! asset's swap lands in a LATER settlement cycle, its USDC is split using
//! THAT LATER cycle's then-current ratio, not the original redemption's --
//! a real but bounded imprecision (this Reserve's configured fee split
//! rarely changes), never a fund-safety issue: money only ever reaches the
//! fixed Protocol Treasury and the Reserve's own configured Manager
//! recipient(s), in every case.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint as SplMint, Token, TokenAccount as SplTokenAccount, Transfer};

use super::common::require_canonical_ata_classic;
use crate::constants::{FEE_SETTLEMENT_SEED, PROTOCOL_CONFIG_SEED, RESERVE_SEED, SETTLEMENT_AUTHORITY_SEED};
use crate::errors::SsrError;
use crate::events::FeeUsdcDistributed;
use crate::fee_math::{apportion_to_recipients, split_by_weight};
use crate::state::{FeeSettlement, ManagerFeeRecipients, ProtocolConfig, Reserve};

#[derive(Accounts)]
pub struct DistributeFeeUsdc<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
        seeds = [FEE_SETTLEMENT_SEED, reserve.key().as_ref()],
        bump = fee_settlement.bump,
        constraint = fee_settlement.reserve == reserve.key() @ SsrError::FeeSettlementReserveMismatch,
    )]
    pub fee_settlement: Account<'info, FeeSettlement>,

    /// Real Circle USDC on Mainnet -- always the classic SPL Token program
    /// (this protocol never hardcodes this address on-chain; the caller,
    /// same as every other Mainnet write path in this app, is responsible
    /// for always passing the genuine USDC mint).
    pub usdc_mint: Account<'info, SplMint>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = settlement_authority,
    )]
    pub usdc_staging_ata: Account<'info, SplTokenAccount>,

    /// CHECK: signer-only PDA, owns every settlement staging ATA -- signs
    /// every transfer below.
    #[account(seeds = [SETTLEMENT_AUTHORITY_SEED, reserve.key().as_ref()], bump)]
    pub settlement_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = protocol_fee_destination,
    )]
    pub protocol_usdc_destination: Account<'info, SplTokenAccount>,
    /// CHECK: only used as the associated-token-account authority above;
    /// must equal `protocol_config.default_protocol_fee_destination`,
    /// checked in the handler -- the fixed, official Protocol Treasury.
    pub protocol_fee_destination: UncheckedAccount<'info>,

    /// Optional (DEC-0094 sentinel pattern): pass the program ID itself as
    /// "None" for a Reserve that hasn't opted into multi-recipient routing
    /// -- the Manager's whole USDC share then goes to the single legacy
    /// `reserve.fee_config.fee_destination`.
    #[account(
        seeds = [crate::constants::MANAGER_FEE_RECIPIENTS_SEED, reserve.key().as_ref()],
        bump = manager_fee_recipients.bump,
    )]
    pub manager_fee_recipients: Option<Account<'info, ManagerFeeRecipients>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: one USDC destination ATA per active Manager fee
    // recipient, in slot order (matching `manager_fee_recipients`'s own
    // order) -- or, when `manager_fee_recipients` is None, exactly ONE
    // account: the legacy `reserve.fee_config.fee_destination`'s USDC ATA.
    // Not `init_if_needed` here (raw remaining accounts, same convention as
    // every other asset-leg list in this program) -- the caller's
    // transaction must bundle idempotent ATA-creation instructions first.
}

pub fn handler<'info>(ctx: Context<'info, DistributeFeeUsdc<'info>>) -> Result<()> {
    let reserve_key = ctx.accounts.reserve.key();
    let usdc_available = ctx.accounts.usdc_staging_ata.amount;

    if usdc_available == 0 {
        emit!(FeeUsdcDistributed {
            reserve: reserve_key,
            usdc_distributed: 0,
            protocol_usdc: 0,
            manager_usdc: 0,
            protocol_destination: ctx.accounts.protocol_fee_destination.key(),
            manager_recipients: Vec::new(),
            manager_amounts: Vec::new(),
            distributed_by: ctx.accounts.payer.key(),
            ts: Clock::get()?.unix_timestamp,
        });
        return Ok(());
    }

    require_keys_eq!(
        ctx.accounts.protocol_fee_destination.key(),
        ctx.accounts.protocol_config.default_protocol_fee_destination,
        SsrError::InvalidFeeShareSplit
    );

    let (protocol_usdc, manager_usdc) = split_by_weight(
        usdc_available,
        ctx.accounts.fee_settlement.protocol_shares_pending_settlement,
        ctx.accounts.fee_settlement.manager_shares_pending_settlement,
    )?;

    let settlement_authority_bump = ctx.bumps.settlement_authority;
    let settlement_authority_seeds: &[&[u8]] = &[
        SETTLEMENT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[settlement_authority_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[settlement_authority_seeds];

    if protocol_usdc > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.usdc_staging_ata.to_account_info(),
            to: ctx.accounts.protocol_usdc_destination.to_account_info(),
            authority: ctx.accounts.settlement_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, protocol_usdc)?;
    }

    let usdc_mint_key = ctx.accounts.usdc_mint.key();
    let mut manager_recipients = Vec::new();
    let mut manager_amounts = Vec::new();

    if manager_usdc > 0 {
        match ctx.accounts.manager_fee_recipients.as_ref() {
            Some(recipients_account) => {
                require_keys_eq!(
                    recipients_account.reserve,
                    reserve_key,
                    SsrError::ManagerFeeRecipientsMismatch
                );
                let count = recipients_account.recipient_count as usize;
                require_eq!(
                    ctx.remaining_accounts.len(),
                    count,
                    SsrError::RemainingAccountsMismatch
                );
                let increments = apportion_to_recipients(
                    manager_usdc,
                    &recipients_account.recipients,
                    recipients_account.recipient_count,
                )?;
                for (i, &amount) in increments.iter().enumerate().take(count) {
                    if amount == 0 {
                        continue;
                    }
                    let dest_info = &ctx.remaining_accounts[i];
                    require_canonical_ata_classic(
                        dest_info,
                        &recipients_account.recipients[i].wallet,
                        &usdc_mint_key,
                    )?;
                    let dest: Account<SplTokenAccount> = Account::try_from(dest_info)
                        .map_err(|_| error!(SsrError::RemainingAccountsMismatch))?;
                    let cpi_accounts = Transfer {
                        from: ctx.accounts.usdc_staging_ata.to_account_info(),
                        to: dest.to_account_info(),
                        authority: ctx.accounts.settlement_authority.to_account_info(),
                    };
                    let cpi_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        cpi_accounts,
                        signer_seeds,
                    );
                    token::transfer(cpi_ctx, amount)?;
                    manager_recipients.push(recipients_account.recipients[i].wallet);
                    manager_amounts.push(amount);
                }
            }
            None => {
                require_eq!(
                    ctx.remaining_accounts.len(),
                    1,
                    SsrError::RemainingAccountsMismatch
                );
                let legacy_destination = ctx.accounts.reserve.fee_config.fee_destination;
                let dest_info = &ctx.remaining_accounts[0];
                require_canonical_ata_classic(dest_info, &legacy_destination, &usdc_mint_key)?;
                let dest: Account<SplTokenAccount> = Account::try_from(dest_info)
                    .map_err(|_| error!(SsrError::RemainingAccountsMismatch))?;
                let cpi_accounts = Transfer {
                    from: ctx.accounts.usdc_staging_ata.to_account_info(),
                    to: dest.to_account_info(),
                    authority: ctx.accounts.settlement_authority.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    cpi_accounts,
                    signer_seeds,
                );
                token::transfer(cpi_ctx, manager_usdc)?;
                manager_recipients.push(legacy_destination);
                manager_amounts.push(manager_usdc);
            }
        }
    }

    let fee_settlement = &mut ctx.accounts.fee_settlement;
    fee_settlement.protocol_shares_pending_settlement = 0;
    fee_settlement.manager_shares_pending_settlement = 0;

    emit!(FeeUsdcDistributed {
        reserve: reserve_key,
        usdc_distributed: usdc_available,
        protocol_usdc,
        manager_usdc,
        protocol_destination: ctx.accounts.protocol_fee_destination.key(),
        manager_recipients,
        manager_amounts,
        distributed_by: ctx.accounts.payer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
