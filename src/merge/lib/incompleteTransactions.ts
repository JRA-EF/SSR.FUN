// Incomplete mints and redemptions: the guardrail behind the guardrail
// (DEC-0241).
//
// Layer 1 is atomicity: a mint or redemption that fits ONE transaction is
// built that way (lib/mainnet/buildBuy.ts / buildSell.ts), so it either
// fully succeeds or nothing moves. Layer 2 is this module. A Reserve too
// large for one transaction runs as a batch -- swaps then the mint, or the
// redeem then swaps -- and a batch can stop half way: the 2026-10-14
// redemption on Reserve 6z1r...KJKTB burned the Reserve Tokens and sold two
// of three assets, then the RAY swap hit Jupiter slippage (6001), leaving RAY
// in the wallet. The product rule (Creator, 2026-10-14): a user must never be
// left holding anything except USDC or the Reserve Token.
//
// This module finds every mint/redemption the batch flows left unfinished
// (their own persisted records, ssr_pending_buys_v2 / ssr_pending_sells_v1),
// works out from the chain exactly which assets THAT flow put in the wallet
// and has not yet turned into USDC or Reserve Tokens, and converts exactly
// those back to USDC through the existing /api/mainnet/jupiter-swap proxy.
//
// Attribution is strict: only amounts proven by the flow's own confirmed
// transactions (the redeem's token deltas, the mint's reconciled swap
// outputs) are ever swept, capped by what the wallet still holds -- a
// user's own pre-existing balance of the same asset is never touched.
// Every sweep swap's signature is persisted before confirmation and
// reconciled before anything is rebuilt, so nothing is ever sold twice.
//
// Two more sources feed the same page (lib/recoveryRecords.ts): a Reserve
// creation cancelled after its seed swaps landed ("create"), and a
// completed mint whose 2% swap buffer left a little of each asset behind
// ("mint-dust"). Same attribution rule: only what that flow's own confirmed
// transactions provably put in the wallet.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { MAINNET_USDC_MINT, fetchReserveOnChain } from "@ssr/sdk";
import { clearAbandonedCreate, clearMintDust, readAbandonedCreates, readMintDust, type AbandonedCreateRecord, type MintDustRecord } from "./recoveryRecords";
import { clearPendingBuy, type PendingBuyState } from "./multiAssetBuyClient";
import { clearPendingSell, type PendingSellState } from "./multiAssetSellClient";
import { computeOwnerTokenDeltaRaw, type TokenBalanceEntry } from "./multiAssetBuyPlan";
import { fetchJupiterSwapQuote, JupiterSwapNotLandedError, submitSignedJupiterSwap, type JupiterSwapQuote } from "./jupiterSwapClient";
import { withRateLimitRetry } from "./rpcResilience";
import { assertAllSignedBy, assertSignerReady } from "./assertSigner";

const log = (msg: string, extra?: Record<string, unknown>) => {
  console.info(`[incomplete-tx] ${msg}`, extra ?? "");
};

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Wrapped SOL a Create wrapped from the user's own SOL is not a swap output -- never sold to USDC. */
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
/** Slippage for a recovery swap. Wider than a mint's 200 bps on purpose: here a failed swap is worse for the user than a slightly worse price. Still within the proxy's 500 bps ceiling. */
export const RECOVERY_SLIPPAGE_BPS = 300;

export type IncompleteKind = "mint" | "redeem" | "create" | "mint-dust";

export interface LeftoverAsset {
  mint: string;
  decimals: number;
  /** Raw amount this flow put in the wallet that is still there and not yet converted. */
  amountRaw: bigint;
}

export interface IncompleteTransaction {
  kind: IncompleteKind;
  wallet: string;
  reserve: string;
  startedAt: number;
  /** What already happened, each with its signature -- shown so the user can verify on Explorer. */
  events: { label: string; signature: string }[];
  leftovers: LeftoverAsset[];
}

