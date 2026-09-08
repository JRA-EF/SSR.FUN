// USDC-denominated Buy for a Mainnet Reserve (every Reserve that isn't
// purely USDC routes through here since DEC-0151): deposits a proportional
// in-kind amount of EVERY registered Reserve asset at once, in a single
// mint_reserve_tokens_in_kind call, funding each leg's genuine shortfall
// from the buyer's USDC.
//
// SERVER-BUILT, SIGN-MANY (2026-09-08 developer directive): this client no
// longer orchestrates quotes, one-transaction fit attempts, lookup-table
// creation, or fallbacks. It sends ONE request to /api/mainnet/build-buy
// (lib/mainnet/buildBuy.ts -- vault/supply/balance reads, the funding plan,
// every Jupiter quote and build, the mint, all in parallel on the server),
// asks the wallet to sign EVERY returned transaction in ONE prompt
// (signAllTransactions), and submits them in order: table setup (if any),
// swaps in parallel, then the mint -- each re-broadcast until it lands. The
// server signs nothing; every transaction is signed here by the buyer's
// own wallet.
//
// FUNDING INVARIANT (DEC-0151/DEC-0154/DEC-0155), unchanged: the buyer
// supplies ONLY USDC (plus SOL for fees/rent). Only assets THIS purchase's
// own confirmed swaps acquired count toward a leg -- reconciled from the
// recorded signatures' real on-chain token deltas, capped at what the wallet
// still holds; unrelated holdings are never consumed in place of USDC.
//
// SAFETY MODEL (DEC-0154/DEC-0155), unchanged:
//  - Per-leg persistent state (ssr_pending_buys_v2, keyed wallet+reserve):
//    survives refresh; every previously-submitted swap signature is
//    reconciled against its real status + token delta before anything is
//    rebuilt -- a confirmed swap is never repeated.
//  - Double-mint guard (shouldSubmitMint) from the buyer's REAL Reserve
//    Token balance before the mint is ever submitted.
//  - Honest failure state (buildBuyStateReport) from balances re-read after
//    the failure.
//  - Never custodies funds: acquired assets live in the buyer's own ATAs
//    until the mint deposits them.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { fetchTokenBalanceRaw, describeOnChainError, MAINNET_USDC_MINT, type ZapAssetLeg } from "@ssr/sdk";
import { partitionSwapOutcomes, JupiterSwapNotLandedError, SWAP_AUTO_RETRY_LIMIT } from "./jupiterSwapClient";
import { fetchOwnedBalanceRawSettled } from "./createReserveClient";
import { computeSwapShortfallPct } from "./createReserveResume";
import { advanceAssetFunding, type AssetFundingStatus, type PersistedAssetFunding } from "./launchFunding";
import { shouldSubmitMint, buildBuyStateReport, countableAcquiredRaw, computeOwnerTokenDeltaRaw, type BuyStateReport, type TokenBalanceEntry } from "./multiAssetBuyPlan";
import { AmbiguousConfirmationError, sendAndConfirmWithRebroadcast, withRateLimitRetry, type ConfirmationOutcome } from "./rpcResilience";
import { registerReserveAlt } from "./reserveAltClient";

/** Same threshold createReserveClient.ts's seed funding uses -- routine slippage below this is never reported as a shortfall worth warning about. */
const SHORTFALL_WARN_PCT = 0.05;
/** Rebuild the mint (fresh blockhash) when fewer than this many block heights remain before the batch's blockhash expires. */
const MINT_BLOCKHASH_MARGIN = 40;

const log = (msg: string, extra?: Record<string, unknown>) => {
  console.info(`[multi-asset-buy] ${msg}`, extra ?? "");
};

/** How many gross Reserve Tokens a USD amount targets, using the Reserve's real current NAV (already computed from live Pyth/Jupiter prices elsewhere on the page -- see DTRDetail.tsx's dtr.nav). Pure. */
export function usdToReserveTokensRequested(usdAmount: number, nav: number, reserveTokenDecimals: number): bigint {
  if (!(usdAmount > 0)) throw new Error("usdToReserveTokensRequested: usdAmount must be positive.");
  if (!(nav > 0)) throw new Error("usdToReserveTokensRequested: nav must be a real, positive, priced value.");
  return BigInt(Math.max(1, Math.floor((usdAmount / nav) * 10 ** reserveTokenDecimals)));
}

