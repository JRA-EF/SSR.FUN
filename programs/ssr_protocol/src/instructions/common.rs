//! Shared helpers used by multiple instructions: authority/delegate checks
//! and the "remaining accounts" loader used by every instruction that must
//! operate over a Reserve's full, variable-length asset list
//! (seed/mint/redeem) in one call.
//!
//! HIGH-RISK-OF-NEEDING-ADJUSTMENT NOTE: this module has not been compiled
//! or run against a live Anchor toolchain (none was available in the
//! environment this was written in -- see docs/protocol/DEVNET_RUNBOOK.md).
//! The remaining-accounts loading and generic SPL-Token/Token-2022
//! `transfer_checked` CPI pattern below is the single most intricate part of
//! the program; verify it first once `anchor build` is available.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use crate::constants::{RESERVE_ASSET_SEED, RESERVE_VAULT_SEED};
use crate::errors::SsrError;
use crate::state::{Delegate, Reserve, ReserveAsset};

/// Returns Ok(()) iff `signer` is either the Reserve's root manager, or a
/// registered `Delegate` for this Reserve holding `flag`. The root manager
/// is never represented by a maxed-out `Delegate` record -- see
/// docs/protocol/ACCOUNT_MODEL.md "Reserve Manager and delegates".
///
/// `delegate_info` is always required as an account in the instruction's
/// account list (so its address is fixed/derivable client-side), but is only
/// deserialized and checked when `signer != reserve.manager`. This avoids
/// relying on `Option<Account<'info, T>>` optional-account ergonomics, which
/// vary across Anchor versions and can't be verified without a compiler
/// here -- manual `Account::try_from` plus an explicit PDA-address check is
/// unambiguous regardless of Anchor version.
pub fn require_reserve_permission<'info>(
    reserve: &Account<'info, Reserve>,
    reserve_key: &Pubkey,
    delegate_info: &AccountInfo<'info>,
    signer: &Pubkey,
    flag: u16,
    program_id: &Pubkey,
) -> Result<()> {
    if *signer == reserve.manager {
        return Ok(());
    }

    let (expected_delegate_key, _bump) = Pubkey::find_program_address(
        &[crate::constants::DELEGATE_SEED, reserve_key.as_ref(), signer.as_ref()],
        program_id,
    );
    require_keys_eq!(expected_delegate_key, delegate_info.key(), SsrError::DelegateNotFound);

    let delegate: Account<'info, Delegate> = Account::try_from(delegate_info)
        .map_err(|_| error!(SsrError::DelegateNotFound))?;
    require_keys_eq!(delegate.reserve, *reserve_key, SsrError::DelegateNotFound);
    require_keys_eq!(delegate.wallet, *signer, SsrError::DelegateNotFound);
    require!(delegate.has_permission(flag), SsrError::DelegatePermissionDenied);

    Ok(())
}

/// Only the root Reserve Manager -- never a delegate -- may perform this
/// action (root-exclusive powers: authority transfer, unrestricted-delegate
/// grant/revoke). See docs/protocol/SSR_ARCHITECTURE.md section 7.
pub fn require_root_manager(reserve: &Account<Reserve>, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(reserve.manager, *signer, SsrError::NotReserveManager);
    Ok(())
}

/// One fully-validated Reserve Asset "leg" for a mint/redeem/seed call:
/// its config account, its vault, the depositor/redeemer's own token
/// account for this asset, and the mint (needed for `transfer_checked`'s
/// decimals argument and to determine which token program owns it).
pub struct AssetLeg<'info> {
    pub config: Account<'info, ReserveAsset>,
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: AccountInfo<'info>,
}

