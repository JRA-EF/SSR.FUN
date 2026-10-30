// One-approval launch: every transaction a Reserve launch can know about in
// advance is signed in ONE wallet prompt, instead of one prompt per step.
//
// Before this, a 10-asset Mainnet launch asked the wallet about 16 times: one
// prompt per funding swap, one per create-and-register batch, then one each
// for the seed's lookup table (create + extends) and the seed itself. The
// 2026-10-30 launch review called the ~10+ authorisations unacceptable UX.
//
// What is signed together in the first prompt:
//   1. every funding swap (Jupiter, built by the server proxy),
//   2. the create-and-register batches (create_reserve, every
//      initialize_reserve_asset, metadata, fee recipients, co-managers),
//   3. a lookup table for this Reserve (create + extends).
// The second prompt is the seed: its amounts are whatever the swaps really
// delivered, so it cannot be built before they land.
//
// The lookup table holds every address the seed and later mints/redeems
// touch, so it is registered as the Reserve's trading table straight after
// creation: no later mint or redeem spends two transactions creating one.
//
// Nothing here changes WHAT is submitted or in which order, only how many
// times the wallet is asked. Submission rules are unchanged: swaps land and
// are balance-verified before the Reserve is created; the Reserve is created
// before it is seeded. A pre-signed transaction whose blockhash has expired by
// the time its turn comes is simply re-signed on its own (one extra prompt),
// never resubmitted blind.
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { MAINNET_USDC_MINT, type NewReserveAddresses, type ReserveAssetAddresses } from "@ssr/sdk";
import { buildReserveAltAddresses } from "./reserveAltClient";

/** Solana's transaction size ceiling. */
const MAX_TX_BYTES = 1232;
/** Addresses per extend instruction -- 20 fits comfortably in one transaction. */
export const ALT_EXTEND_CHUNK = 20;

/** One transaction the launch built in advance, with what it is for. */
export interface PrebuiltLaunchTx {
  kind: "alt-create" | "alt-extend" | "create-and-register";
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
  /** Rebuilds this transaction with a fresh blockhash if the signed copy expired before its turn. */
  rebuild: (blockhash: string) => VersionedTransaction;
}

/** Signs batches in ONE wallet prompt each; the first batch also carries the launch's pre-built transactions. */
export interface LaunchBatchSigner {
  sign(txs: VersionedTransaction[]): Promise<VersionedTransaction[]>;
  /** The pre-built transactions, signed -- in the same prompt as the first swaps when there were any, else in a prompt of their own. */
  signedPrebuilt(): Promise<VersionedTransaction[]>;
  /** How many wallet prompts this launch has shown so far. */
  readonly prompts: number;
}

export function createLaunchBatchSigner(wallet: WalletContextState, prebuilt: PrebuiltLaunchTx[], connection?: Connection): LaunchBatchSigner {
  let signedExtras: VersionedTransaction[] | null = prebuilt.length === 0 ? [] : null;
  // Quoting a 10-asset launch takes ~30 s (the swap proxy is paced), so the
  // pre-built transactions get a FRESH blockhash at the moment of the prompt,
  // giving them the whole validity window for the swaps to land first.
  const refresh = async () => {
    if (!connection) return;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    for (const p of prebuilt) {
      p.tx = p.rebuild(blockhash);
      p.lastValidBlockHeight = lastValidBlockHeight;
    }
  };
  let prompts = 0;
  const signAll = async (txs: VersionedTransaction[]): Promise<VersionedTransaction[]> => {
    if (txs.length === 0) return [];
    prompts++;
    if (typeof wallet.signAllTransactions === "function") return wallet.signAllTransactions(txs);
    if (!wallet.signTransaction) throw new Error("This wallet cannot sign transactions.");
    const out: VersionedTransaction[] = [];
    for (const tx of txs) out.push(await wallet.signTransaction(tx));
    return out;
  };
  return {
    get prompts() {
      return prompts;
    },
    async sign(txs) {
      if (signedExtras !== null) return signAll(txs);
      await refresh();
      const all = await signAll([...txs, ...prebuilt.map((p) => p.tx)]);
      signedExtras = all.slice(txs.length);
      return all.slice(0, txs.length);
    },
    async signedPrebuilt() {
      if (signedExtras === null) {
        await refresh();
        signedExtras = await signAll(prebuilt.map((p) => p.tx));
      }
      return signedExtras;
    },
  };
}

