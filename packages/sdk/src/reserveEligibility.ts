// The single, canonical "is this Reserve eligible to appear anywhere on the
// public product" gate -- Discover, Featured Reserves, search, Portfolio
// enrichment, Manage listings, and public Reserve counts (landing-stats.ts)
// all call this SAME function rather than each re-deriving their own version
// of "is this one real/tradable/complete." See
// docs/project/DECISION_LOG.md's entry for this pass for the root cause this
// closes: reserveId 0-8 on the live DevNet deployment registered real assets
// whose mints simply aren't (and can never be, since they're one-off
// pre-fixture-registry test tokens) in discovery.ts's candidate-mint hint
// list, so `resolvedAssetCount` reads 0 against a real `assetCount` of 1-2
// forever -- the exact "N registered, only 0 resolved" bug. The prior
// filter (mergeDiscoveredReserves) never excluded an under-resolved Reserve
// at all, only a fully-resolved-but-unsupported one, so these fell straight
// into the public catalogue with a broken Buy path.
//
// Callers each adapt their own native shape (packages/sdk's DiscoveredReserve
// for API routes reading discovery output directly, src/merge/lib/types.ts's
// OnChainReserveMeta for the frontend's already-DTR-ified state) into this
// small canonical ReserveEligibilityInput -- the DECISION logic itself lives
// only here, once.
import { isHiddenReserveAddress } from "./hiddenReserves";
import { isReserveTradable } from "./tradableAssets";

export interface ReserveEligibilityInput {
  /** The Reserve's own on-chain address (base58) -- checked against HIDDEN_RESERVE_ADDRESSES. */
  reserve: string;
  /**
   * Reserve.assetCount, the verified real on-chain count of registered
   * assets -- `undefined` only for a legacy local DTR shape that predates
   * this field existing at all (never for a genuinely fresh discovery
   * result); such a shape is passed through as eligible for THIS specific
   * check rather than guessed at, matching this module's fail-closed-on-
   * real-data / never-fabricate-on-absent-data policy.
   */
  assetCount: number | undefined;
  /** How many of assetCount this discovery pass actually resolved to a real, decoded ReserveAsset. */
  resolvedAssetCount: number;
  /** Mint addresses of every asset this pass DID resolve. */
  assetMints: string[];
  /** Mirrors ReserveStatus: "created" | "assetsInitializing" | "active" | "paused" | "windDown" | "closed". */
  status: string;
  /** Reserve Token supply, raw base units, as a decimal string. */
  reserveTokenSupplyRaw: string;
}

export interface ReserveEligibilityResult {
  eligible: boolean;
  /** Null when eligible; a short, non-technical reason otherwise -- never exposed as a raw error/diagnostic string in the public UI. */
  reason: string | null;
}

const LIFECYCLE_STATUSES_PERMITTING_NORMAL_USE = new Set(["active", "paused"]);

/**
 * Fail-closed: any check this function can't affirmatively confirm results
 * in `eligible: false`, never a default-true. This is deliberately stricter
 * than the old per-page filters it replaces -- see the pass's Decision Log
 * entry for the full list of reserveIds this newly excludes and why each is
 * genuinely unsupported (not just under-verified).
 */
export function evaluateReserveEligibility(input: ReserveEligibilityInput): ReserveEligibilityResult {
  if (isHiddenReserveAddress(input.reserve)) {
    return { eligible: false, reason: "This Reserve is explicitly excluded from the public catalogue." };
  }

  // A legacy local DTR shape predating the assetCount field entirely --
  // pass through the asset-count-shaped checks below rather than guessing.
  if (input.assetCount === undefined) {
    return { eligible: true, reason: null };
  }

  if (input.assetCount === 0) {
    return { eligible: false, reason: "This Reserve has no registered reserve assets." };
  }

  if (input.resolvedAssetCount !== input.assetCount) {
    return {
      eligible: false,
      reason: `This Reserve reports ${input.assetCount} registered asset(s), but only ${input.resolvedAssetCount} resolve against the current DevNet asset registry.`,
    };
  }

  if (!isReserveTradable(input.assetMints)) {
    return { eligible: false, reason: "This Reserve holds an asset outside SSR.fun's currently supported DevNet test assets." };
  }

  if (!LIFECYCLE_STATUSES_PERMITTING_NORMAL_USE.has(input.status)) {
    return { eligible: false, reason: `This Reserve's lifecycle status ("${input.status}") does not permit normal public trading.` };
  }

  if (input.reserveTokenSupplyRaw === "0") {
    return { eligible: false, reason: "This Reserve was never seeded -- no Reserve Tokens exist, so AUM/NAV cannot be computed." };
  }

  return { eligible: true, reason: null };
}