/// Loads and validates `reserve.asset_count` groups of 5 accounts from
/// `remaining_accounts`, in the exact `order_index` order the assets were
/// registered in (client-constructed transactions must match this order --
/// see docs/protocol/ACCOUNT_MODEL.md "ReserveAsset.order_index"). Each group
/// is `[reserve_asset, vault, owner_token_account, mint, token_program]`.
///
/// Validates, per leg: the `ReserveAsset` PDA matches the expected seeds and
/// belongs to this Reserve; the vault matches the expected PDA seeds for
/// *this* Reserve and *this* asset's mint (the concrete mechanism that makes
/// cross-Reserve vault substitution structurally impossible, per
/// docs/protocol/ACCOUNT_MODEL.md's isolation diagram); the mint matches the
/// `ReserveAsset`'s registered mint; and the owner token account's mint
/// matches too.
pub fn load_asset_legs<'info>(
    reserve: &Account<'info, Reserve>,
    reserve_key: &Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
    program_id: &Pubkey,
) -> Result<Vec<AssetLeg<'info>>> {
    let expected_count = reserve.asset_count as usize;
    require_eq!(
        remaining_accounts.len(),
        expected_count * 5,
        SsrError::RemainingAccountsMismatch
    );

    let mut legs = Vec::with_capacity(expected_count);

    for i in 0..expected_count {
        let base = i * 5;
        let reserve_asset_info = &remaining_accounts[base];
        let vault_info = &remaining_accounts[base + 1];
        let owner_token_account_info = &remaining_accounts[base + 2];
        let mint_info = &remaining_accounts[base + 3];
        let token_program_info = &remaining_accounts[base + 4];

        let config: Account<'info, ReserveAsset> = Account::try_from(reserve_asset_info)
            .map_err(|_| error!(SsrError::ReserveAssetMismatch))?;
        require_keys_eq!(config.reserve, *reserve_key, SsrError::ReserveAssetMismatch);
        require_eq!(config.order_index as usize, i, SsrError::RemainingAccountsMismatch);

        let (expected_reserve_asset_key, _) = Pubkey::find_program_address(
            &[RESERVE_ASSET_SEED, reserve_key.as_ref(), config.asset_mint.as_ref()],
            program_id,
        );
        require_keys_eq!(expected_reserve_asset_key, reserve_asset_info.key(), SsrError::ReserveAssetMismatch);

        let (expected_vault_key, _) = Pubkey::find_program_address(
            &[RESERVE_VAULT_SEED, reserve_key.as_ref(), config.asset_mint.as_ref()],
            program_id,
        );
        require_keys_eq!(expected_vault_key, vault_info.key(), SsrError::InvalidReserveVault);
        require_keys_eq!(*vault_info.key, config.vault, SsrError::InvalidReserveVault);

        let vault: InterfaceAccount<'info, TokenAccount> = InterfaceAccount::try_from(vault_info)
            .map_err(|_| error!(SsrError::InvalidReserveVault))?;
        let mint: InterfaceAccount<'info, Mint> = InterfaceAccount::try_from(mint_info)
            .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
        require_keys_eq!(mint.key(), config.asset_mint, SsrError::ReserveAssetMismatch);

        let owner_token_account: InterfaceAccount<'info, TokenAccount> =
            InterfaceAccount::try_from(owner_token_account_info)
                .map_err(|_| error!(SsrError::ReserveAssetMismatch))?;
        require_keys_eq!(owner_token_account.mint, config.asset_mint, SsrError::ReserveAssetMismatch);

        legs.push(AssetLeg {
            config,
            vault,
            owner_token_account,
            mint,
            token_program: token_program_info.clone(),
        });
    }

    Ok(legs)
}

/// Lighter-weight loader for instructions that only need to read/write each
/// `ReserveAsset` config (no vault/mint/token transfer involved) -- e.g.
/// `update_targets`. `remaining_accounts` must be exactly
/// `reserve.asset_count` `ReserveAsset` accounts, in `order_index` order.
pub fn load_reserve_asset_configs<'info>(
    reserve: &Account<'info, Reserve>,
    reserve_key: &Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
    program_id: &Pubkey,
) -> Result<Vec<Account<'info, ReserveAsset>>> {
    let expected_count = reserve.asset_count as usize;
    require_eq!(remaining_accounts.len(), expected_count, SsrError::RemainingAccountsMismatch);

    let mut configs = Vec::with_capacity(expected_count);
    for (i, account_info) in remaining_accounts.iter().enumerate() {
        let config: Account<'info, ReserveAsset> =
            Account::try_from(account_info).map_err(|_| error!(SsrError::ReserveAssetMismatch))?;
        require_keys_eq!(config.reserve, *reserve_key, SsrError::ReserveAssetMismatch);
        require_eq!(config.order_index as usize, i, SsrError::RemainingAccountsMismatch);

        let (expected_key, _) = Pubkey::find_program_address(
            &[RESERVE_ASSET_SEED, reserve_key.as_ref(), config.asset_mint.as_ref()],
            program_id,
        );
        require_keys_eq!(expected_key, account_info.key(), SsrError::ReserveAssetMismatch);

        configs.push(config);
    }
    Ok(configs)
}

/// Transfers `amount` of `leg.mint` from `leg.owner_token_account` into
/// `leg.vault`, signed by `owner` (a wallet-controlled signer -- used by
/// mint/seed, where the depositor is transferring their own tokens in).
pub fn transfer_into_vault<'info>(
    leg: &AssetLeg<'info>,
    owner: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = token_interface::TransferChecked {
        from: leg.owner_token_account.to_account_info(),
        mint: leg.mint.to_account_info(),
        to: leg.vault.to_account_info(),
        authority: owner.clone(),
    };
    let cpi_ctx = CpiContext::new(leg.token_program.clone(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, amount, leg.mint.decimals)
}

