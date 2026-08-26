// Pure, offline-testable decision logic for the Mainnet USDC-denominated
// Reserve Token buy (DEC-0154, tightened by DEC-0155) -- the planning brain
// multiAssetBuyClient.ts executes. Split out for direct unit coverage,
// exactly like createReserveResume.ts / launchFunding.ts (same rationale:
// every decision here is a pure function of already-fetched inputs).
//
// FUNDING INVARIANT (DEC-0151, extended to purchases by DEC-0154/DEC-0155):
// a buyer supplies ONLY USDC (plus SOL for network fees/rent). EVERY Reserve
// asset leg is acquired by a real Jupiter swap FROM USDC -- including a
// wrapped-SOL leg. An earlier version funded a wrapped-SOL leg by silently
// wrapping the buyer's own native SOL (observed live 2026-08-25: a "$10
// USDC" CHARLI buy debited ~$5 of native SOL in its first transaction while
// the UI named USDC as the deposit asset).
//
// WHAT COUNTS TOWARD A LEG (DEC-0155): only assets THIS purchase's own
// confirmed swaps acquired -- reconciled from the recorded swap signatures'
// real on-chain token deltas, then capped at what the wallet still actually
// holds. A retry therefore resumes only the genuine remaining deficit and
// never repeats a successful swap. Assets the wallet happened to hold
// already (unrelated SSR, previously-wrapped SOL, anything else) are NEVER
// silently consumed in place of the quoted USDC: the live failed CHARLI buy
// proved why -- the buyer's wallet held 154k pre-existing SSR and 0.0515
// wSOL wrapped from native SOL, and whole-wallet counting would have
// delivered the "$10 USDC" purchase while charging almost no USDC at all.
import { WRAPPED_SOL_MINT, MAINNET_USDC_MINT } from "@ssr/sdk";

export interface BuyLegInput {
  mint: string;
  decimals: number;
  /** Exact raw amount the mint instruction will deposit for this leg (computeMintRequirements). */
  requiredRaw: bigint;
  /** The wallet's real, freshly-read raw balance of this mint -- caps what purchaseAcquiredRaw can still count (assets may have been moved out since acquisition). */
  walletHeldRaw: bigint;
  /** Raw amount THIS purchase's own confirmed swaps acquired of this mint, reconciled from the recorded signatures' real on-chain token deltas. 0 for a fresh purchase. Pre-existing unrelated holdings are never part of this number. */
  purchaseAcquiredRaw: bigint;
  /** Real current USD price for this mint -- used only to SIZE the Jupiter swap budget; the actual acquired amount is always re-verified against the real post-swap balance. */
  priceUsd: number | null;
}

/** What a leg can still count toward its requirement: only what this purchase acquired AND the wallet still holds. USDC legs are handled separately (the input currency itself). */
export function countableAcquiredRaw(leg: Pick<BuyLegInput, "walletHeldRaw" | "purchaseAcquiredRaw">): bigint {
  return leg.purchaseAcquiredRaw < leg.walletHeldRaw ? leg.purchaseAcquiredRaw : leg.walletHeldRaw;
}

export type BuyFundingAction =
  /** Swap `usdcBudgetRaw` of the buyer's USDC into `mint` via Jupiter. For a wrapped-SOL leg the swap must be built with `receiveWrappedSol` so the output arrives as SPL wrapped SOL (never auto-unwrapped to native). */
  | { kind: "jupiter-swap"; mint: string; deficitRaw: bigint; usdcBudgetRaw: bigint; receiveWrappedSol: boolean }
  /** This purchase already acquired enough of this leg (or the leg is the USDC input currency itself) -- nothing to do, and a retry MUST take this branch for every leg a prior attempt's confirmed swap already funded. */
  | { kind: "already-funded"; mint: string; countableRaw: bigint; requiredRaw: bigint };

export interface BuyFundingPlan {
  actions: BuyFundingAction[];
  /** Total USDC (raw) the plan will spend across every swap, before the buffer. */
  totalSwapUsdcRaw: bigint;
  /** USDC (raw) consumed directly by a USDC leg's own deposit, if the Reserve holds USDC. */
  usdcLegRequiredRaw: bigint;
}

/** Fractional headroom applied when sizing each swap's USDC budget -- covers swap fees and quote-to-execution price movement. */
export const BUY_SWAP_BUFFER_FRACTION = 0.02;

/**
 * Builds the exact funding actions for a buy: one entry per leg, in leg
 * order, never skipping a leg, never funding a leg twice. The deficit for a
 * leg is its requirement minus what THIS purchase already verifiably
 * acquired (countableAcquiredRaw) -- never minus the wallet's whole balance.
 * Throws (never guesses) if a leg that genuinely needs a swap has no real
 * USD price to size the budget from.
 */
