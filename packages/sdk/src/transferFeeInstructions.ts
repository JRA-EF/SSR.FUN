// Token-2022 Reserve Token transfer fee (DEC-0229).
//
// Every Reserve Token mint created from DEC-0229 on is a Token-2022 mint with
// the transfer-fee extension: the Token-2022 program itself withholds the fee
// from every transfer (DEX swaps, wallet sends), never from a mint or burn.
// Both fee authorities on every such mint are one program PDA
// (`findTransferFeeAuthority`), so only two program instructions can use them:
//
// - update_transfer_fee: a Protocol Admin changes ONE mint's rate, capped
//   on-chain at MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS. A protocol-wide change is
//   one of these per fee-carrying mint (several fit in one transaction);
//   Token-2022 applies each from two epochs later.
// - collect_transfer_fees: permissionless. Harvests withheld fees from the
//   token accounts passed as remaining accounts into the mint, then sweeps
//   everything withheld on the mint to the Protocol treasury's Reserve Token
//   account (the canonical Token-2022 ATA of ProtocolConfig's
//   defaultProtocolFeeDestination). No caller input can redirect it.
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getTransferFeeAmount,
  getTransferFeeConfig,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import type { Program } from "@anchor-lang/core";
import * as anchor from "@anchor-lang/core";
import { findProtocolConfig, findReserveTokenMint, findTransferFeeAuthority } from "./pda";

/** Rate written onto every new Reserve Token mint (programs/ssr_protocol/src/constants.rs). */
export const RESERVE_TOKEN_TRANSFER_FEE_LAUNCH_BPS = 15;
/** Highest rate update_transfer_fee accepts, enforced on-chain. */
export const MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS = 25;

/** Harvest sources per collect transaction -- keeps the account list well inside the 1232-byte limit. */
export const MAX_HARVEST_SOURCES_PER_TX = 20;

export async function buildUpdateTransferFeeInstruction(params: {
  program: Program<anchor.Idl>;
  programId: PublicKey;
  reserve: PublicKey;
  /** Either Protocol Admin. */
  authority: PublicKey;
  newTransferFeeBps: number;
}): Promise<TransactionInstruction> {
  const { program, programId, reserve, authority, newTransferFeeBps } = params;
  if (!Number.isInteger(newTransferFeeBps) || newTransferFeeBps < 0 || newTransferFeeBps > MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS) {
    throw new Error(`Transfer fee must be a whole number of basis points from 0 to ${MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS}; got ${newTransferFeeBps}.`);
  }
  return program.methods
    .updateTransferFee(newTransferFeeBps)
    .accounts({
      protocolConfig: findProtocolConfig(programId)[0],
      reserve,
      reserveTokenMint: findReserveTokenMint(reserve, programId)[0],
      transferFeeAuthority: findTransferFeeAuthority(programId)[0],
      authority,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any)
    .instruction();
}

export async function buildCollectTransferFeesInstruction(params: {
  program: Program<anchor.Idl>;
  programId: PublicKey;
  reserve: PublicKey;
  /** ProtocolConfig.defaultProtocolFeeDestination, read live -- the program rejects any other wallet. */
  treasury: PublicKey;
  payer: PublicKey;
  /** Token accounts of this mint holding withheld fees (see findWithheldFeeAccounts). May be empty. */
  harvestSources?: PublicKey[];
}): Promise<TransactionInstruction> {
  const { program, programId, reserve, treasury, payer } = params;
  const reserveTokenMint = findReserveTokenMint(reserve, programId)[0];
  const sources = params.harvestSources ?? [];
  if (sources.length > MAX_HARVEST_SOURCES_PER_TX) {
    throw new Error(`At most ${MAX_HARVEST_SOURCES_PER_TX} harvest sources per transaction; got ${sources.length}.`);
  }
  return program.methods
    .collectTransferFees()
    .accounts({
      protocolConfig: findProtocolConfig(programId)[0],
      reserve,
      reserveTokenMint,
      transferFeeAuthority: findTransferFeeAuthority(programId)[0],
      treasury,
      treasuryTokenAccount: getAssociatedTokenAddressSync(reserveTokenMint, treasury, true, TOKEN_2022_PROGRAM_ID),
      payer,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(sources.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
    .instruction();
}

export interface ReserveTokenTransferFeeInfo {
  /** Rate in force at `epoch`. */
  currentBps: number;
  /** Rate that applies from `newerEpoch` (equal to currentBps when no change is pending). */
  newerBps: number;
  newerEpoch: bigint;
  /** Already harvested into the mint, ready to sweep. */
  withheldOnMintRaw: bigint;
}

/** Reads a Reserve Token mint's transfer-fee state; null for a classic (pre-DEC-0229) mint. */
export async function fetchReserveTokenTransferFee(connection: Connection, reserveTokenMint: PublicKey): Promise<ReserveTokenTransferFeeInfo | null> {
  const [info, epochInfo] = await Promise.all([connection.getAccountInfo(reserveTokenMint), connection.getEpochInfo()]);
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const config = getTransferFeeConfig(unpackMint(reserveTokenMint, info, TOKEN_2022_PROGRAM_ID));
  if (!config) return null;
  const epoch = BigInt(epochInfo.epoch);
  const newer = config.newerTransferFee;
  const current = epoch >= newer.epoch ? newer : config.olderTransferFee;
  return {
    currentBps: current.transferFeeBasisPoints,
    newerBps: newer.transferFeeBasisPoints,
    newerEpoch: newer.epoch,
    withheldOnMintRaw: config.withheldAmount,
  };
}

/**
 * Token accounts of `reserveTokenMint` that currently hold withheld fees, largest
 * first. One getProgramAccounts scan (server-side only: the public DevNet RPC
 * refuses it); `dataSlice` is not used because the withheld amount lives in the
 * account's extension data.
 */
export async function findWithheldFeeAccounts(connection: Connection, reserveTokenMint: PublicKey): Promise<{ address: PublicKey; withheldRaw: bigint }[]> {
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: reserveTokenMint.toBase58() } }],
  });
  const out: { address: PublicKey; withheldRaw: bigint }[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const withheld = getTransferFeeAmount(unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
      if (withheld > 0n) out.push({ address: pubkey, withheldRaw: withheld });
    } catch {
      // Not a token account of this mint (a mint account cannot match the filter, but stay lenient).
    }
  }
  return out.sort((a, b) => (b.withheldRaw > a.withheldRaw ? 1 : b.withheldRaw < a.withheldRaw ? -1 : 0));
}
