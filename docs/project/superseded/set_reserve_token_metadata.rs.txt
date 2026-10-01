//! `set_reserve_token_metadata`: attaches (or refreshes) a Metaplex Token
//! Metadata account on a Reserve's Reserve Token mint, so wallets, explorers
//! and DEXes show the Reserve's name, symbol and picture instead of an
//! "Unknown" token. See docs/project/DECISION_LOG.md's entry for the pass
//! that added this instruction.
//!
//! Why this has to be a program instruction: the Metaplex program only lets
//! a mint's mint authority create the metadata account, and every Reserve
//! Token's mint authority is the `["mint_authority", reserve]` PDA that only
//! this program can sign for. The same PDA is installed as the metadata's
//! update authority, so later edits (a Manager renaming the Reserve or
//! changing its picture) also flow through this instruction rather than
//! through any wallet-held key.
//!
//! One instruction covers both cases: if the metadata account does not exist
//! yet it is created (`CreateMetadataAccountV3`, payer = signer); if it does,
//! its data is replaced (`UpdateMetadataAccountV2`). Callable by the Reserve's
//! root Manager, a co-manager (the on-chain `Delegate` account) holding
//! `UPDATE_METADATA`, or either protocol admin -- the admin path exists so
//! every Reserve launched before this instruction existed can be backfilled
//! without chasing each Manager's signature.
//!
//! `name`/`symbol`/`uri` are bounded by Metaplex's own limits (32/10/200
//! bytes). `uri` is expected to point at the Reserve's standard-format
//! metadata record (api/<cluster>/token-metadata) carrying the description,
//! picture and category; the on-chain `Reserve.metadata_uri` (this
//! program's own record) is untouched.

use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    self, create_metadata_accounts_v3, mpl_token_metadata::types::DataV2,
    update_metadata_accounts_v2, CreateMetadataAccountsV3, Metadata, UpdateMetadataAccountsV2,
};
use anchor_spl::token::Mint;

use super::common::require_reserve_permission;
use crate::constants::{MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED, RESERVE_SEED};
use crate::errors::SsrError;
use crate::events::ReserveTokenMetadataSet;
use crate::state::{permission_flags, ProtocolConfig, Reserve};

/// Metaplex Token Metadata's own field limits (mpl-token-metadata
/// `MAX_NAME_LENGTH` / `MAX_SYMBOL_LENGTH` / `MAX_URI_LENGTH`). Checked here
/// first so a too-long value fails with a named SSR error instead of an
/// opaque CPI failure.
pub const MAX_TOKEN_METADATA_NAME_LEN: usize = 32;
pub const MAX_TOKEN_METADATA_SYMBOL_LEN: usize = 10;
pub const MAX_TOKEN_METADATA_URI_LEN: usize = 200;

/// Seed prefix Metaplex uses for every metadata PDA: `["metadata", program, mint]`.
pub const TOKEN_METADATA_SEED: &[u8] = b"metadata";

#[derive(Accounts)]
pub struct SetReserveTokenMetadata<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
        has_one = reserve_token_mint,
    )]
    pub reserve: Account<'info, Reserve>,

    /// The Reserve Token mint. Read-only here: Metaplex reads its mint
    /// authority to authorise creation; nothing on the mint changes.
    pub reserve_token_mint: Account<'info, Mint>,

    /// CHECK: signer-only PDA (never holds data), verified purely by seeds.
    /// Signs the CPI as the mint authority on create and as the metadata
    /// update authority on both create and update.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: the Metaplex metadata PDA for `reserve_token_mint`. Its address
    /// is re-derived and compared in the handler (Metaplex's seeds live in
    /// another program, so Anchor's `seeds =` constraint can't express it);
    /// whether it already holds data decides create vs. update.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: see `common::require_reserve_permission` -- the signer's own
    /// `Delegate` PDA, only deserialized when the signer is neither the
    /// Reserve's root manager nor a protocol admin.
    pub delegate: UncheckedAccount<'info>,

    /// Pays the metadata account's rent on first creation.
    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler<'info>(
    ctx: Context<'info, SetReserveTokenMetadata<'info>>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= MAX_TOKEN_METADATA_NAME_LEN,
        SsrError::TokenMetadataNameInvalid
    );
    require!(
        !symbol.is_empty() && symbol.len() <= MAX_TOKEN_METADATA_SYMBOL_LEN,
        SsrError::TokenMetadataSymbolInvalid
    );
    require!(
        !uri.is_empty() && uri.len() <= MAX_TOKEN_METADATA_URI_LEN,
        SsrError::TokenMetadataUriInvalid
    );

    let reserve_key = ctx.accounts.reserve.key();
    let signer_key = ctx.accounts.signer.key();

    // Protocol admins may backfill any Reserve; everyone else needs the
    // Reserve's own UPDATE_METADATA permission (root manager or co-manager).
    if !ctx.accounts.protocol_config.is_admin(&signer_key) {
        require_reserve_permission(
            &ctx.accounts.reserve,
            &reserve_key,
            &ctx.accounts.delegate,
            &signer_key,
            permission_flags::UPDATE_METADATA,
            ctx.program_id,
        )?;
    }

    let mint_key = ctx.accounts.reserve_token_mint.key();
    let (expected_metadata, _) = Pubkey::find_program_address(
        &[TOKEN_METADATA_SEED, metadata::ID.as_ref(), mint_key.as_ref()],
        &metadata::ID,
    );
    require_keys_eq!(
        ctx.accounts.metadata.key(),
        expected_metadata,
        SsrError::TokenMetadataAddressMismatch
    );

    let bump = ctx.accounts.reserve.mint_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[MINT_AUTHORITY_SEED, reserve_key.as_ref(), &[bump]]];

    let data = DataV2 {
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        seller_fee_basis_points: 0,
        creators: None,
        collection: None,
        uses: None,
    };

    let created = ctx.accounts.metadata.data_is_empty();
    if created {
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.key(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.reserve_token_mint.to_account_info(),
                    mint_authority: ctx.accounts.mint_authority.to_account_info(),
                    payer: ctx.accounts.signer.to_account_info(),
                    update_authority: ctx.accounts.mint_authority.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                signer_seeds,
            ),
            data,
            true, // is_mutable: Managers can rename / re-picture later
            true, // update_authority_is_signer: the PDA signs via signer_seeds
            None,
        )?;
    } else {
        update_metadata_accounts_v2(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.key(),
                UpdateMetadataAccountsV2 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    update_authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            None,
            Some(data),
            None,
            None,
        )?;
    }

    emit!(ReserveTokenMetadataSet {
        reserve: reserve_key,
        reserve_token_mint: mint_key,
        metadata: expected_metadata,
        name,
        symbol,
        uri,
        created,
        updated_by: signer_key,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