export function planBuyFunding(legs: BuyLegInput[]): BuyFundingPlan {
  const actions: BuyFundingAction[] = [];
  let totalSwapUsdcRaw = 0n;
  let usdcLegRequiredRaw = 0n;

  for (const leg of legs) {
    if (leg.mint === MAINNET_USDC_MINT) {
      // The buyer's own input currency -- deposited directly from the
      // wallet's USDC (that USDC IS the quoted investment; a deficit here
      // can only be fixed by holding more USDC, checked by
      // assessBuyFeasibility). There is nothing to swap it FROM.
      usdcLegRequiredRaw += leg.requiredRaw;
      actions.push({ kind: "already-funded", mint: leg.mint, countableRaw: leg.walletHeldRaw, requiredRaw: leg.requiredRaw });
      continue;
    }
    const countable = countableAcquiredRaw(leg);
    const deficitRaw = leg.requiredRaw > countable ? leg.requiredRaw - countable : 0n;
    if (deficitRaw === 0n) {
      actions.push({ kind: "already-funded", mint: leg.mint, countableRaw: countable, requiredRaw: leg.requiredRaw });
      continue;
    }
    if (leg.priceUsd === null || !Number.isFinite(leg.priceUsd) || leg.priceUsd <= 0) {
      throw new Error(`No real current USD price is available for ${leg.mint} -- refusing to guess a swap budget for it. Try again once pricing is available.`);
    }
    const deficitUsd = (Number(deficitRaw) / 10 ** leg.decimals) * leg.priceUsd;
    const usdcBudgetRaw = BigInt(Math.ceil(deficitUsd * (1 + BUY_SWAP_BUFFER_FRACTION) * 1_000_000));
    totalSwapUsdcRaw += usdcBudgetRaw;
    actions.push({
      kind: "jupiter-swap",
      mint: leg.mint,
      deficitRaw,
      usdcBudgetRaw,
      // A wrapped-SOL leg is STILL funded from USDC (the invariant) -- the
      // swap just has to be built so its output stays as SPL wrapped SOL
      // instead of Jupiter's default auto-unwrap to native.
      receiveWrappedSol: leg.mint === WRAPPED_SOL_MINT.toBase58(),
    });
  }
  return { actions, totalSwapUsdcRaw, usdcLegRequiredRaw };
}

// --- Swap-output reconciliation ---------------------------------------------

