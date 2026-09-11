// Shared machinery for the server-built Buy (buildBuy.ts) and Sell
// (buildSell.ts): the parallel Reserve + wallet reads, the lookup-table
// decision, v0 compilation/fit measurement, and Jupiter failure mapping.
// Pure where possible (decideMode, hypotheticalLookupTable, fitsV0) so the
// decisions are unit-testable without a wallet or Jupiter.
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import {
  enumerateReserveAssetMintsOnChain,
  findProtocolConfig,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
  getTokenSupplyWithRetry,
  type ZapAssetLeg,
} from "@ssr/sdk";
import { compileSingleBuyTransaction, fetchLookupTables, SingleTxTooLargeError } from "../../src/merge/lib/singleTxBuy";
import { buildReserveAltAddresses, chunkAltAddresses } from "../../src/merge/lib/reserveAltClient";
import { MAINNET_USDC_MINT, jupiterExhaustedResponse, type JupiterCallResult } from "./jupiter";

export const MAINNET_TREASURY_VAULT = "3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5";
/** Above this many swap legs the one-transaction composition has never fit -- the single attempt is skipped outright. */
export const SINGLE_TX_MAX_SWAP_LEGS = 4;
/** Compute-unit ceiling for a standalone mint/redeem transaction; the priority fee scales with it. */
export const CORE_TX_COMPUTE_UNIT_LIMIT = 600_000;

export class BuildError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>, retryAfterSeconds?: number) {
    super(message);
    this.name = "BuildError";
    this.status = status;
    this.extra = extra;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type BuiltTxKind = "alt-create" | "alt-extend" | "swap" | "mint" | "redeem" | "single";

export interface BuiltTransaction {
  kind: BuiltTxKind;
  /** The Reserve asset this swap funds/sells (kind "swap" only). */
  mint?: string;
  /** Position of that asset in the Reserve's registered order (kind "swap" only). */
  legIndex?: number;
  base64: string;
  bytes: number;
  lastValidBlockHeight: number;
}

// --- Pure helpers --------------------------------------------------------------

/** Pure: mode + whether a table must be created first, given the fit facts the compile step measured. "core" is the mint (Buy) or the redeem (Sell). */
export function decideMode(params: {
  attemptedSingle: boolean;
  singleFitsWithExistingTables: boolean;
  singleFitsWithWouldBeTable: boolean;
  coreFitsWithExistingTables: boolean;
  coreFitsWithWouldBeTable: boolean;
  hasRegisteredAlt: boolean;
}): { mode: "single" | "batch"; createAlt: boolean } | { mode: "unfit" } {
  if (params.attemptedSingle) {
    if (params.singleFitsWithExistingTables) return { mode: "single", createAlt: false };
    if (!params.hasRegisteredAlt && params.singleFitsWithWouldBeTable) return { mode: "single", createAlt: true };
  }
  if (params.coreFitsWithExistingTables) return { mode: "batch", createAlt: false };
  if (!params.hasRegisteredAlt && params.coreFitsWithWouldBeTable) return { mode: "batch", createAlt: true };
  return { mode: "unfit" };
}

/** Pure: a would-be lookup table object, size-identical to a real one, keyed by the address the create transaction will produce. */
export function hypotheticalLookupTable(key: PublicKey, addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key,
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
  });
}

export function compileV0(payer: PublicKey, recentBlockhash: string, instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[]): VersionedTransaction {
  return compileSingleBuyTransaction({ payer, recentBlockhash, instructions, lookupTables });
}

/** Pure: would this instruction list fit Solana's wire limit compiled against these tables? */
export function fitsV0(payer: PublicKey, instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[]): boolean {
  try {
    compileV0(payer, "11111111111111111111111111111111", instructions, lookupTables);
    return true;
  } catch (e) {
    if (e instanceof SingleTxTooLargeError) return false;
    throw e;
  }
}

export function toBase64(tx: VersionedTransaction): { base64: string; bytes: number } {
  const bytes = tx.serialize();
  return { base64: Buffer.from(bytes).toString("base64"), bytes: bytes.length };
}

