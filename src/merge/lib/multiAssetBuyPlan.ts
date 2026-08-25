// Pure, offline-testable decision logic for the Mainnet USDC-denominated
// Reserve Token buy (DEC-0154) -- the planning brain multiAssetBuyClient.ts
// executes. Split out for direct unit coverage, exactly like
// createReserveResume.ts / launchFunding.ts (same rationale: every decision
// here is a pure function of already-fetched inputs).
//
// FUNDING INVARIANT (DEC-0151, extended to purchases by DEC-0154): a buyer
// supplies ONLY USDC (plus SOL for network fees/rent). EVERY Reserve asset
// leg the wallet doesn't already sufficiently hold -- including a wrapped-SOL
// leg -- is acquired by a real Jupiter swap FROM USDC. An earlier version
// funded a wrapped-SOL leg by silently wrapping the buyer's own native SOL
// (observed live 2026-08-25: a "$10 USDC" CHARLI buy debited ~$5 of native
// SOL in its first transaction while the UI named USDC as the deposit
// asset). Already-held balances (including wrapped SOL left over from a
// previous attempt) always count toward the requirement first -- only the
// genuine remaining deficit is ever swapped for, so a retry never
// repurchases what an earlier attempt already acquired.
import { WRAPPED_SOL_MINT, MAINNET_USDC_MINT } from "@ssr/sdk";

export interface BuyLegInput {
  mint: string;
  decimals: number;
  /** Exact raw amount the mint instruction will deposit for this leg (computeMintRequirements). */
  requiredRaw: bigint;
  /** The wallet's real, freshly-read raw balance of this mint. */
  heldRaw: bigint;
  /** Real current USD price for this mint -- used only to SIZE the Jupiter swap budget; the actual acquired amount is always re-verified against the real post-swap balance. */
  priceUsd: number | null;
}

export type BuyFundingAction =
  /** Swap `usdcBudgetRaw` of the buyer's USDC into `mint` via Jupiter. For a wrapped-SOL leg the swap must be built with `receiveWrappedSol` so the output arrives as SPL wrapped SOL (never auto-unwrapped to native). */
  | { kind: "jupiter-swap"; mint: string; deficitRaw: bigint; usdcBudgetRaw: bigint; receiveWrappedSol: boolean }
  /** The wallet already holds enough of this leg -- nothing to do, and a retry MUST take this branch for every leg a prior attempt already funded. */
  | { kind: "already-held"; mint: string; heldRaw: bigint; requiredRaw: bigint };

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
 * order, never skipping a leg, never funding a leg twice. Throws (never
 * guesses) if a leg that genuinely needs a swap has no real USD price to
 * size the budget from.
 */
export function planBuyFunding(legs: BuyLegInput[]): BuyFundingPlan {
  const actions: BuyFundingAction[] = [];
  let totalSwapUsdcRaw = 0n;
  let usdcLegRequiredRaw = 0n;

  for (const leg of legs) {
    const deficitRaw = leg.requiredRaw > leg.heldRaw ? leg.requiredRaw - leg.heldRaw : 0n;
    if (leg.mint === MAINNET_USDC_MINT) {
      // The buyer's own input currency -- a deficit here can only be fixed
      // by the buyer holding more USDC (checked by assessBuyFeasibility);
      // there is nothing to swap it FROM.
      usdcLegRequiredRaw += leg.requiredRaw;
      actions.push({ kind: "already-held", mint: leg.mint, heldRaw: leg.heldRaw, requiredRaw: leg.requiredRaw });
      continue;
    }
    if (deficitRaw === 0n) {
      actions.push({ kind: "already-held", mint: leg.mint, heldRaw: leg.heldRaw, requiredRaw: leg.requiredRaw });
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

/** One leg's entry in the honest post-failure state report -- everything the UI needs to show what is held, where, and what retry will do. */
export interface BuyLegStateLine {
  mint: string;
  requiredRaw: string;
  heldRaw: string;
  fundedEnough: boolean;
}

export interface BuyStateReport {
  legs: BuyLegStateLine[];
  reserveTokenMinted: boolean;
  buyerReserveTokenBalanceRaw: string;
  /** What clicking Buy again will actually do, derived from the verified state above. */
  retrySummary: string;
}

/** Builds the verified-on-chain state report shown after a failure -- callers must pass FRESHLY READ balances, never cached/optimistic state. */
export function buildBuyStateReport(
  legs: { mint: string; symbol: string; requiredRaw: bigint; heldRaw: bigint }[],
  preMintRtRaw: bigint,
  currentRtRaw: bigint,
  expectedNetRaw: bigint,
): BuyStateReport {
  const legLines: BuyLegStateLine[] = legs.map((l) => ({
    mint: l.mint,
    requiredRaw: l.requiredRaw.toString(),
    heldRaw: l.heldRaw.toString(),
    fundedEnough: l.heldRaw >= l.requiredRaw,
  }));
  const reserveTokenMinted = !shouldSubmitMint(preMintRtRaw, currentRtRaw, expectedNetRaw);
  const unfunded = legs.filter((l) => l.heldRaw < l.requiredRaw);
  const retrySummary = reserveTokenMinted
    ? "Your Reserve Tokens were already minted -- retrying will not mint again."
    : unfunded.length === 0
      ? "Every Reserve asset for this purchase is already in your wallet -- retrying only re-submits the final mint, acquiring nothing again."
      : `Retrying will swap USDC for only the remaining shortfall of: ${unfunded.map((l) => l.symbol).join(", ")} -- every already-held amount is counted first and never repurchased.`;
  return {
    legs: legLines,
    reserveTokenMinted,
    buyerReserveTokenBalanceRaw: currentRtRaw.toString(),
    retrySummary,
  };
}
