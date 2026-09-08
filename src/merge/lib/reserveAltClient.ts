// Per-Reserve TRADING ADDRESS LOOKUP TABLE (DEC-0161) -- the one-time
// on-chain table that makes the composed one-transaction Buy/Sell fit
// Solana's 1232-byte wire limit. The table holds the Reserve's FIXED
// accounts (protocol program + PDAs, vaults, mints, token programs, USDC),
// so v0 compilation references them as 1-byte indexes instead of 32-byte
// static keys. Without it, a two-leg Reserve's composed trade carries ~26
// static keys and overruns (live 2026-08-26: a CHARLI sell fell back to 3
// wallet approvals).
//
// SAFETY: a lookup table can never substitute accounts -- compilation only
// compresses pubkeys the client itself put in the instruction, by content
// match against the table. A wrong table merely fails to compress. Creation
// costs one-time rent (~0.002 SOL) paid by whoever clicks "Enable
// one-approval trading" (in practice the Reserve's manager, via Manage);
// the table is then registered server-side (api/mainnet/reserve-alt) and
// shared by every trader of that Reserve.
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { findProtocolConfig, findTvlAccrual, findFeeSettlement, findFeeVaultAuthority, findFeeVaultAta, MAINNET_USDC_MINT } from "@ssr/sdk";
import { confirmSignatureBounded, AmbiguousConfirmationError } from "./rpcResilience";

/** Jupiter's v6 swap program -- included so its program id also compresses. */
const JUPITER_V6_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

export interface ReserveAltParams {
  ssrProgramId: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  vaultAuthority: PublicKey;
  /** No longer referenced by any composed trade (Tier B moved mint fees, and DEC-0173 seed/redeem fees, into the per-Reserve fee vault) -- kept on the params type so existing callers compile; ignored by buildReserveAltAddresses. */
  protocolFeeDestination: PublicKey;
  assets: { mint: string; reserveAsset: string; vault: string }[];
}

/**
 * Pure: every FIXED address the composed Buy/Sell for this Reserve
 * references -- the table's contents. Deduplicated, order-stable. User
 * ATAs are deliberately NOT included (per-wallet, they stay static).
 */
export function buildReserveAltAddresses(params: ReserveAltParams): PublicKey[] {
  const [protocolConfig] = findProtocolConfig(params.ssrProgramId);
  const [tvlAccrual] = findTvlAccrual(params.reserve, params.ssrProgramId);
  // The per-Reserve fee vault trio every composed Buy (mint, Tier B) AND
  // Sell (redeem, DEC-0173) now references -- replaces the old treasury
  // destination + its Reserve Token ATA, which no composed trade touches
  // anymore. A table created before this change lacks these three, so
  // those trades carry them as static keys (+96 bytes) until the table is
  // recreated; the fit check (wouldFitWithReserveAlt) measures the real
  // size either way.
  const [feeSettlement] = findFeeSettlement(params.reserve, params.ssrProgramId);
  const [feeVaultAuthority] = findFeeVaultAuthority(params.reserve, params.ssrProgramId);
  const feeVault = findFeeVaultAta(params.reserve, params.reserveTokenMint, params.ssrProgramId);
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);
  const addresses: PublicKey[] = [
    params.ssrProgramId,
    params.reserve,
    params.reserveTokenMint,
    params.mintAuthority,
    params.vaultAuthority,
    protocolConfig,
    tvlAccrual,
    feeSettlement,
    feeVault,
    feeVaultAuthority,
    usdcMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    JUPITER_V6_PROGRAM,
  ];
  for (const a of params.assets) {
    addresses.push(new PublicKey(a.reserveAsset), new PublicKey(a.vault), new PublicKey(a.mint));
  }
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const k = a.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * How many addresses fit alongside createLookupTable in the FIRST
 * transaction, and per extend-only transaction after it. Measured, not
 * guessed: a real create+extend carrying 24 addresses serialized to 1,090
 * bytes (ECHO's table, 2026-08-27), leaving ~140 spare -- 26 stays safely
 * under the 1232-byte wire limit; an extend-only transaction saves the
 * create instruction's bytes, so 28 fits there. A 3-asset Reserve (24
 * addresses) stays one approval; the 12-asset maximum (51 addresses)
 * needs one follow-up extend.
 */
export const ALT_FIRST_TX_MAX_ADDRESSES = 26;
export const ALT_EXTEND_TX_MAX_ADDRESSES = 28;

