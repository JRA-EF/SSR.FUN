// Builds instructions for Phase F (composition management) and Phase G
// (wind-down) -- see docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md
// "Phase F/G" and DEC-0046. Also builds update_targets (a pre-existing
// instruction that had never actually been wired to a real signed
// transaction from the browser before this pass -- ManageDTR's Rebalance
// tab only ever simulated it locally for on-chain Reserves).
//
// Every function here returns an unsigned TransactionInstruction (built
// against the read-only program instance, same pattern as
// zapInstructions.ts) -- the caller assembles a Transaction, gets it signed
// by the connected wallet, and submits it. No server-side signer is
// involved in any of these: every action here is either root-manager-only
// or manager-or-permitted-delegate, never something a DevNet swap-authority
// key could or should co-sign.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findDelegate, findProtocolConfig, findReserveAsset, findReserveVault, findVaultAuthority, findMintAuthority } from "./pda";

/** reserve.asset_count ReserveAsset PDAs, in order_index order -- see common.rs::load_reserve_asset_configs. */
export async function buildUpdateTargetsInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  assetMintsInOrder: PublicKey[],
  newTargetWeightsBps: number[],
): Promise<TransactionInstruction> {
  const remainingAccounts = assetMintsInOrder.map((mint) => ({
    pubkey: findReserveAsset(reserve, mint, programId)[0],
    isWritable: true,
    isSigner: false,
  }));
  return program.methods
    .updateTargets(newTargetWeightsBps)
    .accounts({ reserve, delegate, signer })
    .remainingAccounts(remainingAccounts)
    .instruction();
}

export async function buildAddReserveAssetActiveInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  assetMint: PublicKey,
  targetWeightBps: number,
): Promise<TransactionInstruction> {
  const [protocolConfig] = findProtocolConfig(programId);
  const [reserveAsset] = findReserveAsset(reserve, assetMint, programId);
  const [vault] = findReserveVault(reserve, assetMint, programId);
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  return program.methods
    .addReserveAssetActive(targetWeightBps)
    .accounts({
      protocolConfig,
      reserve,
      reserveAsset,
      assetMint,
      vault,
      vaultAuthority,
      delegate,
      signer,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function buildFundNewReserveAssetInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  manager: PublicKey,
  assetMint: PublicKey,
  amountRaw: bigint,
): Promise<TransactionInstruction> {
  const [reserveAsset] = findReserveAsset(reserve, assetMint, programId);
  const [vault] = findReserveVault(reserve, assetMint, programId);
  const managerTokenAccount = getAssociatedTokenAddressSync(assetMint, manager);
  return program.methods
    .fundNewReserveAsset(new BN(amountRaw.toString()))
    .accounts({
      reserve,
      reserveAsset,
      assetMint,
      vault,
      managerTokenAccount,
      manager,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function buildRemoveReserveAssetInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveManager: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  assetMint: PublicKey,
): Promise<TransactionInstruction> {
  const [reserveAsset] = findReserveAsset(reserve, assetMint, programId);
  const [vault] = findReserveVault(reserve, assetMint, programId);
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  return program.methods
    .removeReserveAsset()
    .accounts({
      reserve,
      reserveAsset,
      assetMint,
      vault,
      vaultAuthority,
      manager: reserveManager,
      delegate,
      signer,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Grants a new delegate (or re-adds a removed one). Restricted grants are gated by the acting signer's own ADD_RESTRICTED_DELEGATE permission (require_reserve_permission); an unrestricted grant is root-manager-only regardless of `actingDelegate`'s contents -- see add_delegate.rs. */
export async function buildAddDelegateInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  actingDelegate: PublicKey,
  delegateWallet: PublicKey,
  permissions: number,
  restricted: boolean,
): Promise<TransactionInstruction> {
  const [delegateAccount] = findDelegate(reserve, delegateWallet, programId);
  return program.methods
    .addDelegate(delegateWallet, permissions, restricted)
    .accounts({
      reserve,
      delegateAccount,
      actingDelegate,
      signer,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Rewrites an existing delegate's permission bitmask. Gated the same way as buildAddDelegateInstruction -- see update_delegate_permissions.rs. */
export async function buildUpdateDelegatePermissionsInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  actingDelegate: PublicKey,
  delegateWallet: PublicKey,
  newPermissions: number,
): Promise<TransactionInstruction> {
  const [delegateAccount] = findDelegate(reserve, delegateWallet, programId);
  return program.methods
    .updateDelegatePermissions(newPermissions)
    .accounts({ reserve, delegateAccount, actingDelegate, signer })
    .instruction();
}

/** Revokes a delegate, closing its PDA and reclaiming rent to `signer`. Gated the same way as buildAddDelegateInstruction -- see remove_delegate.rs. */
export async function buildRemoveDelegateInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  actingDelegate: PublicKey,
  delegateWallet: PublicKey,
): Promise<TransactionInstruction> {
  const [delegateAccount] = findDelegate(reserve, delegateWallet, programId);
  return program.methods
    .removeDelegate()
    .accounts({ reserve, delegateAccount, actingDelegate, signer })
    .instruction();
}

export async function buildInitiateWindDownInstruction(
  program: Program<anchor.Idl>,
  reserve: PublicKey,
  manager: PublicKey,
): Promise<TransactionInstruction> {
  return program.methods.initiateWindDown().accounts({ reserve, manager }).instruction();
}

/** Manager-or-permitted-delegate (PAUSE_RESERVE) only. Requires the Reserve to be genuinely Active on-chain -- see pause_reserve.rs. */
export async function buildPauseReserveInstruction(
  program: Program<anchor.Idl>,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
): Promise<TransactionInstruction> {
  return program.methods.pauseReserve().accounts({ reserve, delegate, signer }).instruction();
}

/** Manager-or-permitted-delegate (UNPAUSE_RESERVE) only. Requires the Reserve to be genuinely Paused on-chain -- see unpause_reserve.rs. */
export async function buildUnpauseReserveInstruction(
  program: Program<anchor.Idl>,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
): Promise<TransactionInstruction> {
  return program.methods.unpauseReserve().accounts({ reserve, delegate, signer }).instruction();
}

/**
 * Permissionless -- see collect_fees.rs's header comment: this only mints
 * already-accounted pending shares to fixed, Reserve/ProtocolConfig-
 * configured destinations; the caller cannot redirect funds anywhere, so
 * ANY wallet may call this (and cover the one-time destination-ATA rent as
 * `payer` if either destination doesn't have a Reserve Token account yet).
 * `managerFeeDestination`/`protocolFeeDestination` must be read live from
 * chain immediately before calling (Reserve.feeConfig.feeDestination /
 * ProtocolConfig.defaultProtocolFeeDestination) -- neither is a derivable
 * PDA, and the program itself validates both against those exact fields.
 */
export async function buildCollectFeesInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveTokenMint: PublicKey,
  managerFeeDestination: PublicKey,
  protocolFeeDestination: PublicKey,
  payer: PublicKey,
): Promise<TransactionInstruction> {
  const [protocolConfig] = findProtocolConfig(programId);
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const managerFeeDestinationTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, managerFeeDestination);
  const protocolFeeDestinationTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);
  return program.methods
    .collectFees()
    .accounts({
      protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority,
      managerFeeDestinationTokenAccount,
      managerFeeDestination,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      payer,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** remaining_accounts: reserve.asset_count pairs of [reserveAsset, vault], in order_index order -- see close_reserve.rs. */
export async function buildCloseReserveInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveTokenMint: PublicKey,
  manager: PublicKey,
  assetMintsInOrder: PublicKey[],
): Promise<TransactionInstruction> {
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  const remainingAccounts = assetMintsInOrder.flatMap((mint) => [
    { pubkey: findReserveAsset(reserve, mint, programId)[0], isWritable: true, isSigner: false },
    { pubkey: findReserveVault(reserve, mint, programId)[0], isWritable: true, isSigner: false },
  ]);
  return program.methods
    .closeReserve()
    .accounts({ reserve, reserveTokenMint, vaultAuthority, manager, tokenProgram: TOKEN_PROGRAM_ID })
    .remainingAccounts(remainingAccounts)
    .instruction();
}