// --- Sweep persistence (never sell the same leftover twice) -----------------
const SWEEP_KEY = "ssr_recovery_sweeps_v1";

interface SweepLeg {
  signature: string;
  amountRaw: string;
  confirmed?: boolean;
}
type SweepRecord = Record<string, SweepLeg[]>;

const sweepKey = (kind: IncompleteKind, wallet: string, reserve: string) => `${kind}:${wallet}:${reserve}`;

function readSweepMap(): Record<string, SweepRecord> {
  try {
    const raw = localStorage.getItem(SWEEP_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, SweepRecord>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSweepMap(map: Record<string, SweepRecord>): void {
  try {
    localStorage.setItem(SWEEP_KEY, JSON.stringify(map));
  } catch {
    // Best-effort, like every other pending-state write in this app.
  }
}

function readSweep(kind: IncompleteKind, wallet: string, reserve: string): SweepRecord {
  return readSweepMap()[sweepKey(kind, wallet, reserve)] ?? {};
}

function saveSweep(kind: IncompleteKind, wallet: string, reserve: string, record: SweepRecord): void {
  const map = readSweepMap();
  map[sweepKey(kind, wallet, reserve)] = record;
  writeSweepMap(map);
}

function clearSweep(kind: IncompleteKind, wallet: string, reserve: string): void {
  const map = readSweepMap();
  delete map[sweepKey(kind, wallet, reserve)];
  writeSweepMap(map);
}

// --- Pure attribution --------------------------------------------------------

/**
 * Pure: what is still left to convert for each asset. `attributed` is what
 * the flow provably put in the wallet, `swept` what confirmed recovery swaps
 * already sold, `held` what the wallet holds right now. The result never
 * exceeds the wallet's balance and never dips into the user's own coins.
 */
export function computeLeftovers(
  attributed: Record<string, bigint>,
  swept: Record<string, bigint>,
  held: Record<string, bigint>,
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [mint, amount] of Object.entries(attributed)) {
    if (mint === MAINNET_USDC_MINT) continue;
    const remaining = amount - (swept[mint] ?? 0n);
    const h = held[mint] ?? 0n;
    const left = remaining < h ? remaining : h;
    if (left > 0n) out[mint] = left;
  }
  return out;
}

/** Pure: what a redeem paid into the owner's wallet, minus every leg whose swap to USDC already confirmed (that leg's whole payout was sold). */
export function redeemAttribution(
  payoutByMint: Record<string, bigint>,
  legSwaps: PendingSellState["legSwaps"],
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [mint, amount] of Object.entries(payoutByMint)) {
    if (mint === MAINNET_USDC_MINT || amount <= 0n || legSwaps[mint]?.confirmed) continue;
    out[mint] = amount;
  }
  return out;
}

/**
 * Pure: what a completed mint left behind. Each asset's leftover is what the
 * flow's swaps acquired plus the mint transaction's own net token delta for
 * the owner (negative: the deposit; positive: a single atomic transaction's
 * swap output beyond the deposit). USDC, the Reserve Token and anything the
 * mint consumed from the user's own balance (a negative sum) are excluded.
 */
export function dustAttribution(acquired: Record<string, bigint>, mintTxDelta: Record<string, bigint>, exclude: string[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const mint of new Set([...Object.keys(acquired), ...Object.keys(mintTxDelta)])) {
    if (mint === MAINNET_USDC_MINT || exclude.includes(mint)) continue;
    const left = (acquired[mint] ?? 0n) + (mintTxDelta[mint] ?? 0n);
    if (left > 0n) out[mint] = left;
  }
  return out;
}

function sweptByMint(record: SweepRecord): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [mint, legs] of Object.entries(record)) {
    out[mint] = legs.filter((l) => l.confirmed).reduce((s, l) => s + BigInt(l.amountRaw), 0n);
  }
  return out;
}

// --- Chain reads -------------------------------------------------------------

