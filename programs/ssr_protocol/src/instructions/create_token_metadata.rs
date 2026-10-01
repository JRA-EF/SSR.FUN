//! Publishes Metaplex token metadata for a Reserve Token mint (DEC-0200).
//!
//! Why this exists. Until now the protocol created reserve token mints with
//! NO token metadata of any kind -- no Metaplex account, no Token-2022
//! metadata extension. Verified on Mainnet 2026-09-11: the metadata PDA for
//! Reserve 24's mint (AypyRkHVNBF37xvZvnS51P7j3FtUYjEDnEmLbMbH6wMC) simply
//! did not exist. That is the whole reason wallets and explorers showed a
//! raw address instead of "SOLSSR", and why the token's name and image were
//! absent from every external interface. The Reserve's own `metadata_uri`
//! field is an app-level pointer that nothing outside this app ever reads.
//!
//! Why it must be an instruction. Metaplex's CreateMetadataAccountV3 requires
//! the mint's MINT AUTHORITY to sign. Ours is the `mint_authority` PDA owned
//! by this program, so no off-chain tool -- not the manager, not an admin --
//! can ever create this account. Only the program can, by signing the CPI
//! with the PDA seeds. This is why already-deployed Reserve Tokens could not
//! be repaired without a program upgrade.
//!
//! Repairing existing Reserves is the point, not a side effect: the
//! instruction takes an existing Reserve and is safe to call on one created
//! long before this code existed. It is idempotent -- a mint that already has
//! a metadata account is left exactly as-is rather than erroring, so a
//! repair sweep can be re-run without special-casing which Reserves it
//! already covered.
//!
//! `update_authority` is set to the same PDA and is NOT made mutable here, so
//! the name/symbol/uri written at creation stand until a future instruction
//! deliberately updates them. `is_mutable` is true so that remains possible.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::Mint;

use super::common::require_reserve_permission;
use crate::constants::{MINT_AUTHORITY_SEED, RESERVE_SEED, RESERVE_TOKEN_MINT_SEED};
use crate::errors::SsrError;
use crate::events::TokenMetadataPublished;
use crate::state::{permission_flags, Reserve};

/// The Metaplex Token Metadata program. Hardcoded rather than depended on:
/// anchor-spl 1.1.2's "metadata" feature pins mpl-token-metadata
/// "=5.1.2-alpha.2" (never published), and the real 5.1.1 release compiles
/// against a different solana-account-info than anchor-lang 1.1.2, so the two
/// cannot coexist. The instruction we need is a single, long-stable wire
/// format, so we build it ourselves and keep the dependency count at zero.
/// This is the same program id whose PDA wallets and explorers look up.
pub const METAPLEX_TOKEN_METADATA_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/// Metaplex `CreateMetadataAccountV3` instruction discriminator.
const CREATE_METADATA_ACCOUNT_V3_IX: u8 = 33;

/// Borsh-encodes Metaplex's `CreateMetadataAccountV3` instruction data.
///
/// Written out byte by byte rather than derived: the three `DataV2` tail
/// fields (creators, collection, uses) and `collection_details` are always
/// `None` for a Reserve Token -- it is a proportional ownership share, not a
/// royalty-bearing NFT -- and Borsh encodes a `None` as a single 0 byte. A
/// derived struct would need placeholder types Anchor's IDL builder cannot
/// describe, for no gain. Layout, in order:
///   u8  discriminator (33)
///   str name, str symbol, str uri      (u32 LE length + UTF-8 bytes each)
///   u16 seller_fee_basis_points
///   u8  creators = None
///   u8  collection = None
///   u8  uses = None
///   u8  is_mutable
///   u8  collection_details = None
fn encode_create_metadata_v3(name: &str, symbol: &str, uri: &str, is_mutable: bool) -> Vec<u8> {
    fn push_str(buf: &mut Vec<u8>, s: &str) {
        buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
        buf.extend_from_slice(s.as_bytes());
    }
    let mut data = Vec::with_capacity(64 + name.len() + symbol.len() + uri.len());
    data.push(CREATE_METADATA_ACCOUNT_V3_IX);
    push_str(&mut data, name);
    push_str(&mut data, symbol);
    push_str(&mut data, uri);
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.push(0); // creators: None
    data.push(0); // collection: None
    data.push(0); // uses: None
    data.push(u8::from(is_mutable));
    data.push(0); // collection_details: None
    data
}

/// Metaplex's own limits for the on-chain Metadata account's inline fields.
/// Checked here so an over-long value fails with a named SSR error before the
/// CPI, rather than as an opaque Metaplex failure.
pub const MAX_TOKEN_NAME_LEN: usize = 32;
pub const MAX_TOKEN_SYMBOL_LEN: usize = 10;
pub const MAX_TOKEN_URI_LEN: usize = 200;

