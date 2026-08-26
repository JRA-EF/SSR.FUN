// Per-asset launch-funding state machine + upfront feasibility assessment
// for Mainnet Reserve inception (DEC-0151). Pure and offline-testable on
// purpose, exactly like createReserveResume.ts (same split rationale: every
// decision here is a pure function of already-fetched inputs, covered by
// direct unit tests instead of only being exercisable via a live run).
//
// PRODUCT INVARIANT (documented in docs/protocol/FRONTEND_INTEGRATION.md's
// "Mainnet funding invariant" section and DEC-0151): a user supplies ONLY
// Mainnet USDC (plus SOL for network fees/rent). Reserve inception is
// USDC -> Jupiter swaps -> all required Reserve Assets -> seed -> mint
// Reserve Tokens; buying an existing Reserve is USDC -> Jupiter swaps ->
// deposit -> mint. The user must never need to acquire constituent assets
// manually. A resume may COUNT constituent assets already in the wallet
// from previously confirmed swaps toward the requirement, but must only
// obtain genuine remaining deficits and must never repeat successful work.
//
// Root-cause background (2026-08-25, Reserve 11
// EQ5HNT9hAnYFfXARRJeKrNahMLaag5tepXV1uoK6CqoM, manager wallet
// 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen): a 10-asset ~$20 launch
// failed deterministically at its 4th swap (USDC -> USD1) five consecutive
// times over 34 minutes with Jupiter program error 6024 -- which Jupiter's
// own documentation defines as **InsufficientFunds** ("Insufficient funds
// for either swap amount, transaction fees or rent fees"), NOT slippage.
// The wallet held 0.490579 USDC against a ~$2 required swap input: earlier
// abandoned launch attempts had already converted the wallet's USDC into
// OTHER constituent tokens, and nothing anywhere checked "does this wallet
// actually hold enough USDC for the remaining plan" -- not before creating
// the Reserve PDA, and not before each swap. This module is that check.

// --- Per-asset funding state machine ----------------------------------------

/**
 * The full lifecycle of funding ONE constituent asset. Strictly ordered --
 * see FUNDING_STATUS_ORDER. A Reserve may enter seeding ONLY when every
 * asset is `ready_to_seed` (see canEnterSeeding); completion is never
 * inferred from a wallet approval, a submitted transaction, optimistic UI
 * state, or a timeout -- only from an authoritatively verified balance.
 */
export type AssetFundingStatus =
  | "not_started"
  | "quoted"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "balance_verified"
  | "ready_to_seed";

export const FUNDING_STATUS_ORDER: Record<AssetFundingStatus, number> = {
  not_started: 0,
  quoted: 1,
  awaiting_signature: 2,
  submitted: 3,
  confirmed: 4,
  balance_verified: 5,
  ready_to_seed: 6,
};

/** Persisted per-asset funding progress -- stored inside PendingReserveDeploy so it survives refresh/reconnect and lets a resume reconcile a previously-submitted signature instead of blindly re-swapping. All raw amounts are strings (JSON-safe bigints). */
export interface PersistedAssetFunding {
  mint: string;
  status: AssetFundingStatus;
  /** The last swap signature submitted for this asset, if any -- reconciled against real signature status on resume BEFORE any new swap is attempted. */
  lastSignature?: string;
  /** The real, settled post-funding balance once verified. */
  verifiedBalanceRaw?: string;
  /** The live-quoted target amount this asset was being funded toward. */
  targetRaw?: string;
  /** Cumulative raw amount THIS flow's own confirmed swaps acquired of this asset, reconciled from the recorded signatures' real on-chain token deltas (DEC-0155) -- the buy path's purchase-scoped accounting; unset for flows that don't track it. */
  acquiredRaw?: string;
}

/**
 * True only when a transition moves strictly forward through the lifecycle,
 * OR is an explicit retry reset (anything -> not_started, used after a swap
 * definitively failed on-chain so the next attempt starts cleanly). A
 * backward transition to any OTHER state is never legal -- prevents e.g. a
 * stale async callback demoting an already-verified asset.
 */
