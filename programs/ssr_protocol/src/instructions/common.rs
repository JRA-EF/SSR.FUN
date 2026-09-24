//! Shared helpers used by multiple instructions: authority/delegate checks
//! and the "remaining accounts" loader used by every instruction that must
//! operate over a Reserve's full, variable-length asset list
//! (seed/mint/redeem) in one call.
//!
//! UPDATE: this module now compiles and links cleanly (`cargo check`/`cargo
//! build`, zero errors/warnings) against anchor-lang/anchor-spl 1.1.2 -- see
//! docs/protocol/DEVNET_RUNBOOK.md "Real compiler-caught bugs fixed this
//! session" for the actual issues the compiler found here (lifetime
//! decoupling in `require_reserve_permission`/`load_asset_legs`, the
//! `CpiContext::new` Pubkey-not-AccountInfo signature). Still NOT executed
//! against a running validator/test -- runtime CPI behavior remains
//! unverified until `cargo build-sbf`'s toolchain gap closes.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount};

use crate::constants::{
    BPS_DENOMINATOR, FEE_VAULT_AUTHORITY_SEED, MAX_FEE_RECIPIENTS, RESERVE_ASSET_SEED,
    RESERVE_VAULT_SEED, SCHEMA_VERSION, SETTLEMENT_AUTHORITY_SEED,
};
use crate::errors::SsrError;
use crate::events::{ManagerFeeAccrualSource, ManagerFeeShareAccrued};
use crate::fee_math::apportion_to_recipients;
use crate::state::{Delegate, FeeRecipientInput, FeeSettlement, ManagerFeeRecipients, Reserve, ReserveAsset};

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
///
/// Takes `delegate_info: &'info AccountInfo<'info>` -- callers pass
/// `&ctx.accounts.delegate` directly (NOT `.to_account_info()`, which clones
/// into a fresh, short-lived owned value): `UncheckedAccount<'info>` is
/// defined as `struct UncheckedAccount<'info>(&'info AccountInfo<'info>)`
/// (anchor-lang 1.1.2, `accounts/unchecked_account.rs`) and derefs to it, so
/// `&ctx.accounts.delegate` deref-coerces straight to the *original*
/// `&'info AccountInfo<'info>` reborrowed through `ctx.accounts: &'info mut
/// T` -- genuinely `'info`-lived, unlike a fresh clone.
/// Note: `reserve` and `delegate_info` deliberately use INDEPENDENT lifetime
/// parameters (`'r`, `'d`) rather than a single shared `'info`. The function
/// only reads `reserve.manager` (a `Pubkey`, no lifetime entanglement) and
/// builds a fresh `Account<'d, Delegate>` purely from `delegate_info` -- there
/// is no reason to force the two reborrows (each independently inferred at
/// the call site, from two different fields of `ctx.accounts`) into a single
/// shared lifetime, and doing so is exactly what caused
/// "lifetime may not live long enough" errors here before this fix, since
/// `Account`/`AccountInfo` are invariant over their lifetime parameter.
/// Initialise a `FeeSettlement` account's IDENTITY fields the first time it is
/// touched. `init_if_needed` zero-fills a freshly-created account, and the
/// crediting instructions (mint/accrue) only ever wrote the two share
/// counters -- so `reserve` and the three bumps stayed `Pubkey::default()`/0
/// forever. That left `redeem_fee_vault_shares` and `distribute_fee_usdc`
/// UNABLE to run at all: their `constraint = fee_settlement.reserve == reserve`
/// and `bump = fee_settlement.*_bump` checks compared against zeroed fields.
/// Fees would crystallise into the vault and be permanently stranded, and any
/// Reserve that ever minted could never be closed (its fee-vault shares keep
/// supply != 0). This makes the crediting instructions self-initialise the
/// identity fields exactly once, idempotently -- see DEC-0133/DEC-0173.
///
/// Idempotent: returns immediately once `reserve` is set, so repeated
/// mint/accrue calls after the first are a no-op here.
pub fn init_fee_settlement_if_needed(
    fee_settlement: &mut Account<FeeSettlement>,
    reserve: Pubkey,
    bump: u8,
    program_id: &Pubkey,
) -> Result<()> {
    if fee_settlement.reserve != Pubkey::default() {
        return Ok(());
    }
    let (_, fee_vault_authority_bump) =
        Pubkey::find_program_address(&[FEE_VAULT_AUTHORITY_SEED, reserve.as_ref()], program_id);
    let (_, settlement_authority_bump) =
        Pubkey::find_program_address(&[SETTLEMENT_AUTHORITY_SEED, reserve.as_ref()], program_id);
    apply_fee_settlement_identity(
        fee_settlement,
        reserve,
        fee_vault_authority_bump,
        settlement_authority_bump,
        bump,
    );
    Ok(())
}