export function jupiterFailure(what: "quote" | "transaction", mint: string, r: Exclude<JupiterCallResult<unknown>, { kind: "ok" }>): BuildError {
  if (r.kind === "specific-error") return new BuildError(502, `Jupiter could not ${what === "quote" ? "quote" : "build"} the swap for ${mint}: ${r.message}`, { mint });
  const x = jupiterExhaustedResponse(what, r.lastStatus);
  return new BuildError(x.status, `${x.error} (asset ${mint})`, { mint }, x.retryAfterSeconds);
}

export function tokenAmountFromInfo(pda: PublicKey, info: Parameters<typeof unpackAccount>[1]): bigint {
  if (!info) return 0n;
  try {
    return unpackAccount(pda, info).amount;
  } catch {
    return 0n;
  }
}

// --- The parallel reads --------------------------------------------------------

export interface ReadDeps {
  connection: Connection;
  program: any;
  ssrProgramId: PublicKey;
  lookupReserveAlt(reserve: string): Promise<string | null>;
}

export interface ReserveReadResult {
  reserveAccount: any;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  vaultAuthority: PublicKey;
  protocolConfig: PublicKey;
  /** Registered assets in order_index order, with live vault balances. */
  orderedAssets: ZapAssetLeg[];
  supplyRaw: bigint;
  heldByMint: Map<string, bigint>;
  walletUsdcRaw: bigint;
  walletReserveTokenRaw: bigint;
  walletSolLamports: bigint;
  reserveAlt: string | null;
  readsMs: number;
}

/**
 * Two parallel phases: (1) the Reserve account + which mints to resolve;
 * (2) every asset registration (fetchMultiple), every vault balance and the
 * wallet's every balance (getMultipleAccountsInfo), the supply, SOL, and
 * the table registry -- all at once.
 */
export async function readReserveAndWallet(deps: ReadDeps, reserve: PublicKey, wallet: PublicKey, assetMints: PublicKey[] | null): Promise<ReserveReadResult> {
  const { connection, program, ssrProgramId } = deps;
  const t0 = Date.now();
  const [reserveAccount, candidateMints] = await Promise.all([
    program.account.reserve.fetchNullable(reserve) as Promise<any>,
    assetMints ? Promise.resolve(assetMints) : enumerateReserveAssetMintsOnChain(connection).then((ms) => ms.map((m) => new PublicKey(m))),
  ]);
  if (!reserveAccount) throw new BuildError(404, "Reserve not found on Mainnet.");
  const reserveTokenMint = new PublicKey(reserveAccount.reserveTokenMint);
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);
  const reserveAssetPdas = candidateMints.map((m) => findReserveAsset(reserve, m, ssrProgramId)[0]);
  const vaultPdas = candidateMints.map((m) => findReserveVault(reserve, m, ssrProgramId)[0]);
  const walletAtas = candidateMints.map((m) => getAssociatedTokenAddressSync(m, wallet));
  const walletUsdcAta = getAssociatedTokenAddressSync(usdcMint, wallet);
  const walletRtAta = getAssociatedTokenAddressSync(reserveTokenMint, wallet);
  type ReserveAssetRow = { decimals: number; orderIndex: number } | null;
  const [reserveAssets, vaultInfos, supply, walletInfos, walletSolLamports, reserveAlt] = await Promise.all([
    program.account.reserveAsset.fetchMultiple(reserveAssetPdas) as Promise<ReserveAssetRow[]>,
    connection.getMultipleAccountsInfo(vaultPdas),
    getTokenSupplyWithRetry(connection, reserveTokenMint),
    connection.getMultipleAccountsInfo([...walletAtas, walletUsdcAta, walletRtAta]),
    connection.getBalance(wallet, "confirmed"),
    deps.lookupReserveAlt(reserve.toBase58()).catch(() => null),
  ]);
  const assets: ZapAssetLeg[] = [];
  const orderIndexes: number[] = [];
  candidateMints.forEach((m, i) => {
    const ra = reserveAssets[i];
    if (!ra) return;
    assets.push({ mint: m.toBase58(), decimals: ra.decimals, reserveAsset: reserveAssetPdas[i].toBase58(), vault: vaultPdas[i].toBase58(), vaultBalanceRaw: tokenAmountFromInfo(vaultPdas[i], vaultInfos[i]).toString() });
    orderIndexes.push(ra.orderIndex);
  });
  const order = assets.map((_, i) => i).sort((a, b) => orderIndexes[a] - orderIndexes[b]);
  const orderedAssets = order.map((i) => assets[i]);
  if (orderedAssets.length !== reserveAccount.assetCount) {
    throw new BuildError(422, `Could not resolve every registered asset of this Reserve (${orderedAssets.length} of ${reserveAccount.assetCount}) -- refusing to build against an incomplete asset list.`);
  }
  if (orderedAssets.length === 0) throw new BuildError(422, "This Reserve has no registered assets.");
  const heldByMint = new Map<string, bigint>();
  candidateMints.forEach((m, i) => heldByMint.set(m.toBase58(), tokenAmountFromInfo(walletAtas[i], walletInfos[i])));
  return {
    reserveAccount,
    reserveTokenMint,
    mintAuthority: PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), reserve.toBuffer()], ssrProgramId)[0],
    vaultAuthority: findVaultAuthority(reserve, ssrProgramId)[0],
    protocolConfig: findProtocolConfig(ssrProgramId)[0],
    orderedAssets,
    supplyRaw: BigInt(supply ? supply.value.amount : "0"),
    heldByMint,
    walletUsdcRaw: tokenAmountFromInfo(walletUsdcAta, walletInfos[candidateMints.length]),
    walletReserveTokenRaw: tokenAmountFromInfo(walletRtAta, walletInfos[candidateMints.length + 1]),
    walletSolLamports: BigInt(walletSolLamports),
    reserveAlt,
    readsMs: Date.now() - t0,
  };
}

