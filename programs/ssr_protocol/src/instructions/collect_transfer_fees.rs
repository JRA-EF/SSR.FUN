//! Permissionless: sweeps a Reserve Token mint's withheld transfer fees to
//! the Protocol treasury (DEC-0229).
//!
//! Token-2022 leaves each transfer's fee "withheld" in the RECEIVING token
//! account. Collection is two steps, both done here in one instruction:
//!
//! 1. Harvest: every token account passed in `remaining_accounts` has its
//!    withheld amount moved into the mint. Token-2022 allows anyone to do
//!    this and skips accounts it cannot harvest, so a stale or wrong
//!    account in the list costs nothing.
//! 2. Withdraw: everything withheld on the mint is paid to the treasury's
//!    Reserve Token account, signed by the `transfer_fee_authority` PDA.
//!
//! Anyone may call it (the keeper does, on a schedule) because no caller
//! input can change where the fees go: the destination must be the
//! canonical Token-2022 ATA of `ProtocolConfig.default_protocol_fee_destination`,
//! the same Protocol treasury every other protocol fee is paid to. The
//! caller only pays the transaction fee, plus that ATA's rent the first
//! time a mint is collected. 100% goes to the Protocol; no creator share.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::{
    self as spl_token_2022,
    extension::{transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as Token2022Mint,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::{
    PROTOCOL_CONFIG_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED, TRANSFER_FEE_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveTokenTransferFeesCollected;
use crate::state::{ProtocolConfig, Reserve};

#[derive(Accounts)]
pub struct CollectTransferFees<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        mut,
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
        mint::token_program = token_program,
    )]
    pub reserve_token_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: signer-only PDA, verified purely by seeds.
    #[account(seeds = [TRANSFER_FEE_AUTHORITY_SEED], bump)]
    pub transfer_fee_authority: UncheckedAccount<'info>,

    /// CHECK: only the ATA authority below; must equal the configured
    /// Protocol treasury, checked here so fees can never be redirected.
    #[account(
        address = protocol_config.default_protocol_fee_destination @ SsrError::TransferFeeTreasuryMismatch,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = reserve_token_mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: any number of this mint's token accounts (writable)
    // to harvest withheld fees from before withdrawing. May be empty.
}

fn withheld_on_mint(mint_info: &AccountInfo) -> Result<u64> {
    let data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
    let fee = mint
        .get_extension::<TransferFeeConfig>()
        .map_err(|_| error!(SsrError::ReserveTokenHasNoTransferFee))?;
    Ok(fee.withheld_amount.into())
}

pub fn handler<'info>(ctx: Context<'info, CollectTransferFees<'info>>) -> Result<()> {
    let mint_info = ctx.accounts.reserve_token_mint.to_account_info();
    let token_program_info = ctx.accounts.token_program.to_account_info();
    // Refuses a mint with no fee extension before any CPI.
    withheld_on_mint(&mint_info)?;

    let sources = ctx.remaining_accounts;
    if !sources.is_empty() {
        let source_keys: Vec<&Pubkey> = sources.iter().map(|a| a.key).collect();
        let ix = spl_token_2022::extension::transfer_fee::instruction::harvest_withheld_tokens_to_mint(
            &spl_token_2022::ID,
            &mint_info.key(),
            &source_keys,
        )?;
        let mut infos = Vec::with_capacity(sources.len() + 2);
        infos.push(mint_info.clone());
        infos.extend_from_slice(sources);
        infos.push(token_program_info.clone());
        invoke_signed(&ix, &infos, &[])?;
    }

    let amount = withheld_on_mint(&mint_info)?;
    if amount > 0 {
        let authority_bump = [ctx.bumps.transfer_fee_authority];
        let authority_seeds: &[&[u8]] = &[TRANSFER_FEE_AUTHORITY_SEED, &authority_bump];
        let ix =
            spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_mint(
                &spl_token_2022::ID,
                &mint_info.key(),
                &ctx.accounts.treasury_token_account.key(),
                &ctx.accounts.transfer_fee_authority.key(),
                &[],
            )?;
        invoke_signed(
            &ix,
            &[
                mint_info,
                ctx.accounts.treasury_token_account.to_account_info(),
                ctx.accounts.transfer_fee_authority.to_account_info(),
                token_program_info,
            ],
            &[authority_seeds],
        )?;
    }

    emit!(ReserveTokenTransferFeesCollected {
        reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        treasury: ctx.accounts.treasury.key(),
        treasury_token_account: ctx.accounts.treasury_token_account.key(),
        amount,
        harvested_accounts: u16::try_from(sources.len()).unwrap_or(u16::MAX),
        collected_by: ctx.accounts.payer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