type SigStatus = "confirmed" | "failed" | "unknown";

async function signatureStatus(connection: Connection, signature: string): Promise<SigStatus> {
  const { value } = await withRateLimitRetry(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), 3, 500);
  const st = value[0];
  if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "confirmed";
  if (st?.err) return "failed";
  return "unknown";
}

async function ownerDeltasFromSignature(connection: Connection, signature: string, owner: string): Promise<Record<string, bigint> | null> {
  const tx = await withRateLimitRetry(() => connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), 3, 750);
  if (!tx?.meta) return null;
  const pre = (tx.meta.preTokenBalances ?? []) as TokenBalanceEntry[];
  const post = (tx.meta.postTokenBalances ?? []) as TokenBalanceEntry[];
  const mints = new Set([...pre, ...post].filter((e) => e.owner === owner).map((e) => e.mint));
  const out: Record<string, bigint> = {};
  for (const mint of mints) out[mint] = computeOwnerTokenDeltaRaw(pre, post, owner, mint);
  return out;
}

/** Every SPL / Token-2022 balance the wallet holds, with decimals. */
export async function readWalletHoldings(connection: Connection, owner: PublicKey): Promise<Record<string, { raw: bigint; decimals: number }>> {
  const out: Record<string, { raw: bigint; decimals: number }> = {};
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await withRateLimitRetry(() => connection.getParsedTokenAccountsByOwner(owner, { programId }), 3, 750);
    for (const { account } of res.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount: string; decimals: number } } } }).parsed?.info;
      if (!info?.mint || !info.tokenAmount) continue;
      const prev = out[info.mint];
      out[info.mint] = { raw: (prev?.raw ?? 0n) + BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals };
    }
  }
  return out;
}

// --- Discovery ----------------------------------------------------------------

function readAllPending<T extends { wallet: string; reserve: string }>(key: string, wallet: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const map = raw ? (JSON.parse(raw) as Record<string, T>) : {};
    return Object.values(map ?? {}).filter((e) => e && e.wallet === wallet && typeof e.reserve === "string");
  } catch {
    return [];
  }
}

async function inspectRedeem(connection: Connection, p: PendingSellState, held: Record<string, { raw: bigint; decimals: number }>): Promise<IncompleteTransaction | null> {
  let redeemLanded = p.redeemConfirmed === true;
  if (p.redeemSignature && !redeemLanded) redeemLanded = (await signatureStatus(connection, p.redeemSignature)) === "confirmed";
  // A redeem that never landed moved nothing: there is nothing to recover.
  if (!redeemLanded || !p.redeemSignature) return null;
  const payout = await ownerDeltasFromSignature(connection, p.redeemSignature, p.wallet);
  if (!payout) throw new Error(`Could not read your redemption transaction yet (${p.redeemSignature}). Try again in a moment.`);
  // A swap still marked unconfirmed may in fact have landed: reconcile it so it is never sold twice.
  const legSwaps = { ...p.legSwaps };
  for (const [mint, leg] of Object.entries(legSwaps)) {
    if (leg.confirmed || !leg.signature) continue;
    const st = await signatureStatus(connection, leg.signature);
    if (st === "confirmed") legSwaps[mint] = { ...leg, confirmed: true };
    else if (st === "unknown") throw new Error(`A swap from this redemption could not be verified yet (${leg.signature}). Try again in a moment.`);
  }
  const attributed = redeemAttribution(payout, legSwaps);
  const left = computeLeftovers(attributed, sweptByMint(readSweep("redeem", p.wallet, p.reserve)), Object.fromEntries(Object.entries(held).map(([m, h]) => [m, h.raw])));
  const events = [{ label: "Reserve Tokens redeemed", signature: p.redeemSignature }];
  for (const [mint, leg] of Object.entries(legSwaps)) if (leg.confirmed && leg.signature) events.push({ label: `Swapped ${mint.slice(0, 4)}...${mint.slice(-4)} into USDC`, signature: leg.signature });
  return {
    kind: "redeem",
    wallet: p.wallet,
    reserve: p.reserve,
    startedAt: p.startedAt,
    events,
    leftovers: Object.entries(left).map(([mint, amountRaw]) => ({ mint, amountRaw, decimals: held[mint]?.decimals ?? 0 })),
  };
}

