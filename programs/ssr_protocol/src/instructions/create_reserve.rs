use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::token_2022::spl_token_2022::{
    self as spl_token_2022,
    extension::ExtensionType,
    state::Mint as Token2022Mint,
};
use anchor_spl::token_2022::Token2022;

use crate::constants::{
    MAX_ANNUAL_TVL_FEE_BPS, MAX_METADATA_URI_LEN, MAX_MINT_FEE_BPS, MAX_REDEMPTION_FEE_BPS,
    MINT_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED, RESERVE_SEED, RESERVE_TOKEN_DECIMALS,
    RESERVE_TOKEN_MINT_SEED, RESERVE_TOKEN_TRANSFER_FEE_LAUNCH_BPS,
    RESERVE_TOKEN_TRANSFER_FEE_MAX_FEE, SCHEMA_VERSION, TRANSFER_FEE_AUTHORITY_SEED,
    VAULT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::ReserveCreated;
use crate::state::{FeeConfig, ProtocolConfig, Reserve, ReserveStatus};

#[derive(Accounts)]
pub struct CreateReserve<'info> {
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = manager,
        space = Reserve::SPACE,
        seeds = [RESERVE_SEED, protocol_config.reserve_count.to_le_bytes().as_ref()],
        bump,
    )]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: signer-only PDA, never holds data; verified purely by seeds.
    #[account(
        seeds = [MINT_AUTHORITY_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: created and initialised in the handler as a Token-2022 mint
    /// with the transfer-fee extension (DEC-0229). Anchor's `init` cannot
    /// add that extension, so the account is allocated by hand; its address
    /// is still pinned by these seeds, so no other account can be passed.
    #[account(
        mut,
        seeds = [RESERVE_TOKEN_MINT_SEED, reserve.key().as_ref()],
        bump,
    )]
    pub reserve_token_mint: UncheckedAccount<'info>,

    /// CHECK: signer-only PDA, never holds data; verified purely by seeds.
    /// Recorded on the new mint as both its transfer-fee config authority
    /// and its withheld-fee withdraw authority, so only this program
    /// (`update_transfer_fee`, `collect_transfer_fees`) can use either.
    #[account(
        seeds = [TRANSFER_FEE_AUTHORITY_SEED],
        bump,
    )]
    pub transfer_fee_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub manager: Signer<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// `fee_destination` is the "Primary Fee Destination": the sole implicit
/// Manager fee recipient (100% of the Manager's share) unless/until the
/// creator additionally opts into `initialize_manager_fee_recipients` (bundled
/// into the same transaction when creating with >1 recipient -- see
/// `src/merge/lib/createReserveClient.ts`).
///
/// DEC-0094 removed `manager_fee_share_bps`/`protocol_fee_share_bps` as
/// caller-supplied parameters entirely: the Protocol/Manager split is no
/// longer a ratio the creator picks -- it's always derived fresh at every
/// mint/accrual from `mint_fee_bps`/`annual_tvl_fee_bps` alone via the
/// SSR.fun fee formula (see `fee_math::split_configured_bps`), applied
/// uniformly to every Reserve, old and new. The two `FeeConfig` fields of
/// the same name are kept (byte layout can never change for an
/// already-initialized account) but repurposed as program-maintained,
/// informational "last effective split" telemetry -- written by
/// `mint_reserve_tokens_in_kind`/`accrue_fees`, never read for control flow.
#[allow(clippy::too_many_arguments)]
pub fn handler<'info>(
    ctx: Context<'info, CreateReserve<'info>>,
    metadata_uri: String,
    mint_fee_bps: u16,
    redemption_fee_bps: u16,
    annual_tvl_fee_bps: u16,
    fee_destination: Pubkey,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.paused,
        SsrError::ProtocolPaused
    );
    require!(
        metadata_uri.len() <= MAX_METADATA_URI_LEN,
        SsrError::MetadataUriTooLong
    );
    require!(
        mint_fee_bps <= MAX_MINT_FEE_BPS,
        SsrError::FeeExceedsMaximum
    );
    require!(
        redemption_fee_bps <= MAX_REDEMPTION_FEE_BPS,
        SsrError::FeeExceedsMaximum
    );
    require!(
        annual_tvl_fee_bps <= MAX_ANNUAL_TVL_FEE_BPS,
        SsrError::FeeExceedsMaximum
    );

    create_reserve_token_mint(&ctx)?;

    let protocol_config = &mut ctx.accounts.protocol_config;
    let reserve_id = protocol_config.reserve_count;
    protocol_config.reserve_count = protocol_config
        .reserve_count
        .checked_add(1)
        .ok_or(error!(SsrError::MathOverflow))?;

    let now = Clock::get()?.unix_timestamp;
    let reserve_key = ctx.accounts.reserve.key();
    let (_vault_authority_key, vault_authority_bump) = Pubkey::find_program_address(
        &[VAULT_AUTHORITY_SEED, reserve_key.as_ref()],
        ctx.program_id,
    );

    ctx.accounts.reserve.set_inner(Reserve {
        schema_version: SCHEMA_VERSION,
        reserve_id,
        manager: ctx.accounts.manager.key(),
        reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        status: ReserveStatus::Created,
        asset_count: 0,
        total_target_weight_bps: 0,
        created_at: now,
        configured_at: now,
        fee_config: FeeConfig {
            mint_fee_bps,
            redemption_fee_bps,
            annual_tvl_fee_bps,
            // Repurposed telemetry (DEC-0094): populated by the first real
            // mint/accrual with the just-computed effective split, not
            // caller-chosen. 0/0 here means "not yet computed."
            manager_fee_share_bps: 0,
            protocol_fee_share_bps: 0,
            fee_destination,
            last_fee_accrual_ts: now,
            pending_manager_fee_shares: 0,
            pending_protocol_fee_shares: 0,
        },
        metadata_uri,
        delegate_count: 0,
        bump: ctx.bumps.reserve,
        vault_authority_bump,
        mint_authority_bump: ctx.bumps.mint_authority,
    });

    emit!(ReserveCreated {
        reserve: reserve_key,
        reserve_id,
        manager: ctx.accounts.manager.key(),
        reserve_token_mint: ctx.accounts.reserve_token_mint.key(),
        ts: now,
    });

    Ok(())
}

