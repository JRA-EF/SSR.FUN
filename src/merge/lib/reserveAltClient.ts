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
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { findProtocolConfig, findTvlAccrual, MAINNET_USDC_MINT } from "@ssr/sdk";
import { confirmSignatureBounded, AmbiguousConfirmationError } from "./rpcResilience";

/** Jupiter's v6 swap program -- included so its program id also compresses. */
const JUPITER_V6_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

export interface ReserveAltParams {
  ssrProgramId: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  vaultAuthority: PublicKey;
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
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);
  const addresses: PublicKey[] = [
    params.ssrProgramId,
    params.reserve,
    params.reserveTokenMint,
    params.mintAuthority,
    params.vaultAuthority,
    protocolConfig,
    tvlAccrual,
    params.protocolFeeDestination,
    // The treasury's Reserve Token ATA (the mint's protocol_fee_destination_token_account).
    getAssociatedTokenAddressSync(params.reserveTokenMint, params.protocolFeeDestination, true),
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
 * One-time creation flow (Manage's "Enable one-approval trading"): creates
 * the table and extends it with the Reserve's fixed addresses in ONE wallet
 * approval, confirms it, then registers it server-side so every trader
 * benefits. The wallet pays the table's one-time rent (~0.002 SOL).
 */
export async function createAndRegisterReserveAlt(
  connection: Connection,
  wallet: WalletContextState,
  params: ReserveAltParams,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Connect a wallet first.");
  const payer = wallet.publicKey;
  const addresses = buildReserveAltAddresses(params);
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({ authority: payer, payer, recentSlot });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    lookupTable: tableAddress,
    authority: payer,
    payer,
    addresses,
  });
  const ixs: TransactionInstruction[] = [createIx, extendIx];
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
  if (outcome.status === "failed") throw new Error(`Creating the lookup table failed on-chain (${outcome.error}). Signature: ${signature}.`);
  if (outcome.status === "expired") throw new Error(`Creating the lookup table expired before confirmation -- nothing should have changed. Signature: ${signature}.`);
  if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");

  // Register (the server re-verifies the table on-chain before storing).
  const res = await fetch("/api/mainnet/reserve-alt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reserve: params.reserve.toBase58(), alt: tableAddress.toBase58() }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `The lookup table was created on-chain (${tableAddress.toBase58()}) but could not be registered yet: ${(body && body.error) || `HTTP ${res.status}`}. It can be registered again later without recreating it.`,
    );
  }
  altCache.set(params.reserve.toBase58(), { alt: tableAddress.toBase58(), at: Date.now() });
  return tableAddress.toBase58();
}
