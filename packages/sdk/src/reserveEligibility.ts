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

/**
 * Statuses eligible to appear on the public product at all. Named for what
 * it now actually gates -- "visible/functional," not "supports every
 * action" -- since `windDown` was added here (2026-08-11): a wound-down
 * Reserve was previously excluded entirely (quarantined exactly like a
 * broken legacy Reserve), which was the confirmed root cause of a live
 * report that a Reserve "just disappears" after wind-down. Checked directly
 * against the deployed program: `Reserve::require_redemption_allowed`
 * (programs/ssr_protocol/src/state/reserve.rs) already explicitly permits
 * redemption during `WindDown` BY DESIGN -- `close_reserve` requires supply
 * to reach zero, which requires holders to still be able to redeem out
 * while winding down -- while `mint_reserve_tokens_in_kind` requires
 * exactly `Active`, so minting/Buy is already blocked on-chain during
 * WindDown regardless of anything checked here. Callers (DTRDetail.tsx)
 * are responsible for showing a distinct "Wind Down" state and disabling
 * Buy in the UI -- this function only decides "visible at all," never
 * "which actions are offered."
 */
const LIFECYCLE_STATUSES_PERMITTING_NORMAL_USE = new Set(["active", "paused", "windDown"]);

/**
 * Exported alias of the same set, named for its OTHER real use site:
 * api/devnet/swap-sign.ts's Sell-vs-Buy status gate (2026-08-13 corrective
 * pass, DEC-0093). Before this pass that endpoint used one Active-only check
 * for every action, which incorrectly rejected a WindDown Sell even though
 * `Reserve::require_redemption_allowed` (programs/ssr_protocol/src/state/reserve.rs)
 * already permitted it on-chain. Deliberately the SAME set as
 * LIFECYCLE_STATUSES_PERMITTING_NORMAL_USE above -- "may this Reserve be
 * shown/traded at all" and "is redemption specifically allowed" happen to
 * coincide exactly for every current lifecycle status, since Buy is the only
 * action gated more narrowly (Active only, checked separately by callers).
 */
export function isRedemptionAllowedForStatus(status: string): boolean {
  return LIFECYCLE_STATUSES_PERMITTING_NORMAL_USE.has(status);
}

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