export type MultiAssetBuyProgressEvent =
  /** The server is building every transaction of this purchase (one request). */
  | { phase: "building" }
  /** The whole purchase (swaps + deposit + mint) is going through as ONE wallet-signed atomic transaction (DEC-0156). */
  | { phase: "single-transaction" }
  /** One-time setup (DEC-0171): this Reserve has no trading lookup table yet -- its create/extend transactions go first. */
  | { phase: "enabling-one-approval-trading" }
  | { phase: "swapping"; mint: string; index: number; total: number }
  | { phase: "minting" }
  /** A signed transaction is on the wire and being confirmed (re-broadcast until it lands) -- the wallet prompt is over. */
  | { phase: "confirming"; what: string; signature: string }
  | { phase: "awaiting-wallet" };

export interface MultiAssetBuyResult {
  signature: string;
  reserveTokensRequested: bigint;
  requiredAmountsRaw: bigint[];
  /** True when the mint was found to have ALREADY landed from a prior attempt (double-mint guard) -- nothing was re-submitted. */
  alreadyMinted: boolean;
}

/** Thrown on any buy failure, carrying the on-chain-verified state report the UI must show -- see multiAssetBuyPlan.ts's buildBuyStateReport. */
export class MultiAssetBuyError extends Error {
  readonly report: BuyStateReport | null;
  constructor(message: string, report: BuyStateReport | null, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "MultiAssetBuyError";
    this.report = report;
  }
}

// --- Per-purchase persistence (survives refresh/reconnect) ------------------
// A MAP keyed `${wallet}:${reserve}` (DEC-0155) so concurrent purchases of
// different Reserves never overwrite each other's records.
const PENDING_BUY_KEY = "ssr_pending_buys_v2";

export interface PendingBuyState {
  wallet: string;
  reserve: string;
  startedAt: number;
  legFunding: Record<string, PersistedAssetFunding>;
  /** The buyer's Reserve Token ATA balance read BEFORE this purchase's first attempt -- the baseline shouldSubmitMint compares against. */
  preMintReserveTokenRaw: string;
  expectedNetReserveTokensRaw: string;
  lastMintSignature?: string;
}

const pendingBuyMapKey = (wallet: string, reserve: string) => `${wallet}:${reserve}`;