/// Pure identity-field writer, split out of `init_fee_settlement_if_needed` so
/// the "set exactly these fields, only when uninitialised" behaviour is
/// unit-testable without a runtime `Account`/validator. Idempotent: a no-op
/// once `reserve` is set. Returns true iff it actually initialised.
pub fn apply_fee_settlement_identity(
    fs: &mut FeeSettlement,
    reserve: Pubkey,
    fee_vault_authority_bump: u8,
    settlement_authority_bump: u8,
    bump: u8,
) -> bool {
    if fs.reserve != Pubkey::default() {
        return false;
    }
    fs.schema_version = SCHEMA_VERSION;
    fs.reserve = reserve;
    fs.fee_vault_authority_bump = fee_vault_authority_bump;
    fs.settlement_authority_bump = settlement_authority_bump;
    fs.bump = bump;
    true
}

#[cfg(test)]
mod fee_settlement_init_tests {
    use super::apply_fee_settlement_identity;
    use crate::constants::SCHEMA_VERSION;
    use crate::state::FeeSettlement;
    use anchor_lang::prelude::Pubkey;

    fn zeroed() -> FeeSettlement {
        FeeSettlement {
            schema_version: 0,
            reserve: Pubkey::default(),
            fee_vault_authority_bump: 0,
            settlement_authority_bump: 0,
            protocol_shares_in_vault: 0,
            manager_shares_in_vault: 0,
            protocol_shares_pending_settlement: 0,
            manager_shares_pending_settlement: 0,
            bump: 0,
        }
    }

