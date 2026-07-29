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
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findProtocolConfig, findReserveAsset, findReserveVault, findVaultAuthority } from "./pda";

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

export async function buildInitiateWindDownInstruction(
  program: Program<anchor.Idl>,
  reserve: PublicKey,
  manager: PublicKey,
): Promise<TransactionInstruction> {
  return program.methods.initiateWindDown().accounts({ reserve, manager }).instruction();
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
