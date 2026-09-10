// USDC-settled Sell for a Mainnet Reserve that is not purely USDC
// (DEC-0158) -- the exact inverse of multiAssetBuyClient.ts, completing the
// funding invariant's sell side: Reserve Tokens out -> USDC in. One
// redeem_reserve_tokens_in_kind pays the redeemer's proportional
// entitlement of every leg into their own ATAs, and every non-USDC leg is
// then sold INTO USDC via Jupiter (every swap built with
// wrapAndUnwrapSol:false -- nothing ever unwraps or closes the seller's
// wSOL ATA mid-flow; see DEC-0156's live root cause).
//
// SERVER-BUILT, SIGN-MANY (2026-09-08 developer directive): ONE request to
// /api/mainnet/build-sell (lib/mainnet/buildSell.ts) returns every unsigned
// transaction -- either ONE atomic v0 transaction (redeem + every swap,
// when it fits) or [redeem, swap 1..N] -- the wallet signs them all in ONE
// prompt, and this client submits the redeem first (confirmed, re-broadcast
// until it lands), then every swap in parallel. Nothing is quoted or
// composed in the browser anymore. The server signs nothing.
//
// The persisted per-sale state machine is unchanged (ssr_pending_sells_v1,
// wallet+reserve-keyed): the redeem signature and every leg's swap signature
// are recorded when submitted and reconciled against real on-chain status
// before anything is rebuilt -- a confirmed redeem is never repeated (never
// burns Reserve Tokens twice), a confirmed swap is never repeated, and the
// sale resumes exactly where it stopped across refresh/reconnect.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { fetchTokenBalanceRaw, describeOnChainError, MAINNET_USDC_MINT, type ZapAssetLeg } from "@ssr/sdk";
import { JupiterSwapNotLandedError, partitionSwapOutcomes, SWAP_AUTO_RETRY_LIMIT } from "./jupiterSwapClient";
import { fetchOwnedBalanceRawSettled } from "./createReserveClient";
import { AmbiguousConfirmationError, sendAndConfirmWithRebroadcast, withRateLimitRetry, type ConfirmationOutcome } from "./rpcResilience";
import { registerReserveAlt } from "./reserveAltClient";
import { waitForLookupTable, type BuiltTransaction, type TradeTaxPlan } from "./multiAssetBuyClient";

const log = (msg: string, extra?: Record<string, unknown>) => {
  console.info(`[multi-asset-sell] ${msg}`, extra ?? "");
};

export type MultiAssetSellProgressEvent =
  /** The server is building every transaction of this sale (one request). */
  | { phase: "building" }
  | { phase: "single-transaction" }
  | { phase: "redeeming" }
  | { phase: "swapping"; mint: string; index: number; total: number }
  /** The manager's Sell tax (DEC-0198) is being paid out of the USDC proceeds -- the last step of a batch-mode sale. */
  | { phase: "paying-tax" }
  /** A signed transaction is on the wire and being confirmed (re-broadcast until it lands) -- the wallet prompt is over. */
  | { phase: "confirming"; what: string; signature: string }
  | { phase: "awaiting-wallet" };

export interface MultiAssetSellResult {
  signature: string;
  reserveTokensRedeemed: bigint;
  /** Real, measured USDC (raw) the seller's balance gained across the sale. */
  usdcReceivedRaw: bigint;
}

// --- Per-sale persistence ----------------------------------------------------
const PENDING_SELL_KEY = "ssr_pending_sells_v1";

export interface PendingSellState {
  wallet: string;
  reserve: string;
  startedAt: number;
  reserveTokensToRedeem: string;
  /** The seller's Reserve Token balance BEFORE the redeem -- the double-redeem guard's baseline. */
  preRedeemRtRaw: string;
  /** The seller's USDC balance when the sale began -- the final received figure is measured against this. */
  preSaleUsdcRaw: string;
  redeemSignature?: string;
  redeemConfirmed?: boolean;
  /** Per-leg swap progress: mint -> last submitted signature + whether it confirmed. */
  legSwaps: Record<string, { signature?: string; confirmed?: boolean }>;
  /** Sell tax (DEC-0198): the USDC base the original build taxed, so an expired tax transaction can be rebuilt on the same base. */
  taxBaseUsdcRaw?: string;
  taxSignature?: string;
  taxConfirmed?: boolean;
}