    #[test]
    fn initialises_identity_fields_on_first_touch() {
        // The P1-1 bug: crediting instructions left these fields zeroed, so
        // redeem_fee_vault_shares / distribute_fee_usdc could never satisfy
        // their `fee_settlement.reserve == reserve` and `bump = *_bump`
        // constraints. After this, they are populated.
        let mut fs = zeroed();
        let reserve = Pubkey::new_unique();
        let did = apply_fee_settlement_identity(&mut fs, reserve, 251, 252, 253);
        assert!(did, "should initialise a zeroed account");
        assert_eq!(fs.reserve, reserve);
        assert_eq!(fs.fee_vault_authority_bump, 251);
        assert_eq!(fs.settlement_authority_bump, 252);
        assert_eq!(fs.bump, 253);
        assert_eq!(fs.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn is_idempotent_and_never_overwrites_an_initialised_account() {
        let mut fs = zeroed();
        let reserve = Pubkey::new_unique();
        apply_fee_settlement_identity(&mut fs, reserve, 251, 252, 253);
        // simulate later credits accumulating shares
        fs.protocol_shares_in_vault = 1_000;
        fs.manager_shares_in_vault = 500;
        // a second touch (e.g. next mint) must NOT reset identity or shares
        let did = apply_fee_settlement_identity(&mut fs, Pubkey::new_unique(), 9, 9, 9);
        assert!(!did, "must be a no-op once initialised");
        assert_eq!(fs.reserve, reserve, "reserve must not be overwritten");
        assert_eq!(fs.fee_vault_authority_bump, 251);
        assert_eq!(fs.protocol_shares_in_vault, 1_000, "shares untouched");
        assert_eq!(fs.manager_shares_in_vault, 500);
    }
}

pub fn require_reserve_permission<'r, 'd>(
    reserve: &Account<'r, Reserve>,
    reserve_key: &Pubkey,
    delegate_info: &'d AccountInfo<'d>,
    signer: &Pubkey,
    flag: u16,
    program_id: &Pubkey,
) -> Result<()> {
    if *signer == reserve.manager {
        return Ok(());
    }

    let (expected_delegate_key, _bump) = Pubkey::find_program_address(
        &[
            crate::constants::DELEGATE_SEED,
            reserve_key.as_ref(),
            signer.as_ref(),
        ],
        program_id,
    );
    require_keys_eq!(
        expected_delegate_key,
        delegate_info.key(),
        SsrError::DelegateNotFound
    );

    let delegate = Account::<Delegate>::try_from(delegate_info)
        .map_err(|_| error!(SsrError::DelegateNotFound))?;
    require_keys_eq!(delegate.reserve, *reserve_key, SsrError::DelegateNotFound);
    require_keys_eq!(delegate.wallet, *signer, SsrError::DelegateNotFound);
    require!(
        delegate.has_permission(flag),
        SsrError::DelegatePermissionDenied
    );

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
    /// The token program's own ID -- `CpiContext::new`/`new_with_signer` take
    /// the program ID directly (Anchor 1.0 removed the program `AccountInfo`
    /// from `CpiContext`; see anchor-lang 1.1.2's `context.rs`), so there is
    /// no need to hold onto the `AccountInfo` itself here.
    pub token_program: Pubkey,
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
/// Note: `reserve`'s lifetime (`'r`) is independent of `remaining_accounts`'s
/// (`'info`, which the returned `Vec<AssetLeg<'info>>` is actually built
/// from) -- see the note on `require_reserve_permission` above for why
/// forcing these into one shared lifetime causes spurious borrow-checker
/// errors despite being sound.
pub fn load_asset_legs<'r, 'info>(
    reserve: &Account<'r, Reserve>,
    reserve_key: &Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
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
        require_eq!(
            config.order_index as usize,
            i,
            SsrError::RemainingAccountsMismatch
        );

        let (expected_reserve_asset_key, _) = Pubkey::find_program_address(
            &[
                RESERVE_ASSET_SEED,
                reserve_key.as_ref(),
                config.asset_mint.as_ref(),
            ],
            program_id,
        );
        require_keys_eq!(
            expected_reserve_asset_key,
            reserve_asset_info.key(),
            SsrError::ReserveAssetMismatch
        );

        let (expected_vault_key, _) = Pubkey::find_program_address(
            &[
                RESERVE_VAULT_SEED,
                reserve_key.as_ref(),
                config.asset_mint.as_ref(),
            ],
            program_id,
        );
        require_keys_eq!(
            expected_vault_key,
            vault_info.key(),
            SsrError::InvalidReserveVault
        );
        require_keys_eq!(*vault_info.key, config.vault, SsrError::InvalidReserveVault);

        let vault: InterfaceAccount<'info, TokenAccount> =
            InterfaceAccount::try_from(vault_info)
                .map_err(|_| error!(SsrError::InvalidReserveVault))?;
        let mint: InterfaceAccount<'info, Mint> = InterfaceAccount::try_from(mint_info)
            .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
        require_keys_eq!(
            mint.key(),
            config.asset_mint,
            SsrError::ReserveAssetMismatch
        );

        let owner_token_account: InterfaceAccount<'info, TokenAccount> =
            InterfaceAccount::try_from(owner_token_account_info)
                .map_err(|_| error!(SsrError::ReserveAssetMismatch))?;
        require_keys_eq!(
            owner_token_account.mint,
            config.asset_mint,
            SsrError::ReserveAssetMismatch
        );

        legs.push(AssetLeg {
            config,
            vault,
            owner_token_account,
            mint,
            token_program: *token_program_info.key,
        });
    }

    Ok(legs)
}

/// Lighter-weight loader for instructions that only need to read/write each
/// `ReserveAsset` config (no vault/mint/token transfer involved) -- e.g.
/// `update_targets`. `remaining_accounts` must be exactly
/// `reserve.asset_count` `ReserveAsset` accounts, in `order_index` order.
/// Note: `reserve`'s lifetime (`'r`) is independent of `remaining_accounts`'s
/// (`'info`) -- see the note on `require_reserve_permission` above.
pub fn load_reserve_asset_configs<'r, 'info>(
    reserve: &Account<'r, Reserve>,
    reserve_key: &Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
    program_id: &Pubkey,
) -> Result<Vec<Account<'info, ReserveAsset>>> {
    let expected_count = reserve.asset_count as usize;
    require_eq!(
        remaining_accounts.len(),
        expected_count,
        SsrError::RemainingAccountsMismatch
    );

    let mut configs = Vec::with_capacity(expected_count);
    for (i, account_info) in remaining_accounts.iter().enumerate() {
        let config: Account<'info, ReserveAsset> =
            Account::try_from(account_info).map_err(|_| error!(SsrError::ReserveAssetMismatch))?;
        require_keys_eq!(config.reserve, *reserve_key, SsrError::ReserveAssetMismatch);
        require_eq!(
            config.order_index as usize,
            i,
            SsrError::RemainingAccountsMismatch
        );

        let (expected_key, _) = Pubkey::find_program_address(
            &[
                RESERVE_ASSET_SEED,
                reserve_key.as_ref(),
                config.asset_mint.as_ref(),
            ],
            program_id,
        );
        require_keys_eq!(
            expected_key,
            account_info.key(),
            SsrError::ReserveAssetMismatch
        );

        configs.push(config);
    }
    Ok(configs)
}

/// The amount that must be SENT for `arrive_amount` to land in the recipient,
/// given the mint's Token-2022 transfer fee (zero-fee mints send exactly
/// `arrive_amount`).
///
/// Why this exists: every deposit is sized pro-rata against the vault's
/// balance (`mul_div_ceil(requested, vault_balance_before, supply_before)`)
/// and shares are minted for that figure. A transfer fee is withheld from the
/// transfer, so without grossing up, LESS arrives than the shares represent
/// and the shortfall is paid by the existing holders -- silently, on every
/// mint. Grossing up puts the fee where it belongs: on the depositor making
/// the transfer.
///
/// Returns `UnsupportedMintExtension` when the fee cannot be inverted (a 100%
/// fee), which is also refused up-front by `validate_asset_mint_extensions`.
pub fn gross_up_for_transfer_fee(mint_info: &AccountInfo, arrive_amount: u64) -> Result<u64> {
    use anchor_spl::token_2022::spl_token_2022::extension::{
        transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    // Classic SPL Token mints cannot carry a fee.
    if mint_info.owner != &anchor_spl::token_2022::ID {
        return Ok(arrive_amount);
    }
    let data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
    let Ok(fee_config) = mint.get_extension::<TransferFeeConfig>() else {
        return Ok(arrive_amount);
    };
    let epoch = Clock::get()?.epoch;
    let fee = fee_config
        .calculate_inverse_epoch_fee(epoch, arrive_amount)
        .ok_or(error!(SsrError::UnsupportedMintExtension))?;
    arrive_amount
        .checked_add(fee)
        .ok_or(error!(SsrError::MathOverflow))
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
    let cpi_ctx = CpiContext::new(leg.token_program, cpi_accounts);
    // `amount` is what must ARRIVE in the vault; send the fee on top so a
    // fee-bearing mint does not short the Reserve (see gross_up_for_transfer_fee).
    let to_send = gross_up_for_transfer_fee(&leg.mint.to_account_info(), amount)?;
    token_interface::transfer_checked(cpi_ctx, to_send, leg.mint.decimals)
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
    let cpi_ctx = CpiContext::new_with_signer(leg.token_program, cpi_accounts, signer_seeds);
    token_interface::transfer_checked(cpi_ctx, amount, leg.mint.decimals)
}

/// Credits `manager_total` (the Manager's already-split share of some fee --
/// see `fee_math::split_total_fee`) either to a Reserve's per-recipient
/// `ManagerFeeRecipients` (if `Some`, i.e. this Reserve has opted into
/// multi-recipient routing) or the legacy aggregate
/// `reserve.fee_config.pending_manager_fee_shares` (if `None`).
///
/// Deliberately does NOT touch `pending_manager_fee_shares` at all once a
/// Reserve has opted in -- it stays permanently 0 from that point on, which
/// is what lets the existing `collect_fees` instruction (left completely
/// untouched by DEC-0094) degrade gracefully into "protocol-only, in
/// practice" for a migrated Reserve, and what lets `close_reserve`'s
/// original `pending_manager_fee_shares == 0` check keep meaning something
/// for a not-yet-migrated Reserve while the NEW `all_pending_collected()`
/// check (see close_reserve.rs) covers the migrated case.
pub fn credit_manager_fee_shares<'info>(
    reserve: &mut Account<'info, Reserve>,
    manager_fee_recipients: &mut Option<Account<'info, ManagerFeeRecipients>>,
    manager_total: u64,
    source: ManagerFeeAccrualSource,
) -> Result<()> {
    match manager_fee_recipients.as_mut() {
        Some(recipients_account) => {
            require_keys_eq!(
                recipients_account.reserve,
                reserve.key(),
                SsrError::ManagerFeeRecipientsMismatch
            );
            require!(
                recipients_account.recipient_count > 0,
                SsrError::InvalidFeeRecipientCount
            );

            if manager_total > 0 {
                let increments = apportion_to_recipients(
                    manager_total,
                    &recipients_account.recipients,
                    recipients_account.recipient_count,
                )?;

                let mut credited_wallets = Vec::new();
                let mut credited_amounts = Vec::new();
                for i in 0..recipients_account.recipient_count as usize {
                    if increments[i] == 0 {
                        continue;
                    }
                    recipients_account.recipients[i].pending_fee_shares = recipients_account
                        .recipients[i]
                        .pending_fee_shares
                        .checked_add(increments[i])
                        .ok_or(error!(SsrError::MathOverflow))?;
                    credited_wallets.push(recipients_account.recipients[i].wallet);
                    credited_amounts.push(increments[i]);
                }

                if !credited_wallets.is_empty() {
                    emit!(ManagerFeeShareAccrued {
                        reserve: reserve.key(),
                        recipients: credited_wallets,
                        amounts: credited_amounts,
                        source,
                        ts: Clock::get()?.unix_timestamp,
                    });
                }
            }
        }
        None => {
            reserve.fee_config.pending_manager_fee_shares = reserve
                .fee_config
                .pending_manager_fee_shares
                .checked_add(manager_total)
                .ok_or(error!(SsrError::MathOverflow))?;
        }
    }
    Ok(())
}

/// Validates a caller-supplied Manager fee recipient list before it's ever
/// written into a `ManagerFeeRecipients` account -- shared by
/// `initialize_manager_fee_recipients` and `update_fee_recipients`.
/// Rejects: empty or >MAX_FEE_RECIPIENTS lists, the default/zero address,
/// a zero allocation, a duplicate wallet, and a total that isn't exactly
/// 10,000 basis points (100% of the Manager's share -- never a percentage
/// of the total assessed fee).
pub fn validate_fee_recipient_inputs(recipients: &[FeeRecipientInput]) -> Result<()> {
    require!(
        !recipients.is_empty() && recipients.len() <= MAX_FEE_RECIPIENTS as usize,
        SsrError::InvalidFeeRecipientCount
    );

    let mut sum: u32 = 0;
    for (i, r) in recipients.iter().enumerate() {
        require!(
            r.wallet != Pubkey::default(),
            SsrError::FeeRecipientZeroAddress
        );
        require!(r.allocation_bps > 0, SsrError::ZeroFeeRecipientAllocation);
        for other in recipients.iter().skip(i + 1) {
            require!(
                other.wallet != r.wallet,
                SsrError::DuplicateFeeRecipientWallet
            );
        }
        sum = sum
            .checked_add(r.allocation_bps as u32)
            .ok_or(error!(SsrError::MathOverflow))?;
    }
    require!(
        sum == BPS_DENOMINATOR as u32,
        SsrError::FeeRecipientAllocationNotFull
    );

    Ok(())
}

/// USDC fee-settlement pipeline (2026-08-21 pass): verifies `token_account`
/// is the exact canonical ATA for `(expected_owner, expected_mint)` under
/// `token_program` -- used to confirm a caller-supplied "staging" token
/// account in `redeem_fee_vault_shares`'s `remaining_accounts` is really the
/// program-derived settlement-staging ATA, never an arbitrary account the
/// caller could redirect redeemed assets into (permissionless callers must
/// never be able to choose where funds land, only trigger the Reserve's own
/// fixed, deterministic destination). Requiring the CANONICAL address (not
/// merely "any account owned by settlement_authority") also means every
/// later step of the pipeline (`approve_settlement_swap`,
/// `distribute_fee_usdc`) can re-derive the same address deterministically,
/// with nothing to track persistently.
pub fn require_canonical_ata<'info>(
    token_account: &InterfaceAccount<'info, TokenAccount>,
    expected_owner: &Pubkey,
    expected_mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<()> {
    let expected = anchor_spl::associated_token::get_associated_token_address_with_program_id(
        expected_owner,
        expected_mint,
        token_program,
    );
    require_keys_eq!(
        token_account.key(),
        expected,
        SsrError::FeeSettlementInvalidAsset
    );
    Ok(())
}

/// Classic-Token-only sibling of [`require_canonical_ata`] above, for a raw
/// `AccountInfo` (an untyped `remaining_accounts` entry, e.g.
/// `distribute_fee_usdc`'s per-recipient USDC destination list) rather than
/// a typed `InterfaceAccount` -- real Circle USDC is always the classic SPL
/// Token program, never Token-2022, so this never needs the generic
/// interface machinery `require_canonical_ata` uses for arbitrary Reserve
/// Assets.
pub fn require_canonical_ata_classic(
    token_account_info: &AccountInfo,
    expected_owner: &Pubkey,
    expected_mint: &Pubkey,
) -> Result<()> {
    let expected = anchor_spl::associated_token::get_associated_token_address(expected_owner, expected_mint);
    require_keys_eq!(
        *token_account_info.key,
        expected,
        SsrError::FeeSettlementInvalidAsset
    );
    Ok(())
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

/// TYPE-CHECKED but RUNTIME-UNVERIFIED: this function's API surface (the
/// `spl_token_2022::extension` imports, `ExtensionType` variant names) now
/// compiles cleanly against the installed `anchor-spl` 1.1.2, so the
/// concerns originally flagged here about wrong import paths/renamed
/// variants did NOT materialize. What's still unverified is runtime
/// behavior -- whether it actually correctly identifies/rejects each
/// extension when run against a real Token-2022 mint, which needs an
/// executed test (none exist yet for Token-2022 assets specifically -- see
/// docs/protocol/TEST_PLAN.md). Rejects Token-2022 mints
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
/// Issuers whose PermanentDelegate the protocol accepts.
///
/// A permanent delegate can move tokens out of ANY account holding that mint,
/// including a Reserve vault. That is unacceptable from an anonymous mint, and
/// unavoidable in a regulated tokenised equity -- the issuer must be able to
/// act on the underlying. So it is allowed only for issuers named here.
///
/// `5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq` is xStocks' delegate; the
/// same key is the delegate on all 1,025 of their Solana mints (verified
/// on-chain 2026-09-23 across TSLAx, NVDAx, SPYx, COINx, HOODx and a random
/// sample), so new listings are covered without touching this list.
const APPROVED_PERMANENT_DELEGATES: [Pubkey; 1] = [
    Pubkey::from_str_const("5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq"),
];

/// Validates a Token-2022 asset mint by what its extensions are CONFIGURED to
/// do, not merely by which extension types are present.
///
/// The previous version rejected on presence alone, which over-blocked badly:
/// xStocks' mints declare a TransferHook with NO hook program set and a
/// ConfidentialTransferMint that does not auto-approve accounts. Neither can
/// affect us, yet every tokenised equity on Solana was refused because of them.
///
/// What each rule protects, and why the configured value is what matters:
///
/// * TransferHook -- arbitrary code on every transfer. Harmless when no
///   program is set; that mint transfers exactly like any other.
/// * TransferFeeConfig -- the amount that arrives is less than the amount
///   sent. Supported: deposits gross the transfer up so the vault receives
///   the full pro-rata amount (gross_up_for_transfer_fee). Only a 100% fee is
///   refused, because no send size makes the required amount arrive.
/// * PermanentDelegate -- see APPROVED_PERMANENT_DELEGATES above.
/// * ConfidentialTransferMint -- balances that are not publicly readable make
///   NAV uncomputable. A vault must opt IN per account, so this is harmless
///   while new accounts are not auto-approved; the protocol never opts in.
/// * NonTransferable -- the vault could never pay a redemption. Never allowed.
///
/// Anything this function accepts must still be disclosed: an approved issuer
/// can seize (permanent delegate), and pause or freeze. That is a property of
/// the asset, not a defect here.
pub fn validate_asset_mint_extensions(
    mint_info: &AccountInfo,
    token_program_id: &Pubkey,
) -> Result<()> {
    // Classic SPL Token mints are owned by the classic token program and
    // never carry extension TLV data -- nothing to check.
    if *token_program_id == anchor_spl::token::ID {
        return Ok(());
    }

    use anchor_spl::token_2022::spl_token_2022::extension::{
        confidential_transfer::ConfidentialTransferMint, permanent_delegate::PermanentDelegate,
        transfer_fee::TransferFeeConfig, transfer_hook::TransferHook, BaseStateWithExtensions,
        ExtensionType, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    let data = mint_info.try_borrow_data()?;
    let mint_with_extensions = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;
    let extensions = mint_with_extensions
        .get_extension_types()
        .map_err(|_| error!(SsrError::UnsupportedTokenProgram))?;

    for ext in extensions {
        match ext {
            // Never holdable: the vault could not pay a redemption.
            ExtensionType::NonTransferable | ExtensionType::NonTransferableAccount => {
                return Err(error!(SsrError::UnsupportedMintExtension));
            }

            ExtensionType::TransferHook => {
                let hook = mint_with_extensions
                    .get_extension::<TransferHook>()
                    .map_err(|_| error!(SsrError::UnsupportedMintExtension))?;
                let program_id: Option<Pubkey> = hook.program_id.into();
                if program_id.is_some() {
                    return Err(error!(SsrError::UnsupportedMintExtension));
                }
            }

            ExtensionType::TransferFeeConfig => {
                // A fee is supported: every deposit grosses the transfer up so
                // the vault receives the full pro-rata amount and the fee is
                // paid by the depositor, not by the existing holders (see
                // gross_up_for_transfer_fee). Only a fee that cannot be
                // inverted -- 100% -- is refused, since no send size makes the
                // required amount arrive.
                let fee = mint_with_extensions
                    .get_extension::<TransferFeeConfig>()
                    .map_err(|_| error!(SsrError::UnsupportedMintExtension))?;
                let older: u16 = fee.older_transfer_fee.transfer_fee_basis_points.into();
                let newer: u16 = fee.newer_transfer_fee.transfer_fee_basis_points.into();
                if older >= BPS_DENOMINATOR || newer >= BPS_DENOMINATOR {
                    return Err(error!(SsrError::UnsupportedMintExtension));
                }
            }

            ExtensionType::PermanentDelegate => {
                let pd = mint_with_extensions
                    .get_extension::<PermanentDelegate>()
                    .map_err(|_| error!(SsrError::UnsupportedMintExtension))?;
                let delegate: Option<Pubkey> = pd.delegate.into();
                match delegate {
                    None => {}
                    Some(d) if APPROVED_PERMANENT_DELEGATES.contains(&d) => {}
                    Some(_) => return Err(error!(SsrError::UnsupportedMintExtension)),
                }
            }

            ExtensionType::ConfidentialTransferMint => {
                let ct = mint_with_extensions
                    .get_extension::<ConfidentialTransferMint>()
                    .map_err(|_| error!(SsrError::UnsupportedMintExtension))?;
                if bool::from(ct.auto_approve_new_accounts) {
                    return Err(error!(SsrError::UnsupportedMintExtension));
                }
            }

            _ => {}
        }
    }

    Ok(())
}