#[derive(Accounts)]
pub struct CreateTokenMetadata<'info> {
    #[account(
        seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Account<'info, Reserve>,

    #[account(
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
        address = reserve.reserve_token_mint,
    )]
    pub reserve_token_mint: Account<'info, Mint>,

    /// CHECK: signer-only PDA, verified by seeds against the Reserve's cached
    /// bump. This is the mint authority Metaplex requires as a signer, and the
    /// reason this can only ever be done from inside the program.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump = reserve.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: the Metaplex Metadata PDA for this mint. Its address is verified
    /// by the Metaplex program itself inside the CPI (it derives the same PDA
    /// from the mint); passed unchecked so this instruction can also inspect
    /// whether it already exists and no-op.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: see `common::require_reserve_permission`.
    pub delegate: UncheckedAccount<'info>,

    /// Pays the Metadata account's rent. Any wallet may pay; the permission
    /// check below is what gates WHO may publish.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the Metaplex Token Metadata program, pinned by address so no
    /// other program can ever be substituted here.
    #[account(address = METAPLEX_TOKEN_METADATA_PROGRAM_ID)]
    pub metadata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler<'info>(
    ctx: Context<'info, CreateTokenMetadata<'info>>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= MAX_TOKEN_NAME_LEN,
        SsrError::TokenMetadataFieldTooLong
    );
    require!(
        !symbol.is_empty() && symbol.len() <= MAX_TOKEN_SYMBOL_LEN,
        SsrError::TokenMetadataFieldTooLong
    );
    require!(
        !uri.is_empty() && uri.len() <= MAX_TOKEN_URI_LEN,
        SsrError::TokenMetadataFieldTooLong
    );

    let reserve_key = ctx.accounts.reserve.key();
    require_reserve_permission(
        &ctx.accounts.reserve,
        &reserve_key,
        &ctx.accounts.delegate,
        &ctx.accounts.payer.key(),
        permission_flags::UPDATE_METADATA,
        ctx.program_id,
    )?;

    // Idempotent: an already-published mint is left untouched. A repair sweep
    // across every existing Reserve can therefore be re-run safely, and a
    // double-submit costs only the transaction fee.
    if !ctx.accounts.metadata.data_is_empty() {
        return Ok(());
    }

    let mint_authority_seeds: &[&[u8]] = &[
        MINT_AUTHORITY_SEED,
        reserve_key.as_ref(),
        &[ctx.accounts.reserve.mint_authority_bump],
    ];
    let signer_seeds = &[mint_authority_seeds];

    // is_mutable: a manager can already rename or re-picture a Reserve
    // off-chain (update_metadata), so the on-chain record must be able to
    // follow rather than being frozen at creation.
    let data = encode_create_metadata_v3(&name, &symbol, &uri, true);

    // Account order is CreateMetadataAccountV3's, exactly: metadata, mint,
    // mint authority (signer), payer (signer), update authority, system
    // program, rent.
    let ix = Instruction {
        program_id: METAPLEX_TOKEN_METADATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.metadata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.reserve_token_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint_authority.key(), true),
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new_readonly(ctx.accounts.mint_authority.key(), true),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
        ],
        data,
    };

    invoke_signed(
        &ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.reserve_token_mint.to_account_info(),
            ctx.accounts.mint_authority.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.metadata_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    emit!(TokenMetadataPublished {
        reserve: reserve_key,
        reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        metadata: ctx.accounts.metadata.key(),
        name,
        symbol,
        uri,
        published_by: ctx.accounts.payer.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the wire format against a hand-computed expectation. If this ever
    /// drifts, every metadata account this instruction writes would be
    /// malformed, and that failure would only show up as an opaque Metaplex
    /// error on-chain -- so it is checked here instead.
    #[test]
    fn encodes_create_metadata_v3_exactly() {
        let data = encode_create_metadata_v3("Strategic Solana Reserve", "SOLSSR", "https://x", true);
        let mut expected = vec![33u8];
        expected.extend_from_slice(&24u32.to_le_bytes());
        expected.extend_from_slice(b"Strategic Solana Reserve");
        expected.extend_from_slice(&6u32.to_le_bytes());
        expected.extend_from_slice(b"SOLSSR");
        expected.extend_from_slice(&9u32.to_le_bytes());
        expected.extend_from_slice(b"https://x");
        expected.extend_from_slice(&0u16.to_le_bytes());
        expected.extend_from_slice(&[0, 0, 0, 1, 0]);
        assert_eq!(data, expected);
    }

    #[test]
    fn is_mutable_false_encodes_zero() {
        let data = encode_create_metadata_v3("n", "s", "u", false);
        assert_eq!(data[data.len() - 2], 0);
    }

    /// The Metaplex program id is the one wallets derive metadata PDAs from;
    /// a typo here would silently write to a PDA nothing reads.
    #[test]
    fn metaplex_program_id_is_canonical() {
        assert_eq!(
            METAPLEX_TOKEN_METADATA_PROGRAM_ID.to_string(),
            "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
        );
    }
}