async function inspectMint(connection: Connection, p: PendingBuyState, held: Record<string, { raw: bigint; decimals: number }>, reserveTokenMint: string | null): Promise<IncompleteTransaction | null> {
  // If the mint itself landed, the swapped assets became Reserve Tokens: nothing to recover.
  if (p.lastMintSignature && (await signatureStatus(connection, p.lastMintSignature)) === "confirmed") return null;
  if (reserveTokenMint) {
    const rtNow = held[reserveTokenMint]?.raw ?? 0n;
    if (rtNow - BigInt(p.preMintReserveTokenRaw || "0") >= BigInt(p.expectedNetReserveTokensRaw || "0") && BigInt(p.expectedNetReserveTokensRaw || "0") > 0n) return null;
  }
  const attributed: Record<string, bigint> = {};
  const events: { label: string; signature: string }[] = [];
  for (const [mint, leg] of Object.entries(p.legFunding)) {
    let acquired = BigInt(leg.acquiredRaw ?? "0");
    // A swap submitted but not yet reconciled by the mint flow: count its real output if it landed.
    if (leg.lastSignature && (leg.status === "submitted" || leg.status === "awaiting_signature")) {
      const st = await signatureStatus(connection, leg.lastSignature);
      if (st === "unknown") throw new Error(`A swap from this mint could not be verified yet (${leg.lastSignature}). Try again in a moment.`);
      if (st === "confirmed") {
        const d = await ownerDeltasFromSignature(connection, leg.lastSignature, p.wallet);
        if (!d) throw new Error(`Could not read a swap from this mint yet (${leg.lastSignature}). Try again in a moment.`);
        if ((d[mint] ?? 0n) > 0n) acquired += d[mint];
      }
    }
    if (acquired > 0n) {
      attributed[mint] = acquired;
      if (leg.lastSignature) events.push({ label: `Swapped USDC into ${mint.slice(0, 4)}...${mint.slice(-4)}`, signature: leg.lastSignature });
    }
  }
  const left = computeLeftovers(attributed, sweptByMint(readSweep("mint", p.wallet, p.reserve)), Object.fromEntries(Object.entries(held).map(([m, h]) => [m, h.raw])));
  if (Object.keys(left).length === 0) return null;
  return {
    kind: "mint",
    wallet: p.wallet,
    reserve: p.reserve,
    startedAt: p.startedAt,
    events,
    leftovers: Object.entries(left).map(([mint, amountRaw]) => ({ mint, amountRaw, decimals: held[mint]?.decimals ?? 0 })),
  };
}

const heldRaw = (held: Record<string, { raw: bigint; decimals: number }>) => Object.fromEntries(Object.entries(held).map(([m, h]) => [m, h.raw]));
const shortMint = (mint: string) => `${mint.slice(0, 4)}...${mint.slice(-4)}`;

