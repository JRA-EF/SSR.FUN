// USDC-denominated Buy for a Mainnet Reserve (every Reserve that isn't
// purely USDC routes through here since DEC-0151) -- deposits a proportional
// in-kind amount of EVERY registered Reserve asset at once, in a single
// mint_reserve_tokens_in_kind call, funding each leg's genuine shortfall
// from the buyer's USDC (see multiAssetBuyPlan.ts's planBuyFunding, the
// pure planning brain this module executes).
//
// FUNDING INVARIANT (DEC-0151/DEC-0154/DEC-0155): the buyer supplies ONLY
// USDC (plus SOL for network fees/rent, which is never spent INTO the
// purchase). Every leg is acquired by a real Jupiter swap from USDC (a
// wrapped-SOL leg's swap is built with receiveWrappedSol so the output
// stays SPL wrapped SOL). Only assets THIS purchase's own confirmed swaps
// acquired count toward a leg -- reconciled from the recorded signatures'
// real on-chain token deltas, capped at what the wallet still holds. Assets
// the wallet already held for other reasons are NEVER silently consumed in
// place of the quoted USDC (the live 2026-08-25 CHARLI buy's wallet held
// 154k pre-existing SSR and 0.0515 wSOL wrapped from native SOL; an earlier
// version would have "funded" the whole purchase from those, charging
// almost none of the quoted USDC).
//
// SAFETY MODEL (DEC-0154/DEC-0155, after the live failed CHARLI buys):
//  - Whole-purchase feasibility gate (assessBuyFeasibility) BEFORE any
//    transaction is constructed: real USDC balance vs. the full plan's
//    cost, real SOL balance vs. fees/rent -- shown as current-vs-required,
//    never discovered mid-flight as an on-chain InsufficientFunds.
//  - Per-leg persistent state (launchFunding.ts's PersistedAssetFunding
//    machine, stored under ssr_pending_buys_v2 as a map keyed by
//    wallet+reserve so concurrent purchases of different Reserves never
//    overwrite each other's records): survives refresh/reconnect; every
//    previously-submitted swap signature is reconciled against its real
//    on-chain status AND its transaction's actual token delta before any
//    planning -- a confirmed swap is never repeated, a failed one is
//    cleanly restarted, and an unverifiable one stops the purchase with
//    nothing submitted rather than guessing.
//  - Double-mint guard (shouldSubmitMint): before the final mint is ever
//    submitted, the buyer's REAL Reserve Token balance is re-read; if it
//    already grew by the expected output since this purchase began, a prior
//    attempt's mint landed and nothing is re-submitted.
//  - Honest failure state (buildBuyStateReport): on any failure, every
//    leg's REAL balances and the REAL Reserve Token balance are re-read and
//    reported -- the exact stage that failed, what this purchase acquired,
//    what the wallet holds, whether the Reserve Token was minted, and
//    exactly what retry will do. Never claimed from client-side state alone.
//  - Never custodies funds: every transaction is signed by the buyer's own
//    wallet; acquired assets live in the buyer's own ATAs until the mint
//    deposits them.
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { SINGLE_TX_MICRO_LAMPORTS_PER_CU as MINT_TX_MICRO_LAMPORTS_PER_CU_SOURCE } from "./singleTxBuy";

/** Compute-unit ceiling for the standalone (fallback) mint transaction: a 12-leg mint plus ATA creations stays well under this, and the priority fee scales with it (~0.06 SOL-cent at 100k microlamports/CU). */
const MINT_TX_COMPUTE_UNIT_LIMIT = 600_000;
const SINGLE_TX_MICRO_LAMPORTS_PER_CU = MINT_TX_MICRO_LAMPORTS_PER_CU_SOURCE;
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  buildDirectMultiAssetMintInstructions,
  fetchTokenBalanceRaw,
  computeMintRequirements,
  computeNetMintOutput,
  describeOnChainError,
  findVaultAuthority,
  MAINNET_USDC_MINT,
  type ZapAssetLeg,
} from "@ssr/sdk";
import {
  fetchJupiterSwapQuote,
  executeJupiterSwap,
  submitSignedJupiterSwap,
  fetchJupiterSwapInstructions,
  partitionSwapOutcomes,
  JupiterSwapNotLandedError,
  SWAP_AUTO_RETRY_LIMIT,
  type JupiterSwapInstructionsResult,
  type JupiterSwapQuote,
} from "./jupiterSwapClient";
import {
  assembleSingleBuyInstructions,
  buildWrapRecoveredSolInstructions,
  compileSingleBuyTransaction,
  fetchLookupTables,
  wouldFitWithReserveAlt,
  SingleTxTooLargeError,
  SINGLE_TX_SWAP_MAX_ACCOUNTS,
} from "./singleTxBuy";
import { packInstructionsBySize, fetchOwnedBalanceRawSettled } from "./createReserveClient";
import { computeSwapShortfallPct } from "./createReserveResume";
import { advanceAssetFunding, type AssetFundingStatus, type PersistedAssetFunding } from "./launchFunding";
import {
  planBuyFunding,
  assessBuyFeasibility,
  shouldSubmitMint,
  buildBuyStateReport,
  countableAcquiredRaw,
  computeOwnerTokenDeltaRaw,
  type BuyLegInput,
  type BuyStateReport,
  type TokenBalanceEntry,
} from "./multiAssetBuyPlan";
import { AmbiguousConfirmationError, sendAndConfirmWithRebroadcast } from "./rpcResilience";
import { withRateLimitRetry } from "./rpcResilience";
import { buildReserveAltAddresses, createAndRegisterReserveAlt, fetchReserveAltAddress } from "./reserveAltClient";

/** Same threshold createReserveClient.ts's seed funding uses -- routine slippage below this is never reported as a shortfall worth warning about. */
const SHORTFALL_WARN_PCT = 0.05;

const log = (msg: string, extra?: Record<string, unknown>) => {
  // Deliberate, targeted diagnostics (DEC-0154): deposit asset, quotes,
  // signatures, per-leg state, balance reads, and retry decisions were all
  // invisible during the live failed-buy investigation.
  console.info(`[multi-asset-buy] ${msg}`, extra ?? "");
};