function readPendingBuyMap(): Record<string, PendingBuyState> {
  try {
    const raw = localStorage.getItem(PENDING_BUY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PendingBuyState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readPendingBuy(wallet: string, reserve: string): PendingBuyState | null {
  const entry = readPendingBuyMap()[pendingBuyMapKey(wallet, reserve)];
  if (!entry || entry.wallet !== wallet || entry.reserve !== reserve) return null;
  return entry;
}

export function savePendingBuy(state: PendingBuyState): void {
  try {
    const map = readPendingBuyMap();
    map[pendingBuyMapKey(state.wallet, state.reserve)] = state;
    localStorage.setItem(PENDING_BUY_KEY, JSON.stringify(map));
  } catch {
    // Best-effort -- persistence never blocks the purchase itself.
  }
}

export function clearPendingBuy(wallet: string, reserve: string): void {
  try {
    const map = readPendingBuyMap();
    const key = pendingBuyMapKey(wallet, reserve);
    if (map[key]) {
      delete map[key];
      localStorage.setItem(PENDING_BUY_KEY, JSON.stringify(map));
    }
  } catch {
    // Best-effort.
  }
}

// --- The server's build contract (api/mainnet/build-buy.ts) -----------------

export type BuiltTxKind = "alt-create" | "alt-extend" | "swap" | "mint" | "single";
export interface BuiltTransaction {
  kind: BuiltTxKind;
  mint?: string;
  legIndex?: number;
  base64: string;
  bytes: number;
  lastValidBlockHeight: number;
}
export interface BuildBuyResponse {
  mode: "single" | "batch";
  transactions: BuiltTransaction[];
  plan: {
    legs: { mint: string; legIndex: number; decimals: number; requiredRaw: string; walletHeldRaw: string; purchaseAcquiredRaw: string; action: "swap" | "already-funded" | "wrap-recovered-sol"; usdcBudgetRaw: string; deficitRaw: string; priceUsd: number | null }[];
    expectedNetReserveTokensRaw: string;
    requiredAmountsRaw: string[];
    usdcNeededRaw: string;
    feasibility: { feasible: boolean; reasons: string[] };
    reserveTokenSupplyRaw: string;
    walletUsdcRaw: string;
    walletSolLamports: string;
    walletReserveTokenRaw: string;
  };
  reserveAlt: string | null;
  altToRegister: string | null;
  blockhash: string;
  lastValidBlockHeight: number;
  generatedAt: string;
  timings: Record<string, number>;
}

export interface BuildBuyRequest {
  reserve: string;
  wallet: string;
  reserveTokensRequested: string;
  slippageBps: number;
  assetMints: string[];
  acquiredRawByMint: Record<string, string>;
  legsOnly?: string[];
  mintOnly?: boolean;
}

/** ONE request builds every transaction; the server's error message is surfaced verbatim (it is already user-facing and specific). */
export async function requestBuyBuild(body: BuildBuyRequest, fetchImpl: typeof fetch = fetch): Promise<BuildBuyResponse> {
  const res = await fetchImpl("/api/mainnet/build-buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const json = (await res.json().catch(() => null)) as (BuildBuyResponse & { error?: string }) | null;
  if (!res.ok || !json || !Array.isArray(json.transactions)) {
    throw new Error((json && typeof json.error === "string" && json.error) || `Could not build this purchase (HTTP ${res.status}).`);
  }
  return json;
}

export interface ExecuteMultiAssetBuyParams {
  connection: Connection;
  wallet: WalletContextState;
  /** Kept for call-site compatibility -- the server derives it. */
  protocolConfig: PublicKey;
  /** Kept for call-site compatibility -- the server derives it. */
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  /** Kept for call-site compatibility -- the server derives it. */
  mintAuthority: PublicKey;
  /** The Reserve's registered assets as the page knows them -- only their mints are sent (the server re-reads everything else live). */
  assets: ZapAssetLeg[];
  /** Kept for call-site compatibility -- the server re-reads the live supply. */
  reserveTokenSupplyRaw: string;
  reserveTokensRequested: bigint;
  /** Kept for call-site compatibility -- the server computes the effective fee from the live Reserve. */
  effectiveMintFeeTotalBps: bigint;
  /** Kept for call-site compatibility -- the server prices every leg itself. */
  assetPricesUsd: Record<string, number>;
  /** Fractional slippage buffer (e.g. 0.02 = 2%) applied to each leg's mint cap and sent to Jupiter as bps. */
  slippageBps?: number;
  onProgress?: (event: MultiAssetBuyProgressEvent) => void;
  onSwapShortfall?: (info: { mint: string; targetRaw: bigint; actualRaw: bigint; shortfallPct: number }) => void;
}

/**
 * Full USDC-denominated buy: reconcile previously-recorded signatures ->
 * ONE server build -> ONE wallet prompt for every transaction -> table
 * setup (if any) -> swaps in parallel, each measured -> double-mint guard ->
 * mint -> delivery verification (the buyer's real Reserve Token balance
 * must show the mint).
 */
export async function executeMultiAssetBuyMainnet(params: ExecuteMultiAssetBuyParams): Promise<MultiAssetBuyResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const owner = params.wallet.publicKey;
  const ownerBase58 = owner.toBase58();
  const reserveBase58 = params.reserve.toBase58();
  const slippageBps = Math.round((params.slippageBps ?? 0.02) * 10_000);

  log("buy start", { reserve: reserveBase58, depositAsset: "USDC (" + MAINNET_USDC_MINT + ")", reserveTokensRequested: params.reserveTokensRequested.toString(), legs: params.assets.map((a) => a.mint) });

  const rtBalanceNow = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));

  // Per-purchase persisted state: resume an interrupted purchase's baseline
  // and acquired-asset records, or start fresh.
  let pending = readPendingBuy(ownerBase58, reserveBase58);
  if (!pending) {
    pending = { wallet: ownerBase58, reserve: reserveBase58, startedAt: Date.now(), legFunding: {}, preMintReserveTokenRaw: rtBalanceNow.toString(), expectedNetReserveTokensRaw: "0" };
    savePendingBuy(pending);
  } else {
    log("resuming a previously-started purchase", { startedAt: new Date(pending.startedAt).toISOString(), lastMintSignature: pending.lastMintSignature ?? null });
  }
  const advanceLeg = (mint: string, to: AssetFundingStatus, extra?: Partial<Pick<PersistedAssetFunding, "lastSignature" | "verifiedBalanceRaw" | "targetRaw" | "acquiredRaw">>) => {
    pending!.legFunding = advanceAssetFunding(pending!.legFunding, mint, to, extra);
    savePendingBuy(pending!);
  };
  const acquiredRawOf = (mint: string): bigint => BigInt(pending!.legFunding[mint]?.acquiredRaw ?? "0");
  const preMintBaseline = BigInt(pending.preMintReserveTokenRaw);

  // DOUBLE-MINT GUARD, part 1: a previous attempt's mint already landed.
  const expectedKnown = BigInt(pending.expectedNetReserveTokensRaw);
  if (expectedKnown > 0n && !shouldSubmitMint(preMintBaseline, rtBalanceNow, expectedKnown)) {
    log("mint already landed for this purchase (double-mint guard) -- not re-submitting", { preMintBaseline: preMintBaseline.toString(), rtBalanceNow: rtBalanceNow.toString() });
    clearPendingBuy(ownerBase58, reserveBase58);
    return { signature: pending.lastMintSignature ?? "", reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw: [], alreadyMinted: true };
  }

  // Reconcile a previously-submitted mint signature whose confirmation was never seen.
  if (pending.lastMintSignature) {
    const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([pending!.lastMintSignature!], { searchTransactionHistory: true }), 3, 500);
    const st = value[0];
    log("reconciling previously-submitted mint signature", { signature: pending.lastMintSignature, status: st?.confirmationStatus ?? "not-found", err: st?.err ?? null });
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      await fetchOwnedBalanceRawSettled(params.connection, params.reserveTokenMint, owner, preMintBaseline);
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature: pending.lastMintSignature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw: [], alreadyMinted: true };
    }
  }

  // Reconcile EVERY previously-recorded swap signature BEFORE building --
  // a confirmed swap's real output (its transaction's token delta) is
  // counted, a failed/expired one resets its leg, an unverifiable one stops.
  for (const asset of params.assets) {
    const persisted = pending.legFunding[asset.mint];
    if (!persisted?.lastSignature || !(persisted.status === "submitted" || persisted.status === "awaiting_signature")) continue;
    const signature = persisted.lastSignature;
    const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), 3, 500);
    const st = value[0];
    log("reconciling previous swap signature", { mint: asset.mint, signature, status: st?.confirmationStatus ?? "not-found", err: st?.err ?? null });
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      const parsedTx = await withRateLimitRetry(() => params.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), 3, 750);
      if (!parsedTx?.meta) {
        throw new MultiAssetBuyError(
          `A previous swap for this purchase confirmed on-chain but its delivered amount could not be verified yet (signature ${signature}). Nothing was submitted -- try again in a moment; the confirmed swap will be counted, not repeated.`,
          null,
        );
      }
      const delta = computeOwnerTokenDeltaRaw((parsedTx.meta.preTokenBalances ?? []) as TokenBalanceEntry[], (parsedTx.meta.postTokenBalances ?? []) as TokenBalanceEntry[], ownerBase58, asset.mint);
      const newAcquired = acquiredRawOf(asset.mint) + (delta > 0n ? delta : 0n);
      log("previous swap reconciled as confirmed -- output counted, never repeated", { mint: asset.mint, signature, totalAcquiredRaw: newAcquired.toString() });
      advanceLeg(asset.mint, "confirmed", { acquiredRaw: newAcquired.toString() });
    } else if (st?.err) {
      log("previous swap definitively failed on-chain -- leg reset for a clean retry", { mint: asset.mint, signature, err: st.err });
      advanceLeg(asset.mint, "not_started");
    } else {
      log("previous swap signature not found on-chain -- leg reset for a clean retry", { mint: asset.mint, signature });
      advanceLeg(asset.mint, "not_started");
    }
  }

  const acquiredRawByMint = (): Record<string, string> =>
    Object.fromEntries(params.assets.map((a) => [a.mint, acquiredRawOf(a.mint).toString()]).filter(([, v]) => v !== "0"));
  const readLegBalances = async () => Promise.all(params.assets.map((a) => fetchTokenBalanceRaw(params.connection, new PublicKey(a.mint), owner).then(BigInt)));

  let currentStage = "building this purchase on the server (nothing submitted yet)";
  let requiredAmountsRaw: bigint[] = [];
  const buildFailureReport = async (): Promise<BuyStateReport> => {
    const freshHeld = await readLegBalances().catch(() => params.assets.map(() => 0n));
    const freshRt = await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner).then(BigInt).catch(() => rtBalanceNow);
    return buildBuyStateReport(
      params.assets.map((a, i) => ({ mint: a.mint, symbol: a.mint.slice(0, 4) + "..." + a.mint.slice(-4), requiredRaw: requiredAmountsRaw[i] ?? 0n, walletHeldRaw: freshHeld[i], purchaseAcquiredRaw: acquiredRawOf(a.mint) })),
      preMintBaseline,
      freshRt,
      BigInt(pending!.expectedNetReserveTokensRaw),
      currentStage,
    );
  };

  // Signing: ONE prompt for everything when the wallet supports it; a wallet
  // without signAllTransactions signs each transaction right before it is sent.
  const canSignAll = typeof params.wallet.signAllTransactions === "function";
  const signMany = async (txs: VersionedTransaction[]): Promise<VersionedTransaction[]> => {
    if (txs.length === 0) return [];
    params.onProgress?.({ phase: "awaiting-wallet" });
    if (canSignAll) return params.wallet.signAllTransactions!(txs);
    if (!params.wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
    const out: VersionedTransaction[] = [];
    for (const tx of txs) out.push(await params.wallet.signTransaction(tx));
    return out;
  };
  const throwOutcome = (outcome: ConfirmationOutcome, signature: string, what: string, atomicNote: string) => {
    if (outcome.status === "failed") throw new Error(`${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))}${atomicNote} Signature: ${signature}.`);
    if (outcome.status === "expired") throw new Error(`${what} expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
    if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
  };
  const submit = (signed: VersionedTransaction, lastValidBlockHeight: number, what: string, onSubmitted?: (sig: string) => void) =>
    sendAndConfirmWithRebroadcast(params.connection, signed.serialize(), lastValidBlockHeight, {
      onSubmitted: (sig) => {
        onSubmitted?.(sig);
        log("transaction submitted", { what, signature: sig });
        params.onProgress?.({ phase: "confirming", what, signature: sig });
      },
    });

  try {
    // ---------------------------------------------------------------------
    // ONE server build.
    // ---------------------------------------------------------------------
    params.onProgress?.({ phase: "building" });
    const buildRequest = (extra: Partial<BuildBuyRequest> = {}): BuildBuyRequest => ({
      reserve: reserveBase58,
      wallet: ownerBase58,
      reserveTokensRequested: params.reserveTokensRequested.toString(),
      slippageBps,
      assetMints: params.assets.map((a) => a.mint),
      acquiredRawByMint: acquiredRawByMint(),
      ...extra,
    });
    const build = await requestBuyBuild(buildRequest());
    requiredAmountsRaw = build.plan.requiredAmountsRaw.map((r) => BigInt(r));
    pending.expectedNetReserveTokensRaw = build.plan.expectedNetReserveTokensRaw;
    savePendingBuy(pending);
    const expectedNetRaw = BigInt(build.plan.expectedNetReserveTokensRaw);
    log("server build", { mode: build.mode, transactions: build.transactions.map((t) => ({ kind: t.kind, mint: t.mint, bytes: t.bytes })), timings: build.timings, altToRegister: build.altToRegister });

    // DOUBLE-MINT GUARD with the now-known expected output (fresh purchase).
    if (!shouldSubmitMint(preMintBaseline, rtBalanceNow, expectedNetRaw)) {
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature: pending.lastMintSignature ?? "", reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
    }

    const decode = (t: BuiltTransaction) => VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
    const legIndexOf = (mint: string) => params.assets.findIndex((a) => a.mint === mint);
    const heldBefore = new Map(build.plan.legs.map((l) => [l.mint, BigInt(l.walletHeldRaw)]));

    // ---------------------------------------------------------------------
    // ONE wallet prompt for every transaction.
    // ---------------------------------------------------------------------
    if (build.mode === "single") params.onProgress?.({ phase: "single-transaction" });
    currentStage = build.mode === "single" ? "the single combined purchase transaction (swap, deposit, and mint in one atomic step)" : "signing every transaction of this purchase";
    const signed = await signMany(build.transactions.map(decode));
    const signedOf = (i: number) => signed[i];

    // ---------------------------------------------------------------------
    // Table setup first (if the server prepended it): sequential, confirmed,
    // then activation + registration -- the mint/single tx references it.
    // ---------------------------------------------------------------------
    const altIdx = build.transactions.map((t, i) => (t.kind === "alt-create" || t.kind === "alt-extend" ? i : -1)).filter((i) => i >= 0);
    if (altIdx.length > 0) {
      currentStage = "enabling one-approval trading for this Reserve (a one-time setup)";
      params.onProgress?.({ phase: "enabling-one-approval-trading" });
      for (const i of altIdx) {
        const t = build.transactions[i];
        const { signature, outcome } = await submit(signedOf(i), t.lastValidBlockHeight, t.kind === "alt-create" ? "the trading table creation" : "the trading table extension");
        throwOutcome(outcome, signature, "The trading-table setup", "");
      }
      if (build.altToRegister) {
        await waitForLookupTable(params.connection, new PublicKey(build.altToRegister));
        await registerReserveAlt(reserveBase58, build.altToRegister).catch((e) => log("trading table registration deferred (not fatal)", { error: String(e) }));
      }
    }

    // ---------------------------------------------------------------------
    // Mode "single": the one atomic transaction.
    // ---------------------------------------------------------------------
    const singleIdx = build.transactions.findIndex((t) => t.kind === "single");
    if (build.mode === "single" && singleIdx >= 0) {
      currentStage = "the single combined purchase transaction (swap, deposit, and mint in one atomic step)";
      const t = build.transactions[singleIdx];
      const { signature, outcome } = await submit(signedOf(singleIdx), t.lastValidBlockHeight, "your purchase transaction", (sig) => {
        pending!.lastMintSignature = sig;
        savePendingBuy(pending!);
      });
      throwOutcome(outcome, signature, "The purchase transaction", " The purchase was ONE atomic transaction, so nothing was swapped, deposited, or minted -- only the network fee was spent.");
      return await verifyDelivery(signature, rtBalanceNow);
    }

    // ---------------------------------------------------------------------
    // Mode "batch": swaps in parallel (staggered, re-broadcast, measured),
    // one automatic rebuild+re-sign for legs that provably did not land.
    // ---------------------------------------------------------------------
    type SwapJob = { tx: BuiltTransaction; signed: VersionedTransaction; mint: string; legIndex: number; preSwapRaw: bigint };
    const reconcileSwappedLeg = async (job: SwapJob) => {
      advanceLeg(job.mint, "confirmed");
      const newBalance = await fetchOwnedBalanceRawSettled(params.connection, new PublicKey(job.mint), owner, job.preSwapRaw);
      const gained = newBalance > job.preSwapRaw ? newBalance - job.preSwapRaw : 0n;
      const newAcquired = acquiredRawOf(job.mint) + gained;
      advanceLeg(job.mint, "ready_to_seed", { verifiedBalanceRaw: newBalance.toString(), acquiredRaw: newAcquired.toString() });
      log("leg funded and output measured", { mint: job.mint, deliveredRaw: gained.toString(), totalAcquiredRaw: newAcquired.toString(), requiredRaw: requiredAmountsRaw[job.legIndex]?.toString() });
      const shortfallPct = computeSwapShortfallPct(requiredAmountsRaw[job.legIndex] ?? 0n, newAcquired);
      if (shortfallPct > SHORTFALL_WARN_PCT) params.onSwapShortfall?.({ mint: job.mint, targetRaw: requiredAmountsRaw[job.legIndex] ?? 0n, actualRaw: newAcquired, shortfallPct });
    };
    const submitSwaps = (jobs: SwapJob[]) =>
      Promise.allSettled(
        jobs.map(async (job, s) => {
          params.onProgress?.({ phase: "swapping", mint: job.mint, index: s, total: jobs.length });
          if (s > 0) await new Promise((r) => setTimeout(r, 150 * s)); // stagger broadcasts
          advanceLeg(job.mint, "quoted", { targetRaw: (requiredAmountsRaw[job.legIndex] ?? 0n).toString() });
          advanceLeg(job.mint, "awaiting_signature");
          const { signature, outcome } = await submit(job.signed, job.tx.lastValidBlockHeight, `the swap for ${job.mint.slice(0, 4)}...${job.mint.slice(-4)}`, (sig) => advanceLeg(job.mint, "submitted", { lastSignature: sig }));
          if (outcome.status === "failed") throw new JupiterSwapNotLandedError("failed", signature, `${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} Signature: ${signature}.`);
          if (outcome.status === "expired") throw new JupiterSwapNotLandedError("expired", signature, `Jupiter swap expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
          if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
          await reconcileSwappedLeg(job);
        }),
      );
    const toJobs = (b: BuildBuyResponse, signedTxs: VersionedTransaction[]): SwapJob[] =>
      b.transactions
        .map((tx, i) => ({ tx, i }))
        .filter(({ tx }) => tx.kind === "swap" && tx.mint)
        .map(({ tx, i }) => ({ tx, signed: signedTxs[i], mint: tx.mint!, legIndex: legIndexOf(tx.mint!), preSwapRaw: heldBefore.get(tx.mint!) ?? 0n }));

    let jobs = toJobs(build, signed);
    currentStage = "submitting all of the Reserve's asset swaps";
    let outcomes = await submitSwaps(jobs);
    for (let attempt = 0; attempt < SWAP_AUTO_RETRY_LIMIT; attempt++) {
      const { retryable, fatal } = partitionSwapOutcomes(jobs, outcomes);
      if (fatal !== null) throw fatal;
      if (retryable.length === 0) break;
      log("swap leg(s) did not land -- rebuilding just those legs and re-signing once", { attempt: attempt + 1, mints: retryable.map((j) => j.mint) });
      currentStage = "rebuilding the Reserve asset swap(s) that did not land, for one more approval";
      for (const j of retryable) advanceLeg(j.mint, "not_started");
      params.onProgress?.({ phase: "building" });
      const rebuild = await requestBuyBuild(buildRequest({ legsOnly: retryable.map((j) => j.mint) }));
      const resigned = await signMany(rebuild.transactions.map(decode));
      for (const l of rebuild.plan.legs) heldBefore.set(l.mint, BigInt(l.walletHeldRaw));
      jobs = toJobs(rebuild, resigned);
      currentStage = "submitting the rebuilt Reserve asset swap(s)";
      outcomes = await submitSwaps(jobs);
    }
    {
      const { retryable, fatal } = partitionSwapOutcomes(jobs, outcomes);
      if (fatal !== null) throw fatal;
      if (retryable.length > 0) {
        const first = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected")!.reason as Error;
        throw new Error(`${first.message} (This swap was already automatically retried once with a fresh build and did not land either.)`);
      }
    }

    // Every leg must now be genuinely covered by THIS purchase's own
    // acquisitions, re-read after every funding transaction.
    currentStage = "verifying every Reserve asset was acquired before the final mint";
    const freshHeld = await readLegBalances();
    for (let i = 0; i < params.assets.length; i++) {
      const mint = params.assets[i].mint;
      const countable = mint === MAINNET_USDC_MINT ? freshHeld[i] : countableAcquiredRaw({ walletHeldRaw: freshHeld[i], purchaseAcquiredRaw: acquiredRawOf(mint) });
      if (countable < (requiredAmountsRaw[i] ?? 0n)) {
        throw new Error(`Reserve asset ${mint} is still short after funding: this purchase has acquired ${countable.toString()} raw of the ${requiredAmountsRaw[i].toString()} raw required. Nothing further was submitted -- retrying funds only this remaining shortfall.`);
      }
    }

    // DOUBLE-MINT GUARD, part 2: immediately before submitting.
    const rtBeforeMint = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));
    if (!shouldSubmitMint(preMintBaseline, rtBeforeMint, expectedNetRaw)) {
      log("mint landed between funding and submission (double-mint guard) -- not re-submitting");
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature: pending.lastMintSignature ?? "", reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
    }

    // ---------------------------------------------------------------------
    // The mint: pre-signed in the one prompt; rebuilt (mint-only) and
    // re-signed only if its blockhash is about to expire or expired.
    // ---------------------------------------------------------------------
    currentStage = "the final mint that deposits the acquired assets and delivers your Reserve Tokens";
    params.onProgress?.({ phase: "minting" });
    let mintIdx = build.transactions.findIndex((t) => t.kind === "mint");
    let mintTx = mintIdx >= 0 ? build.transactions[mintIdx] : null;
    let mintSigned = mintIdx >= 0 ? signedOf(mintIdx) : null;
    const rebuildMint = async () => {
      params.onProgress?.({ phase: "building" });
      const rebuild = await requestBuyBuild(buildRequest({ mintOnly: true }));
      const idx = rebuild.transactions.findIndex((t) => t.kind === "mint");
      if (idx < 0) throw new Error("The server did not return a mint transaction on rebuild.");
      mintTx = rebuild.transactions[idx];
      [mintSigned] = await signMany([decode(mintTx)]);
      mintIdx = idx;
    };
    if (!mintTx || !mintSigned) await rebuildMint();
    const heightNow = await withRateLimitRetry(() => params.connection.getBlockHeight("confirmed"), 3, 500).catch(() => 0);
    if (mintTx && heightNow > 0 && heightNow > mintTx.lastValidBlockHeight - MINT_BLOCKHASH_MARGIN) {
      log("mint blockhash near expiry after the swaps -- rebuilding the mint with a fresh blockhash", { heightNow, lastValidBlockHeight: mintTx.lastValidBlockHeight });
      await rebuildMint();
    }
    let signature = "";
    for (let attempt = 0; ; attempt++) {
      const sent = await submit(mintSigned!, mintTx!.lastValidBlockHeight, "the mint that delivers your Reserve Tokens", (sig) => {
        pending!.lastMintSignature = sig;
        savePendingBuy(pending!);
      });
      signature = sent.signature;
      if (sent.outcome.status === "expired" && attempt === 0) {
        log("mint expired unlanded -- rebuilding once with a fresh blockhash", { signature });
        await rebuildMint();
        continue;
      }
      throwOutcome(sent.outcome, signature, "The mint", "");
      break;
    }
    return await verifyDelivery(signature, rtBeforeMint);
  } catch (e) {
    if (e instanceof AmbiguousConfirmationError) throw e; // DTRDetail's reconcileBuy path owns this case.
    const report = await buildFailureReport().catch(() => null);
    log("buy failed -- verified state report", { error: e instanceof Error ? e.message : String(e), stage: currentStage, report });
    throw new MultiAssetBuyError(e instanceof Error ? e.message : String(e), report, e);
  }

  // DELIVERY VERIFICATION: success is only ever reported after the buyer's
  // REAL Reserve Token balance shows the minted output.
  async function verifyDelivery(signature: string, before: bigint): Promise<MultiAssetBuyResult> {
    currentStage = "verifying your Reserve Tokens actually arrived after the mint";
    const rtAfter = await fetchOwnedBalanceRawSettled(params.connection, params.reserveTokenMint, owner, before);
    log("post-mint verification", { buyerReserveTokenBefore: before.toString(), buyerReserveTokenAfter: rtAfter.toString() });
    if (rtAfter <= before) {
      throw new Error(`The mint transaction confirmed but your Reserve Token balance has not increased yet (before ${before.toString()}, now ${rtAfter.toString()} raw). Signature: ${signature}. Check the signature on Explorer before retrying.`);
    }
    clearPendingBuy(ownerBase58, reserveBase58);
    return { signature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: false };
  }
}

/** A lookup table only becomes referenceable once the chain has advanced past the slot of its last extension -- bounded wait for it to be fully readable and active. */
export async function waitForLookupTable(connection: Connection, table: PublicKey, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await connection.getAddressLookupTable(table).catch(() => null);
    if (res?.value?.isActive()) {
      const slotNow = await connection.getSlot("confirmed").catch(() => 0);
      if (slotNow > res.value.state.lastExtendedSlot) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