async function inspectCreate(connection: Connection, rec: AbandonedCreateRecord, held: Record<string, { raw: bigint; decimals: number }>): Promise<IncompleteTransaction | null> {
  // A Reserve past AssetsInitializing was seeded after all (another tab, a
  // late confirmation): its swapped assets are in the vaults, not the wallet.
  const onChain = await fetchReserveOnChain(connection, new PublicKey(rec.programId), new PublicKey(rec.reserve), []);
  if (onChain && onChain.status !== "created" && onChain.status !== "assetsInitializing") {
    clearAbandonedCreate(rec.wallet, rec.reserve);
    return null;
  }
  const attributed: Record<string, bigint> = {};
  const events: { label: string; signature: string }[] = [];
  for (const [mint, f] of Object.entries(rec.assetFunding)) {
    if (!f.lastSignature || mint === MAINNET_USDC_MINT || mint === WRAPPED_SOL_MINT) continue;
    const st = await signatureStatus(connection, f.lastSignature);
    if (st === "unknown") throw new Error(`A seed swap from this cancelled Reserve could not be verified yet (${f.lastSignature}). Try again in a moment.`);
    if (st !== "confirmed") continue;
    const d = await ownerDeltasFromSignature(connection, f.lastSignature, rec.wallet);
    if (!d) throw new Error(`Could not read a seed swap from this cancelled Reserve yet (${f.lastSignature}). Try again in a moment.`);
    if ((d[mint] ?? 0n) > 0n) {
      attributed[mint] = d[mint];
      events.push({ label: `Swapped USDC into ${shortMint(mint)}`, signature: f.lastSignature });
    }
  }
  const left = computeLeftovers(attributed, sweptByMint(readSweep("create", rec.wallet, rec.reserve)), heldRaw(held));
  if (Object.keys(left).length === 0) {
    clearAbandonedCreate(rec.wallet, rec.reserve);
    clearSweep("create", rec.wallet, rec.reserve);
    return null;
  }
  return {
    kind: "create",
    wallet: rec.wallet,
    reserve: rec.reserve,
    startedAt: rec.startedAt,
    events,
    leftovers: Object.entries(left).map(([mint, amountRaw]) => ({ mint, amountRaw, decimals: held[mint]?.decimals ?? 0 })),
  };
}

async function inspectMintDust(connection: Connection, rec: MintDustRecord, held: Record<string, { raw: bigint; decimals: number }>): Promise<IncompleteTransaction | null> {
  const delta = await ownerDeltasFromSignature(connection, rec.mintSignature, rec.wallet);
  if (!delta) throw new Error(`Could not read your mint transaction yet (${rec.mintSignature}). Try again in a moment.`);
  const acquired = Object.fromEntries(Object.entries(rec.acquiredRaw).map(([m, r]) => [m, BigInt(r || "0")]));
  const attributed = dustAttribution(acquired, delta, [rec.reserveTokenMint]);
  const left = computeLeftovers(attributed, sweptByMint(readSweep("mint-dust", rec.wallet, rec.reserve)), heldRaw(held));
  if (Object.keys(left).length === 0) {
    clearMintDust(rec.wallet, rec.reserve);
    clearSweep("mint-dust", rec.wallet, rec.reserve);
    return null;
  }
  return {
    kind: "mint-dust",
    wallet: rec.wallet,
    reserve: rec.reserve,
    startedAt: rec.startedAt,
    events: [{ label: "Reserve Tokens minted", signature: rec.mintSignature }],
    leftovers: Object.entries(left).map(([mint, amountRaw]) => ({ mint, amountRaw, decimals: held[mint]?.decimals ?? 0 })),
  };
}

/**
 * Every unfinished mint or redemption this browser recorded for `wallet`
 * that left something other than USDC or Reserve Tokens behind.
 * `reserveTokenMintOf` maps a Reserve address to its Reserve Token mint when
 * known (used to recognise a mint that did land).
 */