/** How many gross Reserve Tokens a USD amount targets, using the Reserve's real current NAV (already computed from live Pyth/Jupiter prices elsewhere on the page -- see DTRDetail.tsx's dtr.nav). Pure. */
export function usdToReserveTokensRequested(usdAmount: number, nav: number, reserveTokenDecimals: number): bigint {
  if (!(usdAmount > 0)) throw new Error("usdToReserveTokensRequested: usdAmount must be positive.");
  if (!(nav > 0)) throw new Error("usdToReserveTokensRequested: nav must be a real, positive, priced value.");
  return BigInt(Math.max(1, Math.floor((usdAmount / nav) * 10 ** reserveTokenDecimals)));
}

export type MultiAssetBuyProgressEvent =
  /** The whole purchase (swaps + deposit + mint) is going through as ONE wallet-signed atomic transaction (DEC-0156) -- the normal path. */
  | { phase: "single-transaction" }
  /** One-time setup (DEC-0171): this Reserve has no trading lookup table yet and the purchase can't fit one transaction without it -- creating and registering the table (its own wallet approval) before retrying the single-transaction purchase. */
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
// A MAP keyed `${wallet}:${reserve}` (DEC-0155) -- the previous single-slot
// shape meant starting a purchase of Reserve B silently discarded an
// in-flight purchase record for Reserve A, losing its double-mint baseline
// and acquired-asset accounting. Never shipped; no migration needed.
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

export interface ExecuteMultiAssetBuyParams {
  connection: Connection;
  wallet: WalletContextState;
  protocolConfig: PublicKey;
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  reserveTokensRequested: bigint;
  /** The Reserve's effective total mint-fee bps -- sizes the expected net output the double-mint guard verifies against. */
  effectiveMintFeeTotalBps: bigint;
  /** Real, current USD price per asset mint (see onChainReserve.ts's assetPricesUsd) -- used ONLY to size each Jupiter swap's USDC budget; the acquired amount is always re-verified against the real post-swap balance. */
  assetPricesUsd: Record<string, number>;
  /** Fractional slippage buffer for the final mint's per-leg cap -- see buildDirectMultiAssetMintInstructions. */
  slippageBps?: number;
  onProgress?: (event: MultiAssetBuyProgressEvent) => void;
  onSwapShortfall?: (info: { mint: string; targetRaw: bigint; actualRaw: bigint; shortfallPct: number }) => void;
}

/**
 * Full USDC-denominated buy. Sequential phases, each verified before the
 * next: reconcile previously-recorded signatures -> feasibility gate ->
 * per-leg funding (Jupiter swaps from USDC, one per genuinely-deficient
 * leg, freshly quoted immediately before each, actual output measured and
 * recorded) -> double-mint guard -> final in-kind mint -> post-mint
 * delivery verification (the buyer's real Reserve Token balance must show
 * the mint).
 */
