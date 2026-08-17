// Canonical PDA derivation for the SSR Protocol. Must mirror
// programs/ssr_protocol/src/constants.rs seed prefixes EXACTLY -- if a seed
// prefix changes on the Rust side, it must change here too.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config");
export const RESERVE_SEED = Buffer.from("reserve");
export const RESERVE_ASSET_SEED = Buffer.from("reserve_asset");
export const RESERVE_VAULT_SEED = Buffer.from("reserve_vault");
export const VAULT_AUTHORITY_SEED = Buffer.from("vault_authority");
export const RESERVE_TOKEN_MINT_SEED = Buffer.from("reserve_token_mint");
export const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");
export const DELEGATE_SEED = Buffer.from("delegate");
export const MANAGER_FEE_RECIPIENTS_SEED = Buffer.from("manager_fee_recipients");
export const TVL_ACCRUAL_SEED = Buffer.from("tvl_accrual");

export function findProtocolConfig(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], programId);
}

export function findReserve(reserveId: bigint, programId: PublicKey): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(reserveId);
  return PublicKey.findProgramAddressSync([RESERVE_SEED, buf], programId);
}

export function findReserveAsset(reserve: PublicKey, assetMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([RESERVE_ASSET_SEED, reserve.toBuffer(), assetMint.toBuffer()], programId);
}

export function findReserveVault(reserve: PublicKey, assetMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([RESERVE_VAULT_SEED, reserve.toBuffer(), assetMint.toBuffer()], programId);
}

export function findVaultAuthority(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_AUTHORITY_SEED, reserve.toBuffer()], programId);
}

export function findReserveTokenMint(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([RESERVE_TOKEN_MINT_SEED, reserve.toBuffer()], programId);
}

export function findMintAuthority(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED, reserve.toBuffer()], programId);
}

export function findDelegate(reserve: PublicKey, wallet: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DELEGATE_SEED, reserve.toBuffer(), wallet.toBuffer()], programId);
}

/** DEC-0094: the up-to-10-recipient Manager fee routing account for a Reserve, if it has opted in. */
export function findManagerFeeRecipients(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MANAGER_FEE_RECIPIENTS_SEED, reserve.toBuffer()], programId);
}

/** The time-weighted average TVL accumulator for a Reserve -- see programs/ssr_protocol/src/state/tvl_accrual.rs. */
export function findTvlAccrual(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TVL_ACCRUAL_SEED, reserve.toBuffer()], programId);
}

/**
 * Resolves the account to pass as an Anchor instruction's
 * `protocolFeeDestinationTokenAccount` field (`seedReserve` /
 * `mintReserveTokensInKind` -- both `Option<Account<'info, TokenAccount>>`
 * on-chain as of the 2026-08-17 corrective pass, see
 * docs/project/DECISION_LOG.md).
 *
 * When `protocolFeeDestination` IS `otherWallet` (the manager at seed time,
 * the depositor at Buy time), that account's associated_token derivation
 * would resolve to the EXACT SAME address as `otherWallet`'s own Reserve
 * Token ATA -- two separate mutable `Account<'info, TokenAccount>` slots
 * resolving to one underlying account, which Anchor's own
 * `ConstraintDuplicateMutableAccount` safety check rejects unconditionally,
 * before the handler ever runs (confirmed live: DevNet error 2040). In that
 * case this returns `programId` itself -- the exact "None" sentinel these
 * `Option<Account>` fields require (the same convention already used for
 * `managerFeeRecipients`, see `createReserveFlow.ts`) -- instead of the real
 * ATA; the program then mints the Protocol's fee share in the SAME CPI as
 * `otherWallet`'s own net share, preserving the exact combined total rather
 * than dropping or redirecting it (see `seed_reserve.rs`/
 * `mint_reserve_tokens_in_kind.rs`'s handler logic).
 *
 * Otherwise (the overwhelmingly common case), returns the real, normally-
 * derived ATA -- unchanged from before this pass.
 */
export function resolveProtocolFeeDestinationTokenAccount(
  protocolFeeDestination: PublicKey,
  otherWallet: PublicKey,
  reserveTokenMint: PublicKey,
  programId: PublicKey,
): PublicKey {
  if (protocolFeeDestination.equals(otherWallet)) return programId;
  return getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);
}