/// Transfers `amount` of `leg.mint` out of `leg.vault` to
/// `leg.owner_token_account`, signed by the Reserve's `vault_authority` PDA
/// (used by redeem). `vault_authority_seeds` must be the exact seeds for
/// this Reserve's vault authority, including the bump.
pub fn transfer_out_of_vault<'info>(
    leg: &AssetLeg<'info>,
    vault_authority: &AccountInfo<'info>,
    vault_authority_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    let cpi_accounts = token_interface::TransferChecked {
        from: leg.vault.to_account_info(),
        mint: leg.mint.to_account_info(),
        to: leg.owner_token_account.to_account_info(),
        authority: vault_authority.clone(),
    };
    let signer_seeds: &[&[&[u8]]] = &[vault_authority_seeds];
    let cpi_ctx = CpiContext::new_with_signer(leg.token_program.clone(), cpi_accounts, signer_seeds);
    token_interface::transfer_checked(cpi_ctx, amount, leg.mint.decimals)
}

/// Ceiling-division `a * b / c`, widened to u128 to avoid overflow, per the
/// mint-side rounding-direction policy adopted from the reference protocol
/// (round in the protocol's favor -- see RESERVE_REFERENCE_ANALYSIS.md
/// section 14 and DEC-0009).
pub fn mul_div_ceil(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c != 0, SsrError::DivisionByZero);
    let product = (a as u128)
        .checked_mul(b as u128)
        .ok_or(error!(SsrError::MathOverflow))?;
    let result = product
        .checked_add(c as u128 - 1)
        .ok_or(error!(SsrError::MathOverflow))?
        / (c as u128);
    u64::try_from(result).map_err(|_| error!(SsrError::MathOverflow))
}

/// Floor-division `a * b / c`, widened to u128. Redeem-side rounding
/// direction (round in the protocol's favor -- redeemer receives rounded
/// down).
pub fn mul_div_floor(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c != 0, SsrError::DivisionByZero);
    let product = (a as u128)
        .checked_mul(b as u128)
        .ok_or(error!(SsrError::MathOverflow))?;
    let result = product / (c as u128);
    u64::try_from(result).map_err(|_| error!(SsrError::MathOverflow))
}

/// UNVERIFIED -- written without a working compiler/toolchain, see the
/// module-level note at the top of this file. Rejects Token-2022 mints
/// carrying an extension SSR's balance-delta-based mint/redeem accounting
/// cannot safely handle, directly modeled on the reference protocol's
/// "Weird ERC20s" support-matrix pattern (RESERVE_REFERENCE_ANALYSIS.md
/// section 15) and DEC-0011. Classic SPL Token mints (no extension data at
/// all) always pass trivially.
///
/// Rejected extensions and why:
/// - `TransferFeeConfig` / `TransferHook`: the actual amount received by the
///   vault could differ from the amount requested, silently
///   under-collateralizing a deposit (exactly Folio's documented
///   fee-on-transfer gap).
/// - `PermanentDelegate`: would let some other address move vault tokens
///   without going through this program at all -- directly violates "no
///   operator withdrawal powers over Reserve Assets."
/// - `NonTransferable`: the vault could never move the asset out again
///   (breaks redemption entirely).
/// - `DefaultAccountState` (frozen by default): could leave a freshly
///   created vault token account frozen and unusable.
/// - `ConfidentialTransferMint`: balances aren't plainly readable, breaking
///   the balance-delta accounting this program relies on throughout.
pub fn validate_asset_mint_extensions(mint_info: &AccountInfo, token_program_id: &Pubkey) -> Result<()> {
    // Classic SPL Token mints are owned by the classic token program and
    // never carry extension TLV data -- nothing to check.
    if *token_program_id == anchor_spl::token::ID {
        return Ok(());
    }

    // Token-2022: inspect the mint's extension TLV data. This block uses the
    // `spl_token_2022` crate's extension-introspection API
    // (`StateWithExtensions`, `ExtensionType`) re-exported via
    // `anchor_spl::token_2022::spl_token_2022`. Verify these exact type/enum
    // names against the installed `spl-token-2022` version once a toolchain
    // is available -- this is the single most likely spot to need a small
    // fix (e.g. a renamed extension variant) before this compiles.
    use anchor_spl::token_2022::spl_token_2022::extension::{
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    let data = mint_info.try_borrow_data()?;
    let mint_with_extensions = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
    let extensions = mint_with_extensions
        .get_extension_types()
        .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;

    const REJECTED: [ExtensionType; 5] = [
        ExtensionType::TransferFeeConfig,
        ExtensionType::TransferHook,
        ExtensionType::PermanentDelegate,
        ExtensionType::NonTransferable,
        ExtensionType::ConfidentialTransferMint,
    ];

    for ext in extensions {
        if REJECTED.contains(&ext) {
            return Err(error!(SsrError::UnsupportedMintExtension));
        }
    }

    Ok(())
}