/// Allocates and initialises the Reserve Token mint as a Token-2022 mint
/// carrying the transfer-fee extension (DEC-0229).
///
/// Order is fixed by Token-2022: the account is sized for the extension,
/// the extension is initialised, and only then the base mint. Both fee
/// authorities go to the protocol-wide `transfer_fee_authority` PDA; the
/// per-transfer cap is effectively removed, so the fee is always the plain
/// percentage. No freeze authority, same as the classic mints before it.
///
/// Mirrors Anchor's own `init` handling of a pre-funded address: anyone can
/// send lamports to a predictable PDA, and a bare `create_account` would
/// then fail and block this Reserve id. Topping up, allocating and
/// assigning instead makes that griefing harmless.
fn create_reserve_token_mint<'info>(ctx: &Context<'info, CreateReserve<'info>>) -> Result<()> {
    let mint_info = ctx.accounts.reserve_token_mint.to_account_info();
    let payer_info = ctx.accounts.manager.to_account_info();
    let system_info = ctx.accounts.system_program.to_account_info();
    let token_program_info = ctx.accounts.token_program.to_account_info();

    let reserve_key = ctx.accounts.reserve.key();
    let mint_bump = [ctx.bumps.reserve_token_mint];
    let mint_seeds: &[&[u8]] = &[RESERVE_TOKEN_MINT_SEED, reserve_key.as_ref(), &mint_bump];
    let signer: &[&[&[u8]]] = &[mint_seeds];

    let space = ExtensionType::try_calculate_account_len::<Token2022Mint>(&[
        ExtensionType::TransferFeeConfig,
    ])
    .map_err(|_| error!(SsrError::MathOverflow))?;
    let rent_needed = Rent::get()?.minimum_balance(space);
    let current = mint_info.lamports();

    if current == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system_info.key(),
                system_program::CreateAccount {
                    from: payer_info.clone(),
                    to: mint_info.clone(),
                },
                signer,
            ),
            rent_needed,
            space as u64,
            &spl_token_2022::ID,
        )?;
    } else {
        require!(mint_info.data_is_empty(), SsrError::UnsupportedTokenProgram);
        if current < rent_needed {
            system_program::transfer(
                CpiContext::new(
                    system_info.key(),
                    system_program::Transfer {
                        from: payer_info.clone(),
                        to: mint_info.clone(),
                    },
                ),
                rent_needed - current,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system_info.key(),
                system_program::Allocate {
                    account_to_allocate: mint_info.clone(),
                },
                signer,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system_info.key(),
                system_program::Assign {
                    account_to_assign: mint_info.clone(),
                },
                signer,
            ),
            &spl_token_2022::ID,
        )?;
    }

    let fee_authority = ctx.accounts.transfer_fee_authority.key();
    let init_fee_ix =
        spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(
            &spl_token_2022::ID,
            &mint_info.key(),
            Some(&fee_authority),
            Some(&fee_authority),
            RESERVE_TOKEN_TRANSFER_FEE_LAUNCH_BPS,
            RESERVE_TOKEN_TRANSFER_FEE_MAX_FEE,
        )?;
    invoke_signed(
        &init_fee_ix,
        &[mint_info.clone(), token_program_info.clone()],
        &[],
    )?;

    let init_mint_ix = spl_token_2022::instruction::initialize_mint2(
        &spl_token_2022::ID,
        &mint_info.key(),
        &ctx.accounts.mint_authority.key(),
        None,
        RESERVE_TOKEN_DECIMALS,
    )?;
    invoke_signed(&init_mint_ix, &[mint_info, token_program_info], &[])?;

    Ok(())
}