/** A v0 transaction with no lookup tables, its priority fee (and compute limit, when given) prepended. */
export function compileLaunchTx(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], microLamports: number, computeUnitLimit?: number): VersionedTransaction {
  const budget = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
  if (computeUnitLimit !== undefined) budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budget, ...ixs] }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function fitsOneTransaction(tx: VersionedTransaction): boolean {
  try {
    return tx.serialize().length <= MAX_TX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Every address the seed, and every later mint and redeem, references for
 * this Reserve: the trading-table set (reserveAltClient.ts) plus the
 * creator's own token accounts for each asset and for the Reserve Token.
 * All are derivable before the Reserve exists. A superset is harmless: an
 * address in the table that a transaction does not use costs nothing.
 */
export function launchLookupAddresses(params: {
  ssrProgramId: PublicKey;
  owner: PublicKey;
  addresses: NewReserveAddresses;
  assets: ReserveAssetAddresses[];
}): PublicKey[] {
  const { addresses, owner } = params;
  const base = buildReserveAltAddresses({
    ssrProgramId: params.ssrProgramId,
    reserve: addresses.reserve,
    reserveTokenMint: addresses.reserveTokenMint,
    reserveTokenProgram: addresses.reserveTokenProgram,
    mintAuthority: addresses.mintAuthority,
    vaultAuthority: addresses.vaultAuthority,
    protocolFeeDestination: addresses.reserve,
    assets: params.assets.map((a) => ({ mint: a.mint.toBase58(), reserveAsset: a.reserveAsset.toBase58(), vault: a.vault.toBase58() })),
  });
  const extra: PublicKey[] = [getAssociatedTokenAddressSync(addresses.reserveTokenMint, owner, true, addresses.reserveTokenProgram)];
  const usdc = new PublicKey(MAINNET_USDC_MINT);
  extra.push(getAssociatedTokenAddressSync(usdc, owner, true));
  for (const a of params.assets) {
    try {
      extra.push(getAssociatedTokenAddressSync(a.mint, owner, true, a.tokenProgram));
    } catch {
      // An off-curve owner is impossible for a wallet; skip defensively.
    }
  }
  const seen = new Set<string>();
  return [...base, ...extra].filter((a) => {
    const k = a.toBase58();
    if (seen.has(k) || a.equals(owner)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The lookup table's create transaction and its extends, built against one
 * recent slot. The table address is fixed by (owner, recentSlot), so all of
 * them can be signed together and submitted create-first.
 */
export function buildLaunchLookupTableTxs(params: {
  owner: PublicKey;
  recentSlot: number;
  blockhash: string;
  lastValidBlockHeight: number;
  microLamports: number;
  lookupAddresses: PublicKey[];
}): { table: PublicKey; txs: PrebuiltLaunchTx[] } {
  const { owner } = params;
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: owner, payer: owner, recentSlot: params.recentSlot });
  const chunks: PublicKey[][] = [];
  for (let i = 0; i < params.lookupAddresses.length; i += ALT_EXTEND_CHUNK) chunks.push(params.lookupAddresses.slice(i, i + ALT_EXTEND_CHUNK));
  const extendIx = (chunk: PublicKey[]) => AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: owner, payer: owner, addresses: chunk });
  // The first chunk rides in the create transaction, exactly as the mint path's alt-create does.
  const createIxs = chunks.length > 0 ? [createIx, extendIx(chunks[0])] : [createIx];
  const txs: PrebuiltLaunchTx[] = [
    {
      kind: "alt-create",
      tx: compileLaunchTx(owner, params.blockhash, createIxs, params.microLamports),
      lastValidBlockHeight: params.lastValidBlockHeight,
      rebuild: (bh) => compileLaunchTx(owner, bh, createIxs, params.microLamports),
    },
  ];
  for (const chunk of chunks.slice(1)) {
    const ixs = [extendIx(chunk)];
    txs.push({
      kind: "alt-extend",
      tx: compileLaunchTx(owner, params.blockhash, ixs, params.microLamports),
      lastValidBlockHeight: params.lastValidBlockHeight,
      rebuild: (bh) => compileLaunchTx(owner, bh, ixs, params.microLamports),
    });
  }
  return { table, txs };
}

/** Registers the launch's lookup table as the Reserve's trading table. Best-effort: a mint without it simply builds its own. */
export async function registerReserveTradingTable(reserve: PublicKey, table: PublicKey, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl("/api/mainnet/reserve-alt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reserve: reserve.toBase58(), alt: table.toBase58() }),
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Waits (bounded) until a lookup table is active and holds at least `minAddresses`. */
export async function waitForLaunchTable(connection: Connection, table: PublicKey, minAddresses: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await connection.getAddressLookupTable(table).catch(() => null);
    if (resp?.value && resp.value.isActive() && resp.value.state.addresses.length >= minAddresses) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}