export async function findIncompleteTransactions(
  connection: Connection,
  owner: PublicKey,
  reserveTokenMintOf: (reserve: string) => string | null,
): Promise<IncompleteTransaction[]> {
  const wallet = owner.toBase58();
  const redemptions = readAllPending<PendingSellState>("ssr_pending_sells_v1", wallet);
  const mints = readAllPending<PendingBuyState>("ssr_pending_buys_v2", wallet);
  const creates = readAbandonedCreates(wallet);
  const dust = readMintDust(wallet);
  if (redemptions.length === 0 && mints.length === 0 && creates.length === 0 && dust.length === 0) return [];
  const held = await readWalletHoldings(connection, owner);
  const out: IncompleteTransaction[] = [];
  for (const s of redemptions) {
    const item = await inspectRedeem(connection, s, held);
    if (item && item.leftovers.length > 0) out.push(item);
  }
  for (const b of mints) {
    const item = await inspectMint(connection, b, held, reserveTokenMintOf(b.reserve));
    if (item) out.push(item);
  }
  for (const c of creates) {
    const item = await inspectCreate(connection, c, held);
    if (item) out.push(item);
  }
  for (const d of dust) {
    const item = await inspectMintDust(connection, d, held);
    if (item) out.push(item);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Cheap, synchronous check (no network) used to decide whether to show the banner at all. */
export function hasPendingRecords(wallet: string): boolean {
  return (
    readAllPending("ssr_pending_sells_v1", wallet).length > 0 ||
    readAllPending("ssr_pending_buys_v2", wallet).length > 0 ||
    readAbandonedCreates(wallet).length > 0 ||
    readMintDust(wallet).length > 0
  );
}

/** Drops this item's record without converting anything -- the assets stay in the wallet. Offered for mint dust only, which can be too small for Jupiter to route. */
export function dismissIncompleteTransaction(item: IncompleteTransaction): void {
  if (item.kind !== "mint-dust") return;
  clearMintDust(item.wallet, item.reserve);
  clearSweep(item.kind, item.wallet, item.reserve);
}

function clearSource(item: Pick<IncompleteTransaction, "kind" | "wallet" | "reserve">): void {
  if (item.kind === "redeem") clearPendingSell(item.wallet, item.reserve);
  else if (item.kind === "mint") clearPendingBuy(item.wallet, item.reserve);
  else if (item.kind === "create") clearAbandonedCreate(item.wallet, item.reserve);
  else clearMintDust(item.wallet, item.reserve);
}

// --- Recovery -------------------------------------------------------------------

export type RecoveryProgress =
  | { phase: "quoting"; index: number; total: number }
  | { phase: "awaiting-wallet"; total: number }
  | { phase: "confirming"; signature: string }
  | { phase: "verifying" };

export interface RecoveryResult {
  /** Assets fully converted. */
  converted: string[];
  /** Assets still left after the automatic retry (with the reason). */
  remaining: { mint: string; reason: string }[];
}

/**
 * Converts every leftover of `item` into USDC: one quote per asset, ONE
 * wallet approval for all of them, each swap re-broadcast until it lands.
 * A swap that definitively did not land (slippage, expired) is re-quoted and
 * re-signed once. The flow's own pending record is cleared only when nothing
 * is left, so a later visit never mistakes converted assets for a mint in
 * progress.
 */
export async function convertLeftoversToUsdc(
  connection: Connection,
  wallet: WalletContextState,
  item: IncompleteTransaction,
  onProgress?: (e: RecoveryProgress) => void,
): Promise<RecoveryResult> {
  const owner = assertSignerReady({ wallet, expectedOwner: new PublicKey(item.wallet), action: "conversion to USDC" });
  const record = readSweep(item.kind, item.wallet, item.reserve);

  // Reconcile any earlier recovery swap before building a new one.
  for (const [mint, legs] of Object.entries(record)) {
    const kept: SweepLeg[] = [];
    for (const leg of legs) {
      if (leg.confirmed) {
        kept.push(leg);
        continue;
      }
      const st = await signatureStatus(connection, leg.signature);
      if (st === "unknown") throw new Error(`An earlier conversion swap could not be verified yet (${leg.signature}). Nothing was submitted -- try again in a moment.`);
      // A failed swap moved nothing, so it is dropped.
      if (st === "confirmed") kept.push({ ...leg, confirmed: true });
    }
    record[mint] = kept;
  }
  saveSweep(item.kind, item.wallet, item.reserve, record);

  // Re-derive what is left now (the wallet may have changed since the page loaded).
  const fresh = (await findIncompleteTransactions(connection, owner, () => null)).find((t) => t.kind === item.kind && t.reserve === item.reserve);
  let todo = fresh?.leftovers ?? [];
  const converted: string[] = [];
  const remaining: { mint: string; reason: string }[] = [];

  // Attempt 0, then one automatic retry of the swaps that provably did not land.
  for (let attempt = 0; attempt < 2 && todo.length > 0; attempt++) {
    const quotes: JupiterSwapQuote[] = [];
    for (let i = 0; i < todo.length; i++) {
      onProgress?.({ phase: "quoting", index: i, total: todo.length });
      quotes.push(await fetchJupiterSwapQuote(MAINNET_USDC_MINT, todo[i].amountRaw, owner.toBase58(), RECOVERY_SLIPPAGE_BPS, undefined, todo[i].mint));
    }
    onProgress?.({ phase: "awaiting-wallet", total: quotes.length });
    const unsigned = quotes.map((q) => VersionedTransaction.deserialize(Buffer.from(q.swapTransaction, "base64")));
    let signed: VersionedTransaction[];
    if (wallet.signAllTransactions) signed = await wallet.signAllTransactions(unsigned);
    else {
      if (!wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
      signed = [];
      for (const tx of unsigned) signed.push(await wallet.signTransaction(tx));
    }
    assertAllSignedBy(signed, owner, wallet, (i) => `conversion ${i + 1} of ${signed.length}`);

    const outcomes = await Promise.allSettled(
      signed.map(async (tx, i) => {
        if (i > 0) await new Promise((r) => setTimeout(r, 150 * i));
        const leg = todo[i];
        const sig = await submitSignedJupiterSwap(connection, tx, quotes[i].lastValidBlockHeight, (signature) => {
          const rec = readSweep(item.kind, item.wallet, item.reserve);
          rec[leg.mint] = [...(rec[leg.mint] ?? []), { signature, amountRaw: leg.amountRaw.toString() }];
          saveSweep(item.kind, item.wallet, item.reserve, rec);
          onProgress?.({ phase: "confirming", signature });
        });
        const rec = readSweep(item.kind, item.wallet, item.reserve);
        rec[leg.mint] = (rec[leg.mint] ?? []).map((l) => (l.signature === sig ? { ...l, confirmed: true } : l));
        saveSweep(item.kind, item.wallet, item.reserve, rec);
        log("leftover converted to USDC", { mint: leg.mint, signature: sig });
        return leg.mint;
      }),
    );
    const retry: LeftoverAsset[] = [];
    outcomes.forEach((o, i) => {
      if (o.status === "fulfilled") converted.push(o.value);
      else if (o.reason instanceof JupiterSwapNotLandedError && attempt === 0) retry.push(todo[i]);
      else remaining.push({ mint: todo[i].mint, reason: o.reason instanceof Error ? o.reason.message : String(o.reason) });
    });
    if (retry.length > 0) {
      // Nothing moved for these: drop their records and re-quote them once.
      const rec = readSweep(item.kind, item.wallet, item.reserve);
      for (const leg of retry) rec[leg.mint] = (rec[leg.mint] ?? []).filter((l) => l.confirmed);
      saveSweep(item.kind, item.wallet, item.reserve, rec);
      log("conversion swap(s) did not land -- re-quoting once", { mints: retry.map((l) => l.mint) });
    }
    todo = retry;
  }
  if (remaining.length > 0) return { converted, remaining };

  onProgress?.({ phase: "verifying" });
  const after = (await findIncompleteTransactions(connection, owner, () => null)).find((t) => t.kind === item.kind && t.reserve === item.reserve);
  if (!after || after.leftovers.length === 0) {
    clearSource(item);
    clearSweep(item.kind, item.wallet, item.reserve);
    return { converted, remaining: [] };
  }
  return { converted, remaining: after.leftovers.map((l) => ({ mint: l.mint, reason: "Still in your wallet after conversion -- try again." })) };
}