/** Minimal shape of a transaction meta's token-balance entries (getParsedTransaction). */
export interface TokenBalanceEntry {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

/**
 * Pure: the owner's raw balance change of `mint` in one transaction,
 * computed from the transaction's own pre/post token balances -- the
 * authoritative record of what a reconciled swap actually delivered
 * (missing entries mean a zero balance / freshly-created ATA). Never
 * negative-capped: callers decide how to treat a negative delta.
 */
export function computeOwnerTokenDeltaRaw(
  preTokenBalances: TokenBalanceEntry[],
  postTokenBalances: TokenBalanceEntry[],
  owner: string,
  mint: string,
): bigint {
  const sum = (entries: TokenBalanceEntry[]) =>
    entries.filter((e) => e.owner === owner && e.mint === mint).reduce((acc, e) => acc + BigInt(e.uiTokenAmount.amount), 0n);
  return sum(postTokenBalances) - sum(preTokenBalances);
}

// --- Feasibility ------------------------------------------------------------

export interface BuyFeasibilityParams {
  plan: BuyFundingPlan;
  /** The wallet's real, current raw USDC balance. */
  walletUsdcRaw: bigint;
  /** The wallet's real, current native SOL balance in lamports. */
  walletSolLamports: bigint;
  /** Estimated lamports needed for network fees + any rent this buy may pay (ATAs, priority fees) -- a small fixed floor, NOT purchase capital. */
  estimatedFeeLamports?: bigint;
}

export interface BuyFeasibility {
  feasible: boolean;
  requiredUsdcRaw: bigint;
  missingUsdcRaw: bigint;
  missingSolLamports: bigint;
  reasons: string[];
}

/** Conservative fee/rent floor for a multi-transaction buy: a few signatures with priority fees plus up to a couple of fresh ATAs. */
export const DEFAULT_BUY_FEE_LAMPORTS = 8_000_000n; // 0.008 SOL

/**
 * The whole-purchase feasibility gate, run BEFORE any transaction is
 * constructed or any signature requested: the wallet must hold the full
 * USDC the plan will spend (swaps + any USDC leg) and enough SOL for
 * fees/rent -- Jupiter's own documented handling for its InsufficientFunds
 * rejection (show current vs required balances), applied preemptively.
 * Fee/rent SOL is assessed separately from purchase capital and is never
 * spent INTO the purchase.
 */
export function assessBuyFeasibility(params: BuyFeasibilityParams): BuyFeasibility {
  const fee = params.estimatedFeeLamports ?? DEFAULT_BUY_FEE_LAMPORTS;
  const requiredUsdcRaw = params.plan.totalSwapUsdcRaw + params.plan.usdcLegRequiredRaw;
  const missingUsdcRaw = requiredUsdcRaw > params.walletUsdcRaw ? requiredUsdcRaw - params.walletUsdcRaw : 0n;
  const missingSolLamports = fee > params.walletSolLamports ? fee - params.walletSolLamports : 0n;
  const reasons: string[] = [];
  if (missingUsdcRaw > 0n) {
    reasons.push(
      `this wallet holds ${(Number(params.walletUsdcRaw) / 1e6).toFixed(2)} USDC but this purchase needs ~${(Number(requiredUsdcRaw) / 1e6).toFixed(2)} USDC -- ${(Number(missingUsdcRaw) / 1e6).toFixed(2)} USDC short`,
    );
  }
  if (missingSolLamports > 0n) {
    reasons.push(
      `this wallet holds ${(Number(params.walletSolLamports) / 1e9).toFixed(4)} SOL but needs ~${(Number(fee) / 1e9).toFixed(4)} SOL for network fees and account rent`,
    );
  }
  return { feasible: reasons.length === 0, requiredUsdcRaw, missingUsdcRaw, missingSolLamports, reasons };
}

/**
 * THE double-mint guard: decides whether the final mint may be submitted,
 * from the buyer's REAL, freshly-read Reserve Token balance -- never from
 * client-side state alone. If the balance already grew by at least the
 * expected net output since this purchase began, a previous attempt's mint
 * genuinely landed (however the client's own confirmation ended) and
 * submitting again would double-charge the buyer's Reserve assets and
 * double-mint Reserve Tokens.
 */
export function shouldSubmitMint(preMintBalanceRaw: bigint, currentBalanceRaw: bigint, expectedNetRaw: bigint): boolean {
  if (expectedNetRaw <= 0n) return false; // nothing to mint -- never submit a zero mint
  const grown = currentBalanceRaw - preMintBalanceRaw;
  // A previous mint landed if the balance grew by (approximately) the
  // expected output -- allow 1% tolerance below for any rounding between
  // the estimate and the on-chain fee math, never above-tolerance guesses.
  const threshold = expectedNetRaw - expectedNetRaw / 100n;
  return grown < threshold;
}

// --- Post-failure state report ----------------------------------------------

/** One leg's entry in the honest post-failure state report -- everything the UI needs to show what this purchase acquired, what the wallet holds, and what retry will do. */
export interface BuyLegStateLine {
  mint: string;
  requiredRaw: string;
  /** What this purchase's own confirmed swaps acquired (reconciled). */
  purchaseAcquiredRaw: string;
  /** The wallet's whole current balance of this mint -- shown for transparency; unrelated holdings are never consumed by a retry. */
  walletHeldRaw: string;
  fundedEnough: boolean;
}

export interface BuyStateReport {
  legs: BuyLegStateLine[];
  reserveTokenMinted: boolean;
  buyerReserveTokenBalanceRaw: string;
  /** Plain-language name of the exact stage that failed (e.g. "swapping your USDC for one of the Reserve's assets", "the final mint that delivers your Reserve Tokens"). */
  failedStage: string;
  /** What clicking Buy again will actually do, derived from the verified state above. */
  retrySummary: string;
}

/** Builds the verified-on-chain state report shown after a failure -- callers must pass FRESHLY READ balances and reconciled purchase-acquired amounts, never cached/optimistic state. */
export function buildBuyStateReport(
  legs: { mint: string; symbol: string; requiredRaw: bigint; walletHeldRaw: bigint; purchaseAcquiredRaw: bigint }[],
  preMintRtRaw: bigint,
  currentRtRaw: bigint,
  expectedNetRaw: bigint,
  failedStage: string,
): BuyStateReport {
  const legLines: BuyLegStateLine[] = legs.map((l) => ({
    mint: l.mint,
    requiredRaw: l.requiredRaw.toString(),
    purchaseAcquiredRaw: l.purchaseAcquiredRaw.toString(),
    walletHeldRaw: l.walletHeldRaw.toString(),
    fundedEnough: countableAcquiredRaw(l) >= l.requiredRaw,
  }));
  const reserveTokenMinted = !shouldSubmitMint(preMintRtRaw, currentRtRaw, expectedNetRaw);
  const unfunded = legs.filter((l) => countableAcquiredRaw(l) < l.requiredRaw);
  const retrySummary = reserveTokenMinted
    ? "Your Reserve Tokens were already minted -- retrying will not mint again."
    : unfunded.length === 0
      ? "This purchase already acquired every Reserve asset it needs -- retrying only re-submits the final mint, buying nothing again."
      : `Retrying will swap USDC for only the genuine remaining shortfall of: ${unfunded.map((l) => l.symbol).join(", ")} -- whatever this purchase already acquired is counted first and never repurchased, and other assets already in your wallet are never used in place of your USDC.`;
  return {
    legs: legLines,
    reserveTokenMinted,
    buyerReserveTokenBalanceRaw: currentRtRaw.toString(),
    failedStage,
    retrySummary,
  };
}