// --- Lookup-table planning ----------------------------------------------------

export interface AltPlan {
  altAddresses: PublicKey[];
  /** The registered table (loaded), or none. */
  existingTables: AddressLookupTableAccount[];
  /** When no table is registered: the address the create transaction would produce, its create instruction, and a size-identical would-be table object. */
  wouldBeAlt: PublicKey | null;
  altCreateIx: TransactionInstruction | null;
  wouldBeTable: AddressLookupTableAccount | null;
}

export async function planAlt(connection: Connection, wallet: PublicKey, read: ReserveReadResult, reserve: PublicKey, ssrProgramId: PublicKey): Promise<AltPlan> {
  const altAddresses = buildReserveAltAddresses({
    ssrProgramId,
    reserve,
    reserveTokenMint: read.reserveTokenMint,
    mintAuthority: read.mintAuthority,
    vaultAuthority: read.vaultAuthority,
    protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
    assets: read.orderedAssets.map((a) => ({ mint: a.mint, reserveAsset: a.reserveAsset, vault: a.vault })),
  });
  if (read.reserveAlt) {
    return { altAddresses, existingTables: await fetchLookupTables(connection, [read.reserveAlt]), wouldBeAlt: null, altCreateIx: null, wouldBeTable: null };
  }
  const recentSlot = await connection.getSlot("finalized");
  const [altCreateIx, wouldBeAlt] = AddressLookupTableProgram.createLookupTable({ authority: wallet, payer: wallet, recentSlot });
  return { altAddresses, existingTables: [], wouldBeAlt, altCreateIx, wouldBeTable: hypotheticalLookupTable(wouldBeAlt, altAddresses) };
}

/** The alt-create (+ first extend) and alt-extend transactions for a would-be table, each a v0 message with no tables. */
export function altTransactions(wallet: PublicKey, blockhash: string, lastValidBlockHeight: number, plan: AltPlan): BuiltTransaction[] {
  if (!plan.altCreateIx || !plan.wouldBeAlt) return [];
  const chunks = chunkAltAddresses(plan.altAddresses);
  const out: BuiltTransaction[] = [];
  const createTx = compileV0(wallet, blockhash, [plan.altCreateIx, AddressLookupTableProgram.extendLookupTable({ lookupTable: plan.wouldBeAlt, authority: wallet, payer: wallet, addresses: chunks[0] })], []);
  out.push({ kind: "alt-create", ...toBase64(createTx), lastValidBlockHeight });
  for (const chunk of chunks.slice(1)) {
    const extendTx = compileV0(wallet, blockhash, [AddressLookupTableProgram.extendLookupTable({ lookupTable: plan.wouldBeAlt, authority: wallet, payer: wallet, addresses: chunk })], []);
    out.push({ kind: "alt-extend", ...toBase64(extendTx), lastValidBlockHeight });
  }
  return out;
}

/** JSON-safe view (bigint -> string). */
export function serializeBuildResult(r: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