export function isLegalFundingTransition(from: AssetFundingStatus, to: AssetFundingStatus): boolean {
  if (to === "not_started") return true; // explicit retry reset
  return FUNDING_STATUS_ORDER[to] > FUNDING_STATUS_ORDER[from];
}

/** Immutable update helper: returns a new record with `mint` advanced to `to` (merging `extra`), refusing an illegal transition by returning the record unchanged -- a stale/duplicated event can never corrupt progress. */
export function advanceAssetFunding(
  record: Record<string, PersistedAssetFunding>,
  mint: string,
  to: AssetFundingStatus,
  extra?: Partial<Pick<PersistedAssetFunding, "lastSignature" | "verifiedBalanceRaw" | "targetRaw" | "acquiredRaw">>,
): Record<string, PersistedAssetFunding> {
  const current = record[mint] ?? { mint, status: "not_started" as AssetFundingStatus };
  if (current.status !== to && !isLegalFundingTransition(current.status, to)) return record;
  const next: PersistedAssetFunding = { ...current, ...extra, mint, status: to };
  if (to === "not_started") {
    // A retry reset clears the stale signature -- the old signature was
    // already reconciled as definitively failed/expired before resetting.
    delete next.lastSignature;
  }
  return { ...record, [mint]: next };
}

/** THE seeding gate: every asset must be authoritatively `ready_to_seed`. An empty list is never seedable (a Reserve with zero funded assets has nothing to deposit). */
export function canEnterSeeding(states: PersistedAssetFunding[]): boolean {
  return states.length > 0 && states.every((s) => s.status === "ready_to_seed");
}

/** How many assets are fully funded -- drives the "4 of 10 assets funded" progress display. */
export function countReadyToSeed(states: PersistedAssetFunding[]): number {
  return states.filter((s) => s.status === "ready_to_seed").length;
}

/** Index of the first asset not yet fully funded (resume always continues from here, in registration order) -- -1 when everything is ready. */
export function firstUnresolvedIndex(states: PersistedAssetFunding[]): number {
  return states.findIndex((s) => s.status !== "ready_to_seed");
}

// --- Launch feasibility preflight -------------------------------------------

/** How each asset is funded -- determines what the wallet must hold for it. */
export type AssetFundingKind = "usdc" | "wrapped-sol" | "swap";

export interface LaunchAssetPlan {
  mint: string;
  /** Fraction of seedTotalUsd allocated to this asset (0.1 = 10%). */
  seedWeightFraction: number;
  kind: AssetFundingKind;
  /** USD value of this asset ALREADY held by the wallet and countable toward its target (confirmed balances from earlier attempts) -- 0 for a fresh launch. */
  alreadyHeldUsd?: number;
}

export interface PerAssetFeasibility {
  mint: string;
  kind: AssetFundingKind;
  allocatedUsd: number;
  /** USDC still genuinely needed for this asset (0 for a wrapped-SOL leg, which consumes SOL instead). */
  remainingUsdcUsd: number;
  ok: boolean;
  reason: string | null;
}

export interface LaunchFeasibilityParams {
  assets: LaunchAssetPlan[];
  seedTotalUsd: number;
  /** The wallet's real, current raw USDC balance (6 decimals). */
  walletUsdcRaw: bigint;
  /**
   * Smallest per-asset allocation considered practical to swap for --
   * below this, a swap is uneconomic (network/priority fees rival the
   * amount) and can be outright unquotable (confirmed live: Jupiter
   * rejects computing a slippage threshold for a 1-raw-unit input,
   * "Cannot compute other amount threshold, with amount 1 and slippageBps
   * 150"). Applied to the DESIGNED allocation, never to a small remaining
   * deficit on resume (the dust-skip already handles that case).
   */
  minPracticalSwapUsd?: number;
  /** Fractional buffer on the total USDC requirement for fees/slippage/price movement between quote and execution. */
  feeBufferFraction?: number;
}

export interface LaunchFeasibility {
  feasible: boolean;
  perAsset: PerAssetFeasibility[];
  /** Total USDC (UI units) the wallet must hold RIGHT NOW to complete this launch, including the fee/slippage buffer. */
  requiredUsdcUi: number;
  /** How much MORE USDC the wallet needs beyond what it holds -- 0 when feasible on the USDC axis. */
  missingUsdcUi: number;
  /** Smallest seedTotalUsd at which every swap-funded allocation clears minPracticalSwapUsd -- the precise number to recommend instead of an arbitrary blanket minimum. */
  minimumRecommendedSeedUsd: number;
  /** Human-readable summary of every failed check -- empty when feasible. */
  reasons: string[];
}