export async function executeMultiAssetBuyMainnet(params: ExecuteMultiAssetBuyParams): Promise<MultiAssetBuyResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const owner = params.wallet.publicKey;
  const ownerBase58 = owner.toBase58();
  const reserveBase58 = params.reserve.toBase58();
  const program = buildReadOnlyProgram(params.connection) as any;

  log("buy start", {
    reserve: reserveBase58,
    depositAsset: "USDC (" + MAINNET_USDC_MINT + ")",
    reserveTokensRequested: params.reserveTokensRequested.toString(),
    legs: params.assets.map((a) => a.mint),
  });

  // Exact per-leg deposit requirements from live vault balances/supply --
  // the same integer math the on-chain program enforces.
  const balancesInVaults = params.assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const totalSupply = BigInt(params.reserveTokenSupplyRaw);
  const requirements = computeMintRequirements(params.reserveTokensRequested, totalSupply, balancesInVaults);
  const requiredAmountsRaw = requirements.map((r) => r.requiredAmount);
  const { netOut: expectedNetRaw } = computeNetMintOutput(params.reserveTokensRequested, params.effectiveMintFeeTotalBps);
  log("mint requirements (vault balances before)", {
    supply: totalSupply.toString(),
    perLeg: params.assets.map((a, i) => ({ mint: a.mint, vaultBefore: a.vaultBalanceRaw, requiredRaw: requiredAmountsRaw[i].toString() })),
    expectedNetReserveTokensRaw: expectedNetRaw.toString(),
  });

  // Fresh wallet balances for every leg + USDC + SOL -- the inputs to both
  // the funding plan and the feasibility gate.
  const readLegBalances = async () =>
    Promise.all(params.assets.map((a) => fetchTokenBalanceRaw(params.connection, new PublicKey(a.mint), owner).then(BigInt)));
  const heldRaw = await readLegBalances();
  const walletUsdcRaw = BigInt(await fetchTokenBalanceRaw(params.connection, new PublicKey(MAINNET_USDC_MINT), owner));
  const walletSolLamports = BigInt(await params.connection.getBalance(owner, "confirmed"));
  const rtBalanceNow = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));

  // Per-purchase persisted state: resume an interrupted purchase's baseline
  // and acquired-asset records (so both the double-mint guard and the
  // never-repeat-a-swap guarantee survive refresh), or start fresh.
  let pending = readPendingBuy(ownerBase58, reserveBase58);
  if (!pending) {
    pending = {
      wallet: ownerBase58,
      reserve: reserveBase58,
      startedAt: Date.now(),
      legFunding: {},
      preMintReserveTokenRaw: rtBalanceNow.toString(),
      expectedNetReserveTokensRaw: expectedNetRaw.toString(),
    };
    savePendingBuy(pending);
  } else {
    log("resuming a previously-started purchase", { startedAt: new Date(pending.startedAt).toISOString(), lastMintSignature: pending.lastMintSignature ?? null });
  }
  const advanceLeg = (mint: string, to: AssetFundingStatus, extra?: Partial<Pick<PersistedAssetFunding, "lastSignature" | "verifiedBalanceRaw" | "targetRaw" | "acquiredRaw">>) => {
    pending!.legFunding = advanceAssetFunding(pending!.legFunding, mint, to, extra);
    savePendingBuy(pending!);
  };
  const acquiredRawOf = (mint: string): bigint => BigInt(pending!.legFunding[mint]?.acquiredRaw ?? "0");

  // DOUBLE-MINT GUARD, part 1 (before doing anything else): if a previous
  // attempt's mint already landed -- however that attempt's confirmation
  // ended -- report success and stop. Verified from the buyer's REAL
  // Reserve Token balance, never client state.
  const preMintBaseline = BigInt(pending.preMintReserveTokenRaw);
  if (!shouldSubmitMint(preMintBaseline, rtBalanceNow, BigInt(pending.expectedNetReserveTokensRaw))) {
    log("mint already landed for this purchase (double-mint guard) -- not re-submitting", {
      preMintBaseline: preMintBaseline.toString(),
      rtBalanceNow: rtBalanceNow.toString(),
    });
    clearPendingBuy(ownerBase58, reserveBase58);
    return { signature: pending.lastMintSignature ?? "", reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
  }

  // Reconcile a previously-submitted mint signature whose confirmation was
  // never seen (refresh/RPC timeout) -- its real status decides.
  if (pending.lastMintSignature) {
    const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([pending!.lastMintSignature!], { searchTransactionHistory: true }), 3, 500);
    const st = value[0];
    log("reconciling previously-submitted mint signature", { signature: pending.lastMintSignature, status: st?.confirmationStatus ?? "not-found", err: st?.err ?? null });
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      await fetchOwnedBalanceRawSettled(params.connection, params.reserveTokenMint, owner, preMintBaseline);
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature: pending.lastMintSignature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
    }
  }

  // Reconcile EVERY previously-recorded swap signature BEFORE planning --
  // the plan's deficits depend on what those swaps actually delivered. A
  // confirmed swap's real output is measured from its own transaction's
  // token-balance delta (the authoritative record), a definitively
  // failed/expired one resets its leg cleanly, and an unverifiable one
  // stops here with nothing submitted -- never guessed either way.
  for (const asset of params.assets) {
    const persisted = pending.legFunding[asset.mint];
    if (!persisted?.lastSignature || !(persisted.status === "submitted" || persisted.status === "awaiting_signature")) continue;
    const signature = persisted.lastSignature;
    const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), 3, 500);
    const st = value[0];
    log("reconciling previous swap signature", { mint: asset.mint, signature, status: st?.confirmationStatus ?? "not-found", err: st?.err ?? null });
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      const parsedTx = await withRateLimitRetry(
        () => params.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
        3,
        750,
      );
      if (!parsedTx?.meta) {
        throw new MultiAssetBuyError(
          `A previous swap for this purchase confirmed on-chain but its delivered amount could not be verified yet (signature ${signature}). Nothing was submitted -- try again in a moment; the confirmed swap will be counted, not repeated.`,
          null,
        );
      }
      const delta = computeOwnerTokenDeltaRaw(
        (parsedTx.meta.preTokenBalances ?? []) as TokenBalanceEntry[],
        (parsedTx.meta.postTokenBalances ?? []) as TokenBalanceEntry[],
        ownerBase58,
        asset.mint,
      );
      const gained = delta > 0n ? delta : 0n;
      const newAcquired = acquiredRawOf(asset.mint) + gained;
      log("previous swap reconciled as confirmed -- output counted, never repeated", { mint: asset.mint, signature, deliveredRaw: gained.toString(), totalAcquiredRaw: newAcquired.toString() });
      advanceLeg(asset.mint, "confirmed", { acquiredRaw: newAcquired.toString() });
    } else if (st?.err) {
      log("previous swap definitively failed on-chain -- leg reset for a clean retry", { mint: asset.mint, signature, err: st.err });
      advanceLeg(asset.mint, "not_started");
    } else {
      // Not found: either expired unlanded or not yet visible. Statuses were
      // fetched with searchTransactionHistory, so treat as unlanded and
      // reset -- the swap never delivered anything to count.
      log("previous swap signature not found on-chain -- leg reset for a clean retry", { mint: asset.mint, signature });
      advanceLeg(asset.mint, "not_started");
    }
  }

  // The funding plan + whole-purchase feasibility gate -- BEFORE any
  // transaction is constructed or signature requested. Deficits are
  // purchase-scoped: only what THIS purchase's confirmed swaps acquired
  // counts toward a leg, never the wallet's unrelated holdings.
  const legInputs: BuyLegInput[] = params.assets.map((a, i) => ({
    mint: a.mint,
    decimals: a.decimals,
    requiredRaw: requiredAmountsRaw[i],
    walletHeldRaw: heldRaw[i],
    purchaseAcquiredRaw: acquiredRawOf(a.mint),
    priceUsd: params.assetPricesUsd[a.mint] ?? null,
  }));
  const plan = planBuyFunding(legInputs);
  log("funding plan", {
    walletUsdcRaw: walletUsdcRaw.toString(),
    walletSolLamports: walletSolLamports.toString(),
    actions: plan.actions.map((ac) =>
      ac.kind === "jupiter-swap"
        ? { swap: ac.mint, deficitRaw: ac.deficitRaw.toString(), usdcBudgetRaw: ac.usdcBudgetRaw.toString(), receiveWrappedSol: ac.receiveWrappedSol }
        : ac.kind === "wrap-recovered-sol"
          ? { wrapRecoveredSol: ac.mint, lamports: ac.lamports.toString() }
          : { alreadyFunded: ac.mint, countableRaw: ac.countableRaw.toString() },
    ),
  });
  const feasibility = assessBuyFeasibility({ plan, walletUsdcRaw, walletSolLamports });
  if (!feasibility.feasible) {
    throw new MultiAssetBuyError(`This purchase can't start yet: ${feasibility.reasons.join("; ")}. Nothing was submitted.`, null);
  }

  // Plain-language name of the stage currently executing -- reported
  // verbatim in the failure state so the user sees exactly where it
  // stopped and what remains.
  let currentStage = "preparing this purchase (before anything was submitted)";

  const buildFailureReport = async (): Promise<BuyStateReport> => {
    const freshHeld = await readLegBalances().catch(() => heldRaw);
    const freshRt = await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner).then(BigInt).catch(() => rtBalanceNow);
    return buildBuyStateReport(
      params.assets.map((a, i) => ({
        mint: a.mint,
        symbol: a.mint.slice(0, 4) + "..." + a.mint.slice(-4),
        requiredRaw: requiredAmountsRaw[i],
        walletHeldRaw: freshHeld[i],
        purchaseAcquiredRaw: acquiredRawOf(a.mint),
      })),
      preMintBaseline,
      freshRt,
      BigInt(pending!.expectedNetReserveTokensRaw),
      currentStage,
    );
  };

  try {
    // ---------------------------------------------------------------------
    // SINGLE-TRANSACTION PATH (DEC-0156, the normal path): every swap, any
    // recovered-SOL re-wrap, the ATA creations, and the mint -- ONE wallet
    // approval, fully atomic. Falls back to the sequential flow below only
    // when the composition genuinely cannot fit Solana's transaction-size
    // limit (many-asset Reserves).
    // ---------------------------------------------------------------------
    const swapActionList = plan.actions.filter((a) => a.kind === "jupiter-swap");
    const wrapActionList = plan.actions.filter((a) => a.kind === "wrap-recovered-sol");
    let singleTxUnsupported = false;
    try {
      currentStage = "preparing the single combined purchase transaction (nothing submitted yet)";
      params.onProgress?.({ phase: "single-transaction" });
      // PARALLEL fetch of every leg's swap instructions -- Promise.all
      // preserves order, so swapSets still lines up with the jupiter-swap
      // actions. Was a sequential await-in-loop (N round-trips back to back),
      // which is what made the whole prep slow enough to expire the earliest
      // Jupiter blockhash before submission. Account-budgeted quote first
      // (DEC-0161) so the composed transaction fits the wire limit; if no route
      // fits the budget, retry uncapped -- oversize then falls back sequentially.
      const swapSets: JupiterSwapInstructionsResult[] = await Promise.all(
        swapActionList
          .filter((action) => action.kind === "jupiter-swap")
          .map(async (action) => {
            const set = await fetchJupiterSwapInstructions(action.mint, action.usdcBudgetRaw, ownerBase58, undefined, undefined, SINGLE_TX_SWAP_MAX_ACCOUNTS).catch(
              () => fetchJupiterSwapInstructions(action.mint, action.usdcBudgetRaw, ownerBase58),
            );
            log("single-tx swap instructions fetched", { mint: action.mint, inUsdcRaw: set.inAmount.toString(), quotedOutRaw: set.outAmount.toString(), swapAccounts: set.swapInstruction.accounts.length, lookupTables: set.addressLookupTableAddresses.length });
            return set;
          }),
      );
      const wrapIxs = wrapActionList.flatMap((a) => (a.kind === "wrap-recovered-sol" ? buildWrapRecoveredSolInstructions(owner, a.lamports) : []));
      if (wrapActionList.length > 0) {
        log("single-tx re-wrap of recovered purchase SOL included", {
          lamports: wrapActionList.map((a) => (a.kind === "wrap-recovered-sol" ? a.lamports.toString() : "")),
        });
      }
      const { instructions: mintPrelude, requiredAmountsRaw: finalRequired } = await buildDirectMultiAssetMintInstructions({
        program,
        protocolConfig: params.protocolConfig,
        protocolFeeDestination: params.protocolFeeDestination,
        reserve: params.reserve,
        reserveTokenMint: params.reserveTokenMint,
        mintAuthority: params.mintAuthority,
        user: owner,
        assets: params.assets,
        reserveTokenSupplyRaw: params.reserveTokenSupplyRaw,
        reserveTokensRequested: params.reserveTokensRequested,
        slippageBps: params.slippageBps,
        // Real on-chain minimum-output protection (DEC-0171): the deployed
        // handler enforces net_shares_out >= this, and the net output is
        // deterministic from the requested amount and fee bps -- the
        // previous hardcoded 1 left the check effectively disabled.
        minReserveTokensOut: expectedNetRaw,
      });
      const mintIx = mintPrelude[mintPrelude.length - 1];
      const ixs = assembleSingleBuyInstructions({
        ataCreateInstructions: mintPrelude.slice(0, -1),
        swapSets,
        wrapInstructions: wrapIxs,
        mintInstruction: mintIx,
      });
      // The Reserve's registered trading lookup table (DEC-0161, when one
      // exists) compresses the protocol's fixed accounts -- often the
      // difference between one approval and the sequential fallback.
      const reserveAlt = await fetchReserveAltAddress(reserveBase58);
      const swapTableAddresses = swapSets.flatMap((s) => s.addressLookupTableAddresses);
      let lookupTables = await fetchLookupTables(params.connection, [...(reserveAlt ? [reserveAlt] : []), ...swapTableAddresses]);
      let { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash("confirmed");
      let tx: VersionedTransaction;
      try {
        tx = compileSingleBuyTransaction({ payer: owner, recentBlockhash: blockhash, instructions: ixs, lookupTables });
      } catch (compileError) {
        // AUTO-ENABLE (DEC-0171): the exact condition behind the live
        // 2026-08-27 four-approval ECHO purchase -- no trading table
        // registered, composition overruns the wire limit. If a table
        // would make this purchase fit (proven by compiling against its
        // exact would-be contents, no on-chain action), create + register
        // it now (one extra approval, once per Reserve, ~0.002 SOL rent,
        // benefits every future trader) and retry the single transaction.
        // If it can't help (many-leg Reserves), or its creation is
        // declined/fails, fall back sequentially exactly as before.
        if (!(compileError instanceof SingleTxTooLargeError) || reserveAlt) throw compileError;
        const altParams = {
          ssrProgramId: program.programId as PublicKey,
          reserve: params.reserve,
          reserveTokenMint: params.reserveTokenMint,
          mintAuthority: params.mintAuthority,
          vaultAuthority: findVaultAuthority(params.reserve, program.programId)[0],
          protocolFeeDestination: params.protocolFeeDestination,
          assets: params.assets.map((a) => ({ mint: a.mint, reserveAsset: a.reserveAsset, vault: a.vault })),
        };
        const swapTables = await fetchLookupTables(params.connection, swapTableAddresses);
        if (!wouldFitWithReserveAlt({ payer: owner, instructions: ixs, reserveAltAddresses: buildReserveAltAddresses(altParams), swapLookupTables: swapTables })) {
          throw compileError;
        }
        log("no trading table registered and the purchase can't fit without one -- enabling one-approval trading (one-time table), then retrying the single transaction");
        currentStage = "enabling one-approval trading for this Reserve (a one-time setup, its own wallet approval)";
        params.onProgress?.({ phase: "enabling-one-approval-trading" });
        let newAlt: string;
        try {
          newAlt = await createAndRegisterReserveAlt(params.connection, params.wallet, altParams);
        } catch (altError) {
          log("enabling one-approval trading did not complete -- falling back to the step-by-step flow", { error: altError instanceof Error ? altError.message : String(altError) });
          throw compileError;
        }
        lookupTables = await fetchLookupTables(params.connection, [newAlt, ...swapTableAddresses]);
        ({ blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash("confirmed"));
        tx = compileSingleBuyTransaction({ payer: owner, recentBlockhash: blockhash, instructions: ixs, lookupTables });
      }
      log("single-tx composed", { instructions: ixs.length, bytes: tx.serialize().length, lookupTables: lookupTables.length });

      // Read-only simulation BEFORE the wallet signature -- a doomed
      // transaction is refused here without costing an approval or a fee.
      // (replaceRecentBlockhash sidesteps the cross-node blockhash
      // false-negative that made per-submission preflight harmful -- see
      // createReserveClient.ts's signSubmitAndConfirm note. A failure of
      // the simulation CALL itself never blocks the purchase.)
      try {
        const sim = await params.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
        if (sim.value.err) {
          log("single-tx simulation failed -- refusing before any signature", { err: sim.value.err, logs: sim.value.logs ?? [] });
          throw new Error(
            `${describeOnChainError(new Error(`Transaction failed on-chain (${JSON.stringify(sim.value.err)}).`))} This was caught by a read-only simulation BEFORE anything was signed or submitted -- nothing moved and no fee was paid.`,
          );
        }
      } catch (simError) {
        if (simError instanceof Error && simError.message.includes("read-only simulation")) throw simError;
        log("single-tx simulation call itself failed -- proceeding (real confirmation remains the source of truth)", { error: String(simError) });
      }

      currentStage = "the single combined purchase transaction (swap, deposit, and mint in one atomic step)";
      params.onProgress?.({ phase: "awaiting-wallet" });
      if (!params.wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
      const signed = await params.wallet.signTransaction(tx);
      const { signature, outcome } = await sendAndConfirmWithRebroadcast(params.connection, signed.serialize(), lastValidBlockHeight, {
        onSubmitted: (sig) => {
          pending!.lastMintSignature = sig;
          savePendingBuy(pending!);
          log("single-tx submitted", { signature: sig });
          params.onProgress?.({ phase: "confirming", what: "your purchase transaction", signature: sig });
        },
      });
      if (outcome.status === "failed") {
        throw new Error(
          `${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} The purchase was ONE atomic transaction, so nothing was swapped, deposited, or minted -- only the network fee was spent. Signature: ${signature}.`,
        );
      }
      if (outcome.status === "expired") {
        throw new Error(`The purchase transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
      }
      if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");

      currentStage = "verifying your Reserve Tokens actually arrived after the mint";
      const rtAfter = await fetchOwnedBalanceRawSettled(params.connection, params.reserveTokenMint, owner, rtBalanceNow);
      log("single-tx post-mint verification", { buyerReserveTokenBefore: rtBalanceNow.toString(), buyerReserveTokenAfter: rtAfter.toString() });
      if (rtAfter <= rtBalanceNow) {
        throw new Error(
          `The purchase transaction confirmed but your Reserve Token balance has not increased yet (before ${rtBalanceNow.toString()}, now ${rtAfter.toString()} raw). Signature: ${signature}. Check the signature on Explorer before retrying.`,
        );
      }
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw: finalRequired, alreadyMinted: false };
    } catch (e) {
      if (!(e instanceof SingleTxTooLargeError)) throw e;
      singleTxUnsupported = true;
      log("single-tx too large for this Reserve -- falling back to the sequential flow", { message: e.message });
    }
    void singleTxUnsupported;

    // ---------------------------------------------------------------------
    // SEQUENTIAL FALLBACK: one transaction per step, fully guarded by the
    // persistent purchase state machine (used only when the single
    // transaction cannot fit).
    // ---------------------------------------------------------------------

    // Recovered-SOL re-wrap first (see multiAssetBuyPlan.ts's
    // wrap-recovered-sol): restores wrapped SOL this purchase already
    // bought with USDC -- never a new USDC spend.
    for (const action of wrapActionList) {
      if (action.kind !== "wrap-recovered-sol") continue;
      const legIndex = params.assets.findIndex((a) => a.mint === action.mint);
      currentStage = "re-wrapping the SOL this purchase already bought with your USDC";
      params.onProgress?.({ phase: "awaiting-wallet" });
      const wsolAta = getAssociatedTokenAddressSync(new PublicKey(action.mint), owner);
      const preWrapRaw = BigInt(await fetchTokenBalanceRaw(params.connection, new PublicKey(action.mint), owner));
      const wrapIxs = [
        createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, new PublicKey(action.mint)),
        ...buildWrapRecoveredSolInstructions(owner, action.lamports),
      ];
      await signSubmitAndConfirmWithPersistedSig(params.connection, params.wallet, wrapIxs);
      heldRaw[legIndex] = await fetchOwnedBalanceRawSettled(params.connection, new PublicKey(action.mint), owner, preWrapRaw);
      log("recovered SOL re-wrapped", { lamports: action.lamports.toString(), wsolBalanceNow: heldRaw[legIndex].toString() });
    }

    // --- Per-leg funding: USDC -> Jupiter -> Reserve asset, one swap per
    // --- genuinely-deficient leg.
    const swapActions = swapActionList;

    // Reconcile ONE confirmed swap: measure its real delivered output against
    // the pre-swap baseline and advance the leg state machine. Identical
    // whether the swap was signed one-at-a-time or as part of a signAll batch.
    const reconcileSwappedLeg = async (mint: string, legIndex: number, preSwapRaw: bigint): Promise<void> => {
      advanceLeg(mint, "confirmed");
      const newBalance = await fetchOwnedBalanceRawSettled(params.connection, new PublicKey(mint), owner, preSwapRaw);
      heldRaw[legIndex] = newBalance;
      const gained = newBalance > preSwapRaw ? newBalance - preSwapRaw : 0n;
      const newAcquired = acquiredRawOf(mint) + gained;
      advanceLeg(mint, "ready_to_seed", { verifiedBalanceRaw: newBalance.toString(), acquiredRaw: newAcquired.toString() });
      log("leg funded and output measured", {
        mint,
        deliveredRaw: gained.toString(),
        totalAcquiredRaw: newAcquired.toString(),
        requiredRaw: requiredAmountsRaw[legIndex].toString(),
      });
      const shortfallPct = computeSwapShortfallPct(requiredAmountsRaw[legIndex], newAcquired);
      if (shortfallPct > SHORTFALL_WARN_PCT) {
        params.onSwapShortfall?.({ mint, targetRaw: requiredAmountsRaw[legIndex], actualRaw: newAcquired, shortfallPct });
      }
    };

    // ONE-APPROVAL SWAP BATCH: when the wallet supports signAllTransactions and
    // there is more than one leg to fund, quote every leg, then sign ALL swap
    // transactions in a SINGLE wallet prompt (N approvals -> 1). Each swap is
    // still submitted, confirmed, and reconciled sequentially afterward, so the
    // downstream funding-verification, mint, and double-mint guards below are
    // completely unchanged -- only the prompt count drops. A leg that underfills
    // (or a wSOL ATA a sibling swap's cleanup closed -- the live 2026-08-26
    // failure) is caught by the same "verifying every Reserve asset was acquired
    // before the final mint" block below, which triggers the persistent state
    // machine's deficit-only resume. Falls back to per-swap signing when the
    // wallet lacks signAllTransactions or there is only a single leg.
    const canBatchSwaps = typeof params.wallet.signAllTransactions === "function" && swapActions.length > 1;
    if (canBatchSwaps) {
      currentStage = "preparing all of this Reserve's asset swaps for a single approval";
      // PARALLEL: fetch every leg's Jupiter quote + pre-swap baseline at once,
      // instead of a sequential await-in-loop (N round-trips back to back). That
      // serial prep is what made "preparing" feel frozen AND pushed the sign
      // prompt so late that the earliest quote's blockhash had already expired
      // by submission. Promise.all preserves order, so legs[] stays aligned with
      // signAllTransactions'/signedTxs' order. Legs are distinct mints, so no
      // swap in the batch changes another leg's measured baseline.
      type SwapLegAction = Extract<(typeof swapActions)[number], { kind: "jupiter-swap" }>;
      type QuotedLeg = { action: SwapLegAction; mint: string; legIndex: number; preSwapRaw: bigint; quote: JupiterSwapQuote; tx: VersionedTransaction };
      const quoteLeg = async (action: SwapLegAction): Promise<QuotedLeg> => {
        const legIndex = params.assets.findIndex((a) => a.mint === action.mint);
        advanceLeg(action.mint, "quoted", { targetRaw: requiredAmountsRaw[legIndex].toString() });
        const [quote, preSwapRawStr] = await Promise.all([
          fetchJupiterSwapQuote(action.mint, action.usdcBudgetRaw, ownerBase58, undefined, action.receiveWrappedSol),
          fetchTokenBalanceRaw(params.connection, new PublicKey(action.mint), owner),
        ]);
        log("swap quote", { mint: action.mint, inUsdcRaw: quote.inAmount.toString(), outRaw: quote.outAmount.toString(), receiveWrappedSol: action.receiveWrappedSol });
        const tx = VersionedTransaction.deserialize(Buffer.from(quote.swapTransaction, "base64"));
        advanceLeg(action.mint, "awaiting_signature");
        return { action, mint: action.mint, legIndex, preSwapRaw: BigInt(preSwapRawStr), quote, tx };
      };
      // PARALLEL submit + reconcile. All legs were signed in one approval, so
      // broadcast + confirm them concurrently rather than one-after-another --
      // a slow sequential submit was letting later legs' blockhashes expire
      // before they landed (the observed "Jupiter swap expired" failure).
      // Distinct mints => each reconcile baseline is independent. allSettled
      // (not all): every leg runs to its own conclusion so a sibling's
      // failure never leaves an in-flight leg unreconciled.
      const submitLegs = (batch: QuotedLeg[], signedTxs: VersionedTransaction[]) =>
        Promise.allSettled(
          batch.map(async (leg, s) => {
            params.onProgress?.({ phase: "swapping", mint: leg.mint, index: s, total: batch.length });
            // Stagger broadcasts slightly: N simultaneous sends tripped the
            // rpc-proxy's per-client rate limit (429 storm, live 2026-09-08);
            // web3.js retried them through, but this avoids the storm.
            if (s > 0) await new Promise((r) => setTimeout(r, 150 * s));
            await submitSignedJupiterSwap(params.connection, signedTxs[s], leg.quote.lastValidBlockHeight, (sig) => advanceLeg(leg.mint, "submitted", { lastSignature: sig }));
            await reconcileSwappedLeg(leg.mint, leg.legIndex, leg.preSwapRaw);
          }),
        );

      let batch: QuotedLeg[] = await Promise.all(swapActions.filter((action): action is SwapLegAction => action.kind === "jupiter-swap").map(quoteLeg));
      params.onProgress?.({ phase: "awaiting-wallet" });
      let signedTxs = await params.wallet.signAllTransactions!(batch.map((l) => l.tx));
      currentStage = "submitting all of the Reserve's asset swaps";
      let outcomes = await submitLegs(batch, signedTxs);

      // AUTOMATIC RETRY (once): a leg whose swap DEFINITIVELY did not land
      // (executed-and-failed, or expired unincluded -- JupiterSwapNotLandedError,
      // "nothing moved" either way) is re-quoted with a fresh route + blockhash
      // and re-signed in ONE more approval, instead of failing the whole
      // purchase and making the user press Buy again to get exactly that. An
      // ambiguous confirmation is never retried here -- it stops the purchase so
      // the resume flow can reconcile the real signature status first.
      for (let attempt = 0; attempt < SWAP_AUTO_RETRY_LIMIT; attempt++) {
        const { retryable, fatal } = partitionSwapOutcomes(batch, outcomes);
        if (fatal !== null) throw fatal;
        if (retryable.length === 0) break;
        log("swap leg(s) did not land -- automatically re-quoting and re-signing once", {
          attempt: attempt + 1,
          mints: retryable.map((l) => l.mint),
          reasons: outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected").map((o) => String((o.reason as Error)?.message ?? o.reason)),
        });
        currentStage = "re-quoting the Reserve asset swap(s) that did not land, for one more approval";
        for (const leg of retryable) advanceLeg(leg.mint, "not_started"); // explicit retry reset (launchFunding.ts)
        batch = await Promise.all(retryable.map((leg) => quoteLeg(leg.action)));
        params.onProgress?.({ phase: "awaiting-wallet" });
        signedTxs = await params.wallet.signAllTransactions!(batch.map((l) => l.tx));
        currentStage = "submitting the re-quoted Reserve asset swap(s)";
        outcomes = await submitLegs(batch, signedTxs);
      }
      {
        const { retryable, fatal } = partitionSwapOutcomes(batch, outcomes);
        if (fatal !== null) throw fatal;
        if (retryable.length > 0) {
          const first = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected")!.reason as Error;
          throw new Error(`${first.message} (This swap was already automatically retried once with a fresh quote and did not land either.)`);
        }
      }
    } else {
      for (let s = 0; s < swapActions.length; s++) {
        const action = swapActions[s];
        if (action.kind !== "jupiter-swap") continue;
        const legIndex = params.assets.findIndex((a) => a.mint === action.mint);
        currentStage = `swapping your USDC for one of the Reserve's assets (${action.mint.slice(0, 4)}...${action.mint.slice(-4)})`;

        params.onProgress?.({ phase: "swapping", mint: action.mint, index: s, total: swapActions.length });
        // Same automatic retry-once as the batched path: a swap that
        // definitively did not land is re-quoted and re-signed one more time
        // before the failure is surfaced (JupiterSwapNotLandedError only --
        // an ambiguous confirmation always stops the purchase).
        for (let attempt = 0; ; attempt++) {
          advanceLeg(action.mint, "quoted", { targetRaw: requiredAmountsRaw[legIndex].toString() });
          const quote = await fetchJupiterSwapQuote(action.mint, action.usdcBudgetRaw, ownerBase58, undefined, action.receiveWrappedSol);
          log("swap quote", { mint: action.mint, inUsdcRaw: quote.inAmount.toString(), outRaw: quote.outAmount.toString(), receiveWrappedSol: action.receiveWrappedSol, attempt });
          // The leg balance immediately before this swap -- the baseline the
          // swap's actual delivered output is measured against.
          const preSwapRaw = BigInt(await fetchTokenBalanceRaw(params.connection, new PublicKey(action.mint), owner));
          advanceLeg(action.mint, "awaiting_signature");
          try {
            await executeJupiterSwap(params.connection, params.wallet, quote, (sig) => advanceLeg(action.mint, "submitted", { lastSignature: sig }));
          } catch (e) {
            if (e instanceof JupiterSwapNotLandedError && attempt < SWAP_AUTO_RETRY_LIMIT) {
              log("swap did not land -- automatically re-quoting and re-signing once", { mint: action.mint, kind: e.kind, signature: e.signature });
              advanceLeg(action.mint, "not_started"); // explicit retry reset (launchFunding.ts)
              continue;
            }
            if (e instanceof JupiterSwapNotLandedError) throw new Error(`${e.message} (This swap was already automatically retried once with a fresh quote and did not land either.)`);
            throw e;
          }
          await reconcileSwappedLeg(action.mint, legIndex, preSwapRaw);
          break;
        }
      }
    }

    // Every leg must now be genuinely covered by THIS purchase's own
    // acquisitions (still present in the wallet) -- the mint is never
    // submitted against unverified funding or against unrelated holdings.
    // Balances are RE-READ here, after every funding transaction: the live
    // 2026-08-26 failure proved a later transaction can destroy an earlier
    // leg's funding (a swap's cleanup closed the wSOL ATA), and the stale
    // per-leg reads taken at each leg's own funding time missed it.
    currentStage = "verifying every Reserve asset was acquired before the final mint";
    {
      const freshHeld = await readLegBalances();
      for (let i = 0; i < params.assets.length; i++) heldRaw[i] = freshHeld[i];
    }
    for (let i = 0; i < params.assets.length; i++) {
      const mint = params.assets[i].mint;
      const countable = mint === MAINNET_USDC_MINT ? heldRaw[i] : countableAcquiredRaw({ walletHeldRaw: heldRaw[i], purchaseAcquiredRaw: acquiredRawOf(mint) });
      if (countable < requiredAmountsRaw[i]) {
        throw new Error(
          `Reserve asset ${mint} is still short after funding: this purchase has acquired ${countable.toString()} raw of the ${requiredAmountsRaw[i].toString()} raw required. Nothing further was submitted -- retrying funds only this remaining shortfall.`,
        );
      }
    }

    // DOUBLE-MINT GUARD, part 2 (immediately before submitting): re-read
    // the buyer's real Reserve Token balance one more time.
    const rtBeforeMint = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));
    if (!shouldSubmitMint(preMintBaseline, rtBeforeMint, BigInt(pending.expectedNetReserveTokensRaw))) {
      log("mint landed between funding and submission (double-mint guard) -- not re-submitting");
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature: pending.lastMintSignature ?? "", reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
    }

    currentStage = "the final mint that deposits the acquired assets and delivers your Reserve Tokens";
    params.onProgress?.({ phase: "minting" });
    const { instructions, requiredAmountsRaw: finalRequired } = await buildDirectMultiAssetMintInstructions({
      program,
      protocolConfig: params.protocolConfig,
      protocolFeeDestination: params.protocolFeeDestination,
      reserve: params.reserve,
      reserveTokenMint: params.reserveTokenMint,
      mintAuthority: params.mintAuthority,
      user: owner,
      assets: params.assets,
      reserveTokenSupplyRaw: params.reserveTokenSupplyRaw,
      reserveTokensRequested: params.reserveTokensRequested,
      slippageBps: params.slippageBps,
      minReserveTokensOut: expectedNetRaw, // same real minimum as the single-transaction path (DEC-0171)
    });
    log("mint instruction built", {
      fixedAndRemainingKeys: instructions[instructions.length - 1].keys.length,
      perLegCapRaw: finalRequired.map((r) => r.toString()),
    });

    // The mint goes out as a VERSIONED (v0) transaction compressed by the
    // Reserve's trading lookup table. A legacy transaction lists every account
    // key in full (32 bytes each), so a many-asset Reserve's mint -- 63 keys for
    // a 10-asset Reserve, seen live 2026-09-08 -- can NEVER fit the 1232-byte
    // wire limit that way ("Transaction too large: 2004 > 1232", after every
    // swap had already landed). With the table, the protocol's fixed accounts
    // and each asset's mint/reserve-asset/vault become 1-byte indexes. If the
    // Reserve has no table yet and one would make the mint fit, it is created
    // now (DEC-0171's auto-enable, one extra approval, once per Reserve).
    const mintIx = instructions[instructions.length - 1];
    const ataIxs = instructions.slice(0, -1);
    const persistMintSig = (sig: string) => { pending!.lastMintSignature = sig; savePendingBuy(pending!); };
    let reserveAlt = await fetchReserveAltAddress(reserveBase58);
    let lookupTables = reserveAlt ? await fetchLookupTables(params.connection, [reserveAlt]) : [];
    // Priority fee on the mint (same per-CU price as the single-transaction
    // path; a bounded unit limit so the fee stays small) -- an unprioritized
    // mint was being dropped under load and simply expired.
    const mintBudgetIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_TX_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
    ];
    const compileMint = (ixs: TransactionInstruction[], blockhash: string) =>
      compileSingleBuyTransaction({ payer: owner, recentBlockhash: blockhash, instructions: [...mintBudgetIxs, ...ixs], lookupTables });
    // Prefer ONE transaction (ATA creations + mint); split the ATA creations
    // into their own leading legacy transaction(s) only when they don't fit.
    let mintIxs = instructions;
    let signature = "";
    const fits = (ixs: TransactionInstruction[]) => { try { compileMint(ixs, "11111111111111111111111111111111"); return true; } catch { return false; } };
    if (!fits(mintIxs)) {
      if (ataIxs.length > 0 && fits([mintIx])) {
        mintIxs = [mintIx];
      } else if (!reserveAlt) {
        const altParams = {
          ssrProgramId: program.programId as PublicKey,
          reserve: params.reserve,
          reserveTokenMint: params.reserveTokenMint,
          mintAuthority: params.mintAuthority,
          vaultAuthority: findVaultAuthority(params.reserve, program.programId)[0],
          protocolFeeDestination: params.protocolFeeDestination,
          assets: params.assets.map((a) => ({ mint: a.mint, reserveAsset: a.reserveAsset, vault: a.vault })),
        };
        const altAddresses = buildReserveAltAddresses(altParams);
        const mintOnlyFits = wouldFitWithReserveAlt({ payer: owner, instructions: [mintIx], reserveAltAddresses: altAddresses, swapLookupTables: [] });
        if (!mintOnlyFits) {
          throw new Error(
            `This Reserve's mint references ${mintIx.keys.length} accounts and cannot fit one transaction even with a trading lookup table -- nothing further was submitted; the assets already acquired stay in your wallet and are counted on retry.`,
          );
        }
        log("no trading table registered and the mint can't fit without one -- enabling one-approval trading (one-time table), then submitting the mint");
        currentStage = "enabling one-approval trading for this Reserve (a one-time setup, its own wallet approval)";
        params.onProgress?.({ phase: "enabling-one-approval-trading" });
        reserveAlt = await createAndRegisterReserveAlt(params.connection, params.wallet, altParams);
        lookupTables = await fetchLookupTables(params.connection, [reserveAlt]);
        mintIxs = fits(instructions) ? instructions : [mintIx];
      } else {
        throw new Error(`This Reserve's mint (${mintIx.keys.length} accounts) does not fit one transaction even with its trading lookup table -- nothing further was submitted; retry counts the assets already acquired.`);
      }
    }
    if (mintIxs.length < instructions.length) {
      // ATA creations first, legacy, real-size batched (createReserveClient's packer).
      for (const batch of packInstructionsBySize(owner, ataIxs)) {
        params.onProgress?.({ phase: "awaiting-wallet" });
        await signSubmitAndConfirmWithPersistedSig(params.connection, params.wallet, batch);
      }
    }
    currentStage = "the final mint that deposits the acquired assets and delivers your Reserve Tokens";
    params.onProgress?.({ phase: "awaiting-wallet" });
    {
      const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash("confirmed");
      const tx = compileMint(mintIxs, blockhash);
      log("mint transaction composed (v0)", { instructions: mintIxs.length, bytes: tx.serialize().length, lookupTables: lookupTables.length });
      if (!params.wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
      const signed = await params.wallet.signTransaction(tx);
      const sent = await sendAndConfirmWithRebroadcast(params.connection, signed.serialize(), lastValidBlockHeight, {
        onSubmitted: (sig) => {
          persistMintSig(sig);
          log("transaction submitted", { signature: sig });
          params.onProgress?.({ phase: "confirming", what: "the mint that delivers your Reserve Tokens", signature: sig });
        },
      });
      signature = sent.signature;
      const outcome = sent.outcome;
      if (outcome.status === "failed") throw new Error(`${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} Signature: ${signature}.`);
      if (outcome.status === "expired") throw new Error(`The mint expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
      if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
    }

    // DELIVERY VERIFICATION: success is only ever reported after the
    // buyer's REAL Reserve Token balance shows the minted output.
    currentStage = "verifying your Reserve Tokens actually arrived after the mint";
    const rtAfter = await fetchOwnedBalanceRawSettled(params.connection, params.reserveTokenMint, owner, rtBeforeMint);
    const supplyAfter = await program.provider.connection
      .getTokenSupply(params.reserveTokenMint)
      .then((r: { value: { amount: string } }) => r.value.amount)
      .catch(() => "unavailable");
    log("post-mint verification", {
      buyerReserveTokenBefore: rtBeforeMint.toString(),
      buyerReserveTokenAfter: rtAfter.toString(),
      reserveTokenSupplyAfter: supplyAfter,
    });
    if (rtAfter <= rtBeforeMint) {
      throw new Error(
        `The mint transaction confirmed but your Reserve Token balance has not increased yet (before ${rtBeforeMint.toString()}, now ${rtAfter.toString()} raw). Signature: ${signature}. Check the signature on Explorer before retrying.`,
      );
    }
    clearPendingBuy(ownerBase58, reserveBase58);
    return { signature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw: finalRequired, alreadyMinted: false };
  } catch (e) {
    if (e instanceof AmbiguousConfirmationError) throw e; // DTRDetail's reconcileBuy path owns this case.
    const report = await buildFailureReport().catch(() => null);
    log("buy failed -- verified state report", { error: e instanceof Error ? e.message : String(e), stage: currentStage, report });
    throw new MultiAssetBuyError(e instanceof Error ? e.message : String(e), report, e);
  }
}

/** signSubmitAndConfirm variant that reports the signature the moment it exists (before confirmation) so the mint signature is persisted for reconciliation across refreshes. */
async function signSubmitAndConfirmWithPersistedSig(
  connection: Connection,
  wallet: WalletContextState,
  ixs: TransactionInstruction[],
  onSubmitted?: (signature: string) => void,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const { signature, outcome } = await sendAndConfirmWithRebroadcast(connection, signed.serialize(), lastValidBlockHeight, {
    onSubmitted: (sig) => {
      onSubmitted?.(sig);
      log("transaction submitted", { signature: sig });
    },
  });
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(`${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} Signature: ${signature}.`);
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature, "Mainnet");
}
