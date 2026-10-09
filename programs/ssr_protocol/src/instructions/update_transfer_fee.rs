//! Admin-gated: changes the Token-2022 transfer fee on one Reserve Token
//! mint (DEC-0229).
//!
//! The rate lives on each mint, not in protocol state, so a protocol-wide
//! change is one of these per fee-carrying mint; several fit in a single
//! transaction. The signer that Token-2022 checks is the program's
//! `transfer_fee_authority` PDA, which only this instruction ever signs
//! for, and only up to `MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS`. Token-2022
//! itself delays every change by two epochs, so a rate can never move
//! under a trade already in flight.
//!
//! Classic SPL Token Reserves (everything created before DEC-0229) have no
//! fee to change and are refused with `ReserveTokenHasNoTransferFee`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022::{
    self as spl_token_2022,
    extension::{transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as Token2022Mint,
};
use anchor_spl::token_2022::Token2022;

use crate::constants::{
    MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS, PROTOCOL_CONFIG_SEED, RESERVE_SEED,
    RESERVE_TOKEN_MINT_SEED, RESERVE_TOKEN_TRANSFER_FEE_MAX_FEE, TRANSFER_FEE_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveTokenTransferFeeUpdated;
use crate::state::{ProtocolConfig, Reserve};

#[derive(Accounts)]
pub struct UpdateTransferFee<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        constraint = protocol_config.is_admin(&authority.key()) @ SsrError::NotProtocolAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: the Reserve's own Token-2022 mint, pinned by seeds and by the
    /// Reserve's recorded address; its extension data is parsed in the
    /// handler, and the owner check refuses a classic mint.
    #[account(
        mut,
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
        owner = spl_token_2022::ID @ SsrError::ReserveTokenHasNoTransferFee,
    )]
    pub reserve_token_mint: UncheckedAccount<'info>,

    /// CHECK: signer-only PDA, verified purely by seeds.
    #[account(seeds = [TRANSFER_FEE_AUTHORITY_SEED], bump)]
    pub transfer_fee_authority: UncheckedAccount<'info>,

    /// Either approved Protocol Admin may sign -- see `ProtocolConfig::is_admin`.
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token2022>,
}

pub fn handler<'info>(
    ctx: Context<'info, UpdateTransferFee<'info>>,
    new_transfer_fee_bps: u16,
) -> Result<()> {
    require!(
        new_transfer_fee_bps <= MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS,
        SsrError::TransferFeeExceedsMaximum
    );

    let mint_info = ctx.accounts.reserve_token_mint.to_account_info();
    let epoch = Clock::get()?.epoch;
    let old_transfer_fee_bps: u16 = {
        let data = mint_info.try_borrow_data()?;
        let mint = StateWithExtensions::<Token2022Mint>::unpack(&data)
            .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
        let fee = mint
            .get_extension::<TransferFeeConfig>()
            .map_err(|_| error!(SsrError::ReserveTokenHasNoTransferFee))?;
        fee.get_epoch_fee(epoch).transfer_fee_basis_points.into()
    };

    let authority_bump = [ctx.bumps.transfer_fee_authority];
    let authority_seeds: &[&[u8]] = &[TRANSFER_FEE_AUTHORITY_SEED, &authority_bump];

    let ix = spl_token_2022::extension::transfer_fee::instruction::set_transfer_fee(
        &spl_token_2022::ID,
        &mint_info.key(),
        &ctx.accounts.transfer_fee_authority.key(),
        &[],
        new_transfer_fee_bps,
        RESERVE_TOKEN_TRANSFER_FEE_MAX_FEE,
    )?;
    invoke_signed(
        &ix,
        &[
            mint_info,
            ctx.accounts.transfer_fee_authority.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    emit!(ReserveTokenTransferFeeUpdated {
        reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        old_transfer_fee_bps,
        new_transfer_fee_bps,
        // Token-2022 writes the new rate as effective from epoch + 2.
        effective_epoch: epoch.saturating_add(2),
        authority: ctx.accounts.authority.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