export const DEFAULT_MIN_PRACTICAL_SWAP_USD = 0.5;
export const DEFAULT_FEE_BUFFER_FRACTION = 0.03;

/**
 * Complete upfront feasibility check, run BEFORE creating the Reserve PDA
 * (and re-run with alreadyHeldUsd populated before resuming funding). Pure:
 * the caller supplies real, freshly-read balances. Never guesses -- every
 * verdict names its evidence in `reasons`.
 */
export function assessLaunchFeasibility(params: LaunchFeasibilityParams): LaunchFeasibility {
  const minPractical = params.minPracticalSwapUsd ?? DEFAULT_MIN_PRACTICAL_SWAP_USD;
  const buffer = params.feeBufferFraction ?? DEFAULT_FEE_BUFFER_FRACTION;
  const reasons: string[] = [];
  const perAsset: PerAssetFeasibility[] = [];

  let requiredUsdc = 0;
  let minFractionNeedingUsdc = Infinity;

  for (const a of params.assets) {
    const allocatedUsd = params.seedTotalUsd * a.seedWeightFraction;
    const alreadyHeld = Math.max(0, a.alreadyHeldUsd ?? 0);
    const remaining = Math.max(0, allocatedUsd - alreadyHeld);
    // A wrapped-SOL leg consumes the wallet's SOL, not its USDC -- its
    // feasibility on the SOL axis is the caller's existing
    // seedRawAmountForAsset/cost-estimate path; only USDC feasibility is
    // assessed here.
    const remainingUsdcUsd = a.kind === "wrapped-sol" ? 0 : remaining;
    let ok = true;
    let reason: string | null = null;

    if (a.kind === "swap" && remaining > 0 && allocatedUsd < minPractical) {
      // The DESIGNED allocation is dust -- uneconomic/unquotable per-swap.
      // (A small REMAINING deficit against a mostly-funded asset is fine --
      // the funding loop's dust-skip handles that; this only rejects a plan
      // whose intended allocation is itself impractical.)
      ok = false;
      reason = `allocation $${allocatedUsd.toFixed(2)} is below the practical per-swap minimum of $${minPractical.toFixed(2)}`;
      reasons.push(`${a.mint}: ${reason}`);
    }

    if (a.kind !== "wrapped-sol" && a.seedWeightFraction > 0) {
      minFractionNeedingUsdc = Math.min(minFractionNeedingUsdc, a.seedWeightFraction);
    }
    requiredUsdc += remainingUsdcUsd;
    perAsset.push({ mint: a.mint, kind: a.kind, allocatedUsd, remainingUsdcUsd, ok, reason });
  }

  const requiredUsdcUi = requiredUsdc * (1 + buffer);
  const heldUsdcUi = Number(params.walletUsdcRaw) / 1e6;
  const missingUsdcUi = Math.max(0, requiredUsdcUi - heldUsdcUi);
  if (missingUsdcUi > 0) {
    reasons.push(
      `wallet holds ${heldUsdcUi.toFixed(2)} USDC but this launch needs ~${requiredUsdcUi.toFixed(2)} USDC (including a ${(buffer * 100).toFixed(0)}% fee/slippage buffer) -- ${missingUsdcUi.toFixed(2)} USDC short`,
    );
  }

  // The precise recommended minimum: the smallest total seed at which the
  // smallest USDC-consuming allocation clears the practical per-swap floor.
  const minimumRecommendedSeedUsd =
    minFractionNeedingUsdc === Infinity ? 0 : Math.ceil((minPractical / minFractionNeedingUsdc) * 100) / 100;

  return {
    feasible: reasons.length === 0,
    perAsset,
    requiredUsdcUi: Math.ceil(requiredUsdcUi * 100) / 100,
    missingUsdcUi: Math.ceil(missingUsdcUi * 100) / 100,
    minimumRecommendedSeedUsd,
    reasons,
  };
}