function readPendingSellMap(): Record<string, PendingSellState> {
  try {
    const raw = localStorage.getItem(PENDING_SELL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PendingSellState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readPendingSell(wallet: string, reserve: string): PendingSellState | null {
  const entry = readPendingSellMap()[`${wallet}:${reserve}`];
  if (!entry || entry.wallet !== wallet || entry.reserve !== reserve) return null;
  return entry;
}

export function savePendingSell(state: PendingSellState): void {
  try {
    const map = readPendingSellMap();
    map[`${state.wallet}:${state.reserve}`] = state;
    localStorage.setItem(PENDING_SELL_KEY, JSON.stringify(map));
  } catch {
    // Best-effort -- persistence never blocks the sale itself.
  }
}

export function clearPendingSell(wallet: string, reserve: string): void {
  try {
    const map = readPendingSellMap();
    if (map[`${wallet}:${reserve}`]) {
      delete map[`${wallet}:${reserve}`];
      localStorage.setItem(PENDING_SELL_KEY, JSON.stringify(map));
    }
  } catch {
    // Best-effort.
  }
}

// --- The server's build contract (api/mainnet/build-sell.ts) ---------------

export interface BuildSellResponse {
  mode: "single" | "batch";
  transactions: BuiltTransaction[];
  plan: {
    legs: { mint: string; legIndex: number; decimals: number; entitlementRaw: string; walletHeldRaw: string; amountInRaw: string; action: "swap" | "usdc" | "skip"; quotedUsdcOutRaw: string }[];
    reserveTokensToRedeem: string;
    entitlementsRaw: string[];
    quotedUsdcOutRaw: string;
    reserveTokenSupplyRaw: string;
    walletReserveTokenRaw: string;
    walletUsdcRaw: string;
    walletSolLamports: string;
    tradeTax?: TradeTaxPlan | null;
  };
  reserveAlt: string | null;
  altToRegister: string | null;
  blockhash: string;
  lastValidBlockHeight: number;
  generatedAt: string;
  timings: Record<string, number>;
}

export interface BuildSellRequest {
  reserve: string;
  wallet: string;
  reserveTokensToRedeem: string;
  slippageBps?: number;
  assetMints: string[];
  legsOnly?: string[];
  redeemDone?: boolean;
  /** Rebuild only the Sell-tax transaction on this base (DEC-0198). */
  taxOnly?: boolean;
  taxBaseUsdcRaw?: string;
}

export async function requestSellBuild(body: BuildSellRequest, fetchImpl: typeof fetch = fetch): Promise<BuildSellResponse> {
  const res = await fetchImpl("/api/mainnet/build-sell", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const json = (await res.json().catch(() => null)) as (BuildSellResponse & { error?: string }) | null;
  if (!res.ok || !json || !Array.isArray(json.transactions)) {
    throw new Error((json && typeof json.error === "string" && json.error) || `Could not build this sale (HTTP ${res.status}).`);
  }
  return json;
}

export interface ExecuteMultiAssetSellParams {
  connection: Connection;
  wallet: WalletContextState;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  /** Kept for call-site compatibility -- the server derives it. */
  vaultAuthority: PublicKey;
  assets: ZapAssetLeg[];
  /** Kept for call-site compatibility -- the server re-reads the live supply. */
  reserveTokenSupplyRaw: string;
  /** Kept for call-site compatibility -- the server reads the live fee. */
  redemptionFeeBps: bigint;
  reserveTokensToRedeem: bigint;
  onProgress?: (event: MultiAssetSellProgressEvent) => void;
}

/**
 * Full USDC-settled sell: reconcile the persisted sale -> ONE server build
 * -> ONE wallet prompt -> redeem (confirmed) -> every leg's swap in
 * parallel (each re-broadcast; legs that provably did not land rebuilt and
 * re-signed once) -> the seller's REAL USDC balance re-read; the result
 * carries the measured gain, never an estimate.
 */
export async function executeMultiAssetSellMainnet(params: ExecuteMultiAssetSellParams): Promise<MultiAssetSellResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const owner = params.wallet.publicKey;
  const ownerBase58 = owner.toBase58();
  const reserveBase58 = params.reserve.toBase58();
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);

  log("sell start", { reserve: reserveBase58, reserveTokensToRedeem: params.reserveTokensToRedeem.toString(), legs: params.assets.map((a) => a.mint) });

  const [preSaleUsdcRaw, preRedeemRtRaw] = await Promise.all([
    fetchTokenBalanceRaw(params.connection, usdcMint, owner).then(BigInt),
    fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner).then(BigInt),
  ]);

  let pending = readPendingSell(ownerBase58, reserveBase58);
  if (!pending) {
    if (preRedeemRtRaw < params.reserveTokensToRedeem) {
      throw new Error(`This wallet holds ${preRedeemRtRaw.toString()} raw Reserve Tokens but the sale needs ${params.reserveTokensToRedeem.toString()} raw. Nothing was submitted.`);
    }
    pending = {
      wallet: ownerBase58,
      reserve: reserveBase58,
      startedAt: Date.now(),
      reserveTokensToRedeem: params.reserveTokensToRedeem.toString(),
      preRedeemRtRaw: preRedeemRtRaw.toString(),
      preSaleUsdcRaw: preSaleUsdcRaw.toString(),
      legSwaps: {},
    };
    savePendingSell(pending);
  } else {
    log("resuming a previously-started sale", { startedAt: new Date(pending.startedAt).toISOString(), redeemSignature: pending.redeemSignature ?? null });
  }
  const baselineUsdcRaw = BigInt(pending.preSaleUsdcRaw);

  const verifyDelivery = async (signature: string): Promise<MultiAssetSellResult> => {
    const usdcAfter = await fetchOwnedBalanceRawSettled(params.connection, usdcMint, owner, baselineUsdcRaw);
    const gained = usdcAfter > baselineUsdcRaw ? usdcAfter - baselineUsdcRaw : 0n;
    log("post-sale verification", { usdcBefore: baselineUsdcRaw.toString(), usdcAfter: usdcAfter.toString(), gainedRaw: gained.toString() });
    if (gained <= 0n) {
      throw new Error(`The sale confirmed but your USDC balance has not increased yet (still ${usdcAfter.toString()} raw). Signature: ${signature}. Check the signature on Explorer before retrying.`);
    }
    clearPendingSell(ownerBase58, reserveBase58);
    return { signature, reserveTokensRedeemed: params.reserveTokensToRedeem, usdcReceivedRaw: gained };
  };

  const reconcileSignature = async (signature: string): Promise<"confirmed" | "failed" | "unknown"> => {
    const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), 3, 500);
    const st = value[0];
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "confirmed";
    if (st?.err) return "failed";
    return "unknown";
  };

  // --- The redeem: exactly once. ---
  let redeemDone = pending.redeemConfirmed === true;
  if (!redeemDone && pending.redeemSignature) {
    const status = await reconcileSignature(pending.redeemSignature);
    log("reconciling previous redeem signature", { signature: pending.redeemSignature, status });
    if (status === "confirmed") redeemDone = true;
    else if (status === "unknown") {
      throw new Error(`A previous redeem for this sale could not be verified yet (signature ${pending.redeemSignature}). Nothing was submitted -- try again in a moment; a landed redeem will be counted, never repeated.`);
    }
  }
  if (!redeemDone && BigInt(pending.preRedeemRtRaw) - preRedeemRtRaw >= params.reserveTokensToRedeem) {
    log("redeem already landed for this sale (balance guard) -- not re-submitting");
    redeemDone = true;
  }
  if (redeemDone) {
    pending.redeemConfirmed = true;
    savePendingSell(pending);
  }

  // --- Legs: reconcile any previously-submitted swap before rebuilding. ---
  const nonUsdcMints = params.assets.map((a) => a.mint).filter((m) => m !== MAINNET_USDC_MINT);
  const remainingLegs: string[] = [];
  for (const mint of nonUsdcMints) {
    const persisted = pending.legSwaps[mint];
    if (persisted?.confirmed) continue;
    if (persisted?.signature) {
      const status = await reconcileSignature(persisted.signature);
      log("reconciling previous sell-swap signature", { mint, signature: persisted.signature, status });
      if (status === "confirmed") {
        pending.legSwaps[mint] = { ...persisted, confirmed: true };
        savePendingSell(pending);
        continue;
      }
      if (status === "unknown") {
        throw new Error(`A previous swap for this sale could not be verified yet (signature ${persisted.signature}). Nothing was submitted -- try again in a moment; a landed swap will be counted, never repeated.`);
      }
    }
    remainingLegs.push(mint);
  }
  let lastSignature = pending.redeemSignature ?? "";
  if (redeemDone && remainingLegs.length === 0) return await verifyDelivery(lastSignature);

  // Signing: ONE prompt for everything when the wallet supports it.
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
  const submit = (signed: VersionedTransaction, lastValidBlockHeight: number, what: string, onSubmitted?: (sig: string) => void) =>
    sendAndConfirmWithRebroadcast(params.connection, signed.serialize(), lastValidBlockHeight, {
      onSubmitted: (sig) => {
        onSubmitted?.(sig);
        log("transaction submitted", { what, signature: sig });
        params.onProgress?.({ phase: "confirming", what, signature: sig });
      },
    });
  const throwOutcome = (outcome: ConfirmationOutcome, signature: string, what: string, note: string) => {
    if (outcome.status === "failed") throw new Error(`${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))}${note} Signature: ${signature}.`);
    if (outcome.status === "expired") throw new Error(`${what} expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
    if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
  };
  const decode = (t: BuiltTransaction) => VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));

  // --- ONE server build. ---
  params.onProgress?.({ phase: "building" });
  const buildRequest = (extra: Partial<BuildSellRequest> = {}): BuildSellRequest => ({
    reserve: reserveBase58,
    wallet: ownerBase58,
    reserveTokensToRedeem: params.reserveTokensToRedeem.toString(),
    assetMints: params.assets.map((a) => a.mint),
    redeemDone,
    ...(redeemDone && remainingLegs.length < nonUsdcMints.length ? { legsOnly: remainingLegs } : {}),
    ...extra,
  });
  const build = await requestSellBuild(buildRequest());
  log("server build", { mode: build.mode, transactions: build.transactions.map((t) => ({ kind: t.kind, mint: t.mint, bytes: t.bytes })), timings: build.timings, quotedUsdcOutRaw: build.plan.quotedUsdcOutRaw });

  if (build.mode === "single") params.onProgress?.({ phase: "single-transaction" });
  const signed = await signMany(build.transactions.map(decode));

  // Table setup first (if prepended).
  const altIdx = build.transactions.map((t, i) => (t.kind === "alt-create" || t.kind === "alt-extend" ? i : -1)).filter((i) => i >= 0);
  for (const i of altIdx) {
    const t = build.transactions[i];
    const { signature, outcome } = await submit(signed[i], t.lastValidBlockHeight, t.kind === "alt-create" ? "the trading table creation" : "the trading table extension");
    throwOutcome(outcome, signature, "The trading-table setup", "");
  }
  if (altIdx.length > 0 && build.altToRegister) {
    await waitForLookupTable(params.connection, new PublicKey(build.altToRegister));
    await registerReserveAlt(reserveBase58, build.altToRegister).catch((e) => log("trading table registration deferred (not fatal)", { error: String(e) }));
  }

  // Mode "single": one atomic transaction.
  const singleIdx = build.transactions.findIndex((t) => t.kind === "single");
  if (build.mode === "single" && singleIdx >= 0) {
    const t = build.transactions[singleIdx];
    const { signature, outcome } = await submit(signed[singleIdx], t.lastValidBlockHeight, "your sale transaction", (sig) => {
      pending!.redeemSignature = sig;
      savePendingSell(pending!);
    });
    throwOutcome(outcome, signature, "The sale transaction", " The sale was ONE atomic transaction, so nothing was redeemed or swapped -- only the network fee was spent.");
    return await verifyDelivery(signature);
  }

  // Mode "batch": the redeem first, confirmed; then every swap in parallel.
  const redeemIdx = build.transactions.findIndex((t) => t.kind === "redeem");
  if (!redeemDone && redeemIdx >= 0) {
    params.onProgress?.({ phase: "redeeming" });
    const t = build.transactions[redeemIdx];
    const { signature, outcome } = await submit(signed[redeemIdx], t.lastValidBlockHeight, "the redeem of your Reserve Tokens", (sig) => {
      pending!.redeemSignature = sig;
      savePendingSell(pending!);
    });
    throwOutcome(outcome, signature, "The redeem", "");
    pending.redeemConfirmed = true;
    savePendingSell(pending);
    lastSignature = signature;
    redeemDone = true;
  } else if (!redeemDone) {
    throw new Error("The server did not return a redeem transaction for a sale whose redeem has not landed yet.");
  }

  type SwapJob = { tx: BuiltTransaction; signed: VersionedTransaction; mint: string };
  const toJobs = (b: BuildSellResponse, s: VersionedTransaction[]): SwapJob[] =>
    b.transactions.map((tx, i) => ({ tx, i })).filter(({ tx }) => tx.kind === "swap" && tx.mint).map(({ tx, i }) => ({ tx, signed: s[i], mint: tx.mint! }));
  const submitSwaps = (jobs: SwapJob[]) =>
    Promise.allSettled(
      jobs.map(async (job, s) => {
        params.onProgress?.({ phase: "swapping", mint: job.mint, index: s, total: jobs.length });
        if (s > 0) await new Promise((r) => setTimeout(r, 150 * s));
        const { signature, outcome } = await submit(job.signed, job.tx.lastValidBlockHeight, `selling ${job.mint.slice(0, 4)}...${job.mint.slice(-4)} into USDC`, (sig) => {
          pending!.legSwaps[job.mint] = { signature: sig };
          savePendingSell(pending!);
        });
        if (outcome.status === "failed") throw new JupiterSwapNotLandedError("failed", signature, `${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} Signature: ${signature}.`);
        if (outcome.status === "expired") throw new JupiterSwapNotLandedError("expired", signature, `Jupiter swap expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
        if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
        pending!.legSwaps[job.mint] = { signature, confirmed: true };
        savePendingSell(pending!);
        lastSignature = signature;
        log("leg sold into USDC", { mint: job.mint, signature });
      }),
    );

  let jobs = toJobs(build, signed);
  let outcomes = await submitSwaps(jobs);
  for (let attempt = 0; attempt < SWAP_AUTO_RETRY_LIMIT; attempt++) {
    const { retryable, fatal } = partitionSwapOutcomes(jobs, outcomes);
    if (fatal !== null) throw fatal;
    if (retryable.length === 0) break;
    log("sell-swap leg(s) did not land -- rebuilding just those legs and re-signing once", { attempt: attempt + 1, mints: retryable.map((j) => j.mint) });
    params.onProgress?.({ phase: "building" });
    const rebuild = await requestSellBuild(buildRequest({ redeemDone: true, legsOnly: retryable.map((j) => j.mint) }));
    const resigned = await signMany(rebuild.transactions.map(decode));
    jobs = toJobs(rebuild, resigned);
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

  // --- Sell tax (DEC-0198): the LAST step, only after every swap landed. ---
  // The original build's tax transaction (signed in the same prompt) pays the
  // manager's Sell tax out of the USDC that just arrived. If its blockhash
  // expired by now, ONE rebuild on the same persisted base (taxOnly) and one
  // more signature. A tax that fails on-chain is logged and does not undo the
  // sale -- the seller already holds the USDC.
  await payTaxIfAny(build, signed);

  return await verifyDelivery(lastSignature);

  async function payTaxIfAny(b: BuildSellResponse, s: VersionedTransaction[]): Promise<void> {
    const taxIdx = b.transactions.findIndex((t) => t.kind === "tax");
    if (taxIdx < 0 || !b.plan.tradeTax) return;
    if (pending!.taxConfirmed) return;
    pending!.taxBaseUsdcRaw = b.plan.tradeTax.baseUsdcRaw;
    savePendingSell(pending!);
    if (pending!.taxSignature) {
      const status = await reconcileSignature(pending!.taxSignature);
      log("reconciling previous sell-tax signature", { signature: pending!.taxSignature, status });
      if (status === "confirmed") {
        pending!.taxConfirmed = true;
        savePendingSell(pending!);
        return;
      }
    }
    params.onProgress?.({ phase: "paying-tax" });
    const attempt = async (tx: BuiltTransaction, signedTx: VersionedTransaction) =>
      submit(signedTx, tx.lastValidBlockHeight, `the ${b.plan.tradeTax!.taxPct.toFixed(2)}% Sell tax`, (sig) => {
        pending!.taxSignature = sig;
        savePendingSell(pending!);
      });
    let { signature, outcome } = await attempt(b.transactions[taxIdx], s[taxIdx]);
    if (outcome.status === "expired") {
      log("sell-tax transaction expired -- rebuilding it once on the same base");
      params.onProgress?.({ phase: "building" });
      const rebuild = await requestSellBuild(buildRequest({ redeemDone: true, taxOnly: true, taxBaseUsdcRaw: b.plan.tradeTax.baseUsdcRaw }));
      const idx = rebuild.transactions.findIndex((t) => t.kind === "tax");
      if (idx < 0) return;
      const resigned = await signMany(rebuild.transactions.map(decode));
      ({ signature, outcome } = await attempt(rebuild.transactions[idx], resigned[idx]));
    }
    if (outcome.status === "confirmed") {
      pending!.taxConfirmed = true;
      savePendingSell(pending!);
      log("sell tax paid", { signature, taxUsdcRaw: b.plan.tradeTax.taxUsdcRaw });
      return;
    }
    log("sell tax NOT paid (sale itself is complete)", { signature, outcome });
  }
}
