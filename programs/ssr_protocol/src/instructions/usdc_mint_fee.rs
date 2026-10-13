//! USDC mint fee paid at mint/seed time (DEC-0238): the shared fee leg of
//! `mint_reserve_tokens_in_kind_usdc_fee` and `seed_reserve_usdc_fee`.
//!
//! The Creator's directive: the mint fee at creation and at every mint is
//! taken in USDC and lands in the SSR Treasury (and the Manager's fee
//! recipients) automatically, in the same transaction as the mint -- not as
//! Reserve Token shares settled later by the hourly keeper.
//!
//! The program still has no price oracle, so it cannot compute what 1% of a
//! mint is worth in USDC on its own. The USDC amount is therefore quoted
//! off-chain by SSR's server and the quote is bound to the transaction by a
//! required co-signature from the configured fee quote signer (the
//! `SettlementKeeperConfig.keeper` wallet, already a server-held key). The
//! co-signature covers the whole transaction, so the signed `usdc_fee`, the
//! Reserve Token amount, the USDC mint and every destination are fixed by it.
//! What a compromised quote signer could do is bounded: it can only lower or
//! waive mint fees -- it never gains access to any vault, and every
//! destination below is still checked on-chain against fixed configuration.
//!
//! A mint without that co-signature keeps using the original
//! `mint_reserve_tokens_in_kind`/`seed_reserve`, which take the fee as
//! Reserve Token shares -- direct program callers can never mint fee-free.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use super::common::require_canonical_ata_classic;
use crate::errors::SsrError;
use crate::fee_math::{apportion_to_recipients, split_total_fee};
use crate::state::{ManagerFeeRecipients, SettlementKeeperConfig};

/// What one USDC mint-fee payment actually moved, for the event.
pub struct UsdcMintFeePaid {
    pub protocol_usdc: u64,
    pub manager_usdc: u64,
    pub manager_recipients: Vec<Pubkey>,
    pub manager_amounts: Vec<u64>,
}

/// The fee quote signer must be the configured keeper and must have signed.
pub fn require_fee_quote_signer(
    keeper_config: &SettlementKeeperConfig,
    signer: &Signer,
) -> Result<()> {
    require!(
        keeper_config.keeper != Pubkey::default(),
        SsrError::FeeSettlementKeeperNotConfigured
    );
    require_keys_eq!(signer.key(), keeper_config.keeper, SsrError::NotFeeQuoteSigner);
    Ok(())
}

/// The Reserve's `ManagerFeeRecipients`, if it has opted in. `info` is always
/// the seeds-checked PDA, so an uninitialized account genuinely means "no
/// recipients configured" and the caller cannot pick the legacy route for a
/// Reserve that has recipients.
pub fn load_manager_fee_recipients(
    info: &AccountInfo,
    program_id: &Pubkey,
) -> Result<Option<Box<ManagerFeeRecipients>>> {
    if info.owner != program_id || info.data_is_empty() {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    let recipients = ManagerFeeRecipients::try_deserialize(&mut &data[..])?;
    Ok(Some(Box::new(recipients)))
}

/// Moves `usdc_fee` from `payer_usdc` (owned by `payer`) to the Protocol
/// treasury's USDC account and the Manager fee recipients' USDC accounts,
/// split exactly like the share fee it replaces (`split_total_fee`, then
/// `apportion_to_recipients` across the Manager's recipients).
///
/// `manager_usdc_accounts` follows `distribute_fee_usdc`'s convention: one
/// canonical USDC ATA per active recipient in slot order, or -- when the
/// Reserve has no `ManagerFeeRecipients` -- exactly one, the legacy
/// `fee_destination`'s USDC ATA. Those ATAs must already exist (the client
/// bundles idempotent ATA creation first).
#[allow(clippy::too_many_arguments)]
pub fn pay_usdc_mint_fee<'info>(
    usdc_fee: u64,
    protocol_bps: u16,
    manager_bps: u16,
    payer: &AccountInfo<'info>,
    payer_usdc: &AccountInfo<'info>,
    usdc_mint: &Pubkey,
    protocol_usdc_destination: &AccountInfo<'info>,
    usdc_token_program: &Pubkey,
    manager_fee_recipients: Option<&ManagerFeeRecipients>,
    reserve_key: &Pubkey,
    legacy_fee_destination: &Pubkey,
    manager_usdc_accounts: &'info [AccountInfo<'info>],
) -> Result<UsdcMintFeePaid> {
    let effective_total_bps = (protocol_bps as u64)
        .checked_add(manager_bps as u64)
        .ok_or(error!(SsrError::MathOverflow))?;
    if effective_total_bps == 0 {
        require!(usdc_fee == 0, SsrError::UsdcMintFeeNotExpected);
        return Ok(UsdcMintFeePaid {
            protocol_usdc: 0,
            manager_usdc: 0,
            manager_recipients: Vec::new(),
            manager_amounts: Vec::new(),
        });
    }
    require!(usdc_fee > 0, SsrError::UsdcMintFeeRequired);

    let (protocol_usdc, manager_usdc) = split_total_fee(usdc_fee, protocol_bps, manager_bps)?;

    let transfer = |to: &AccountInfo<'info>, amount: u64| -> Result<()> {
        let cpi_accounts = Transfer {
            from: payer_usdc.clone(),
            to: to.clone(),
            authority: payer.clone(),
        };
        token::transfer(CpiContext::new(*usdc_token_program, cpi_accounts), amount)
    };

    if protocol_usdc > 0 {
        transfer(protocol_usdc_destination, protocol_usdc)?;
    }

    let mut manager_recipients = Vec::new();
    let mut manager_amounts = Vec::new();

    match manager_fee_recipients {
        Some(recipients_account) => {
            require_keys_eq!(
                recipients_account.reserve,
                *reserve_key,
                SsrError::ManagerFeeRecipientsMismatch
            );
            let count = recipients_account.recipient_count as usize;
            require_eq!(
                manager_usdc_accounts.len(),
                count,
                SsrError::RemainingAccountsMismatch
            );
            if manager_usdc > 0 {
                let increments = apportion_to_recipients(
                    manager_usdc,
                    &recipients_account.recipients,
                    recipients_account.recipient_count,
                )?;
                for (i, &amount) in increments.iter().enumerate().take(count) {
                    if amount == 0 {
                        continue;
                    }
                    let wallet = recipients_account.recipients[i].wallet;
                    let dest_info = &manager_usdc_accounts[i];
                    require_canonical_ata_classic(dest_info, &wallet, usdc_mint)?;
                    transfer(dest_info, amount)?;
                    manager_recipients.push(wallet);
                    manager_amounts.push(amount);
                }
            }
        }
        None => {
            require_eq!(
                manager_usdc_accounts.len(),
                1,
                SsrError::RemainingAccountsMismatch
            );
            if manager_usdc > 0 {
                let dest_info = &manager_usdc_accounts[0];
                require_canonical_ata_classic(dest_info, legacy_fee_destination, usdc_mint)?;
                transfer(dest_info, manager_usdc)?;
                manager_recipients.push(*legacy_fee_destination);
                manager_amounts.push(manager_usdc);
            }
        }
    }

    Ok(UsdcMintFeePaid {
        protocol_usdc,
        manager_usdc,
        manager_recipients,
        manager_amounts,
    })
}