/** Pure: splits a table's addresses into the create-transaction chunk plus follow-up extend-transaction chunks, order preserved, nothing dropped. */
export function chunkAltAddresses(
  addresses: PublicKey[],
  firstMax: number = ALT_FIRST_TX_MAX_ADDRESSES,
  extendMax: number = ALT_EXTEND_TX_MAX_ADDRESSES,
): PublicKey[][] {
  if (addresses.length === 0) return [];
  const chunks: PublicKey[][] = [addresses.slice(0, firstMax)];
  for (let i = firstMax; i < addresses.length; i += extendMax) {
    chunks.push(addresses.slice(i, i + extendMax));
  }
  return chunks;
}

const altCache = new Map<string, { alt: string | null; at: number }>();
const ALT_CACHE_TTL_MS = 5 * 60_000;

/** The registered trading table address for a Reserve, or null when none exists yet (trades then compose without it and may fall back to the multi-approval flow). */
export async function fetchReserveAltAddress(reserve: string): Promise<string | null> {
  const cached = altCache.get(reserve);
  if (cached && Date.now() - cached.at < ALT_CACHE_TTL_MS) return cached.alt;
  try {
    const res = await fetch(`/api/mainnet/reserve-alt?reserve=${reserve}`);
    const body = await res.json().catch(() => null);
    const alt = res.ok && body && typeof body.alt === "string" ? body.alt : null;
    altCache.set(reserve, { alt, at: Date.now() });
    return alt;
  } catch {
    return null; // best-effort -- composing without the table still works (it just may not fit)
  }
}

/**
 * One-time creation flow (Manage's "Enable one-approval trading", and the
 * automatic paths added by DEC-0171: Reserve creation and a first trade on
 * a table-less Reserve): creates the table and extends it with the
 * Reserve's fixed addresses -- one wallet approval for up to
 * ALT_FIRST_TX_MAX_ADDRESSES addresses (every Reserve up to ~3 assets),
 * with follow-up extend approvals only for larger tables (the 12-asset
 * maximum needs one). Confirms each transaction, waits for the table to
 * become genuinely usable (a just-extended table can't be referenced until
 * the chain advances past its extension slot), then registers it
 * server-side so every trader benefits. The wallet pays the table's
 * one-time rent (~0.002-0.004 SOL).
 */
export async function createAndRegisterReserveAlt(
  connection: Connection,
  wallet: WalletContextState,
  params: ReserveAltParams,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Connect a wallet first.");
  const payer = wallet.publicKey;
  const addresses = buildReserveAltAddresses(params);
  const chunks = chunkAltAddresses(addresses);
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({ authority: payer, payer, recentSlot });

  const signAndConfirm = async (ixs: TransactionInstruction[], label: string) => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = payer;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    const signed = await wallet.signTransaction!(tx);
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
    const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
    if (outcome.status === "failed") throw new Error(`${label} failed on-chain (${outcome.error}). Signature: ${signature}.`);
    if (outcome.status === "expired") throw new Error(`${label} expired before confirmation -- nothing should have changed. Signature: ${signature}.`);
    if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
    return signature;
  };

  await signAndConfirm(
    [createIx, AddressLookupTableProgram.extendLookupTable({ lookupTable: tableAddress, authority: payer, payer, addresses: chunks[0] })],
    "Creating the lookup table",
  );
  for (const chunk of chunks.slice(1)) {
    await signAndConfirm(
      [AddressLookupTableProgram.extendLookupTable({ lookupTable: tableAddress, authority: payer, payer, addresses: chunk })],
      "Extending the lookup table",
    );
  }

  // A lookup table only becomes referenceable once the chain has advanced
  // past the slot of its last extension -- wait (bounded) for it to be
  // fully readable so a trade composed immediately after enabling doesn't
  // fail with an invalid-table error. Confirmation above already took real
  // time, so this almost always passes on the first check.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const slotNow = await connection.getSlot("confirmed").catch(() => recentSlot);
    if (slotNow > recentSlot) {
      const table = await connection.getAddressLookupTable(tableAddress).catch(() => null);
      if (table?.value && table.value.state.addresses.length >= addresses.length && table.value.isActive()) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Register (the server re-verifies the table on-chain before storing).
  await registerReserveAlt(params.reserve.toBase58(), tableAddress.toBase58());
  return tableAddress.toBase58();
}

/** Registers an already-created, already-active table server-side (the server re-verifies it on-chain before storing). Also used by the server-built Buy after it lands the table transactions the server prepended. */
export async function registerReserveAlt(reserve: string, tableAddress: string): Promise<void> {
  const res = await fetch("/api/mainnet/reserve-alt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reserve, alt: tableAddress }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `The lookup table was created on-chain (${tableAddress}) but could not be registered yet: ${(body && body.error) || `HTTP ${res.status}`}. It can be registered again later without recreating it.`,
    );
  }
  altCache.set(reserve, { alt: tableAddress, at: Date.now() });
}
