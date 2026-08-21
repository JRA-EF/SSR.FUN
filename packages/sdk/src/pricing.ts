// Pure, network-free USD-pricing validation/hierarchy logic for the Mainnet
// pricing layer (see api/mainnet/asset-prices.ts, which owns the actual
// Pyth Hermes / Jupiter Price V3 network calls and imports these functions
// to decide what to do with what it fetched). Kept separate and free of any
// fetch/RPC call so the decision logic itself -- staleness, confidence,
// decimals cross-check, block recency, hierarchy, deviation -- is directly
// unit-testable (see tests/phase_mainnet_pricing.ts) without a live network
// call or a mocked HTTP layer.
//
// Hierarchy: fresh, validated Pyth wins when a verified feed exists for a
// mint; otherwise Jupiter Price V3 is the fallback. Neither is ever
// fabricated -- a value that fails validation is treated as unavailable,
// never coerced to 0 or to the other source's number.

export type PriceSource = "pyth" | "jupiter";

/** Verified mint -> Pyth Core feed ID map. Never keyed by symbol/ticker --
 * only a canonical mint address ever maps to a feed ID, and only for a mint
 * this app has independently confirmed the feed genuinely prices (see
 * docs/project/DECISION_LOG.md's Mainnet-pricing-layer entry for how
 * PYTH_USDC_USD_FEED_ID/PYTH_SOL_USD_FEED_ID were verified against Pyth's
 * live https://hermes.pyth.network/v2/price_feeds search before being added
 * here). Extend this map only after the same live verification -- a wrong
 * feed ID silently prices the wrong asset. */
export const PYTH_USDC_USD_FEED_ID = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const MAINNET_PYTH_FEED_IDS: Readonly<Record<string, string>> = {
  // Real Circle USDC.
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: PYTH_USDC_USD_FEED_ID,
  // Wrapped SOL.
  So11111111111111111111111111111111111111112: PYTH_SOL_USD_FEED_ID,
};

/** Reject a Pyth quote older than this many seconds (publish_time vs. now). */
export const PYTH_MAX_STALENESS_SEC = 60;
/** Reject a Pyth quote whose confidence interval exceeds this fraction of the price itself. */
export const PYTH_MAX_CONFIDENCE_RATIO = 0.02;
/** When both Pyth and Jupiter produce a valid price for the same mint, flag (never block) a relative disagreement past this fraction. */
export const PRICE_DEVIATION_FLAG_RATIO = 0.01;
/** Reject a Jupiter Price V3 quote whose blockId is this many slots (or more) behind the current Mainnet slot (~400ms/slot, so 15,000 slots is ~100 minutes) -- deliberately generous: this exists to catch an obviously stale/broken response, not to impose a tight freshness bound Jupiter's own API doesn't document. */
export const MAX_BLOCK_LAG_SLOTS = 15_000;

export interface RawPythPrice {
  /** Feed ID this quote was returned for -- caller cross-checks it matches the requested feed. */
  id: string;
  /** Integer string, scaled by 10**expo. */
  price: string;
  /** Integer string, the price's confidence interval, same scale as price. */
  conf: string;
  expo: number;
  /** Unix seconds. */
  publishTimeSec: number;
}

export interface ValidatedPrice {
  usdPrice: number;
  source: PriceSource;
  /** Unix ms. */
  lastUpdated: number;
  confidenceRatio?: number;
}

/** Returns null (never a fabricated/clamped number) for anything that fails identity, staleness, or confidence validation. */
export function validatePythPrice(raw: RawPythPrice, expectedFeedId: string, nowSec: number = Date.now() / 1000): ValidatedPrice | null {
  if (raw.id.toLowerCase() !== expectedFeedId.toLowerCase()) return null;
  const priceInt = Number(raw.price);
  const confInt = Number(raw.conf);
  if (!Number.isFinite(priceInt) || priceInt <= 0) return null;
  if (!Number.isFinite(confInt) || confInt < 0) return null;
  if (!Number.isFinite(raw.expo)) return null;
  if (!Number.isFinite(raw.publishTimeSec) || raw.publishTimeSec <= 0) return null;
  const age = nowSec - raw.publishTimeSec;
  // A quote from "the future" (positive clock skew beyond a small tolerance) is just as untrustworthy as a stale one.
  if (age > PYTH_MAX_STALENESS_SEC || age < -5) return null;
  const confidenceRatio = confInt / priceInt;
  if (confidenceRatio > PYTH_MAX_CONFIDENCE_RATIO) return null;
  const usdPrice = priceInt * 10 ** raw.expo;
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) return null;
  return { usdPrice, source: "pyth", lastUpdated: Math.floor(raw.publishTimeSec * 1000), confidenceRatio };
}

export interface RawJupiterPrice {
  usdPrice: number | null | undefined;
  decimals: number | null | undefined;
  blockId: number | null | undefined;
}

/** Returns null for a missing/null price, a decimals mismatch against the on-chain-verified value, or a blockId that's absent or too far behind the current slot -- never a fabricated 0. */
export function validateJupiterPrice(raw: RawJupiterPrice, expectedDecimals: number, currentSlot: number, maxBlockLagSlots: number = MAX_BLOCK_LAG_SLOTS): ValidatedPrice | null {
  if (raw.usdPrice === null || raw.usdPrice === undefined) return null;
  if (!Number.isFinite(raw.usdPrice) || raw.usdPrice <= 0) return null;
  if (raw.decimals === null || raw.decimals === undefined || raw.decimals !== expectedDecimals) return null;
  if (raw.blockId === null || raw.blockId === undefined || !Number.isFinite(raw.blockId) || raw.blockId <= 0) return null;
  if (currentSlot > 0 && currentSlot - raw.blockId > maxBlockLagSlots) return null;
  // Jupiter's Price V3 response carries no wall-clock quote timestamp (only
  // blockId, a slot number) -- lastUpdated here is this validation's own
  // clock time (effectively "as of this fetch"), not the quote's true age.
  // Displayed honestly as such by the caller (see AssetPriceInfo's source
  // label), never presented as more precise than it is.
  return { usdPrice: raw.usdPrice, source: "jupiter", lastUpdated: Date.now() };
}

export interface PriceHierarchyResult {
  usdPrice: number;
  source: PriceSource;
  lastUpdated: number;
  deviationFlagged: boolean;
  deviationPct?: number;
}

/** Pyth wins whenever a valid Pyth quote exists; Jupiter is the fallback only when Pyth is unavailable/invalid. When both are valid, flags (never blocks or averages) a material relative disagreement so a caller can log/surface it. Returns null only when neither source produced a valid quote. */
export function resolvePriceHierarchy(pyth: ValidatedPrice | null, jupiter: ValidatedPrice | null): PriceHierarchyResult | null {
  if (pyth && jupiter) {
    const diff = Math.abs(pyth.usdPrice - jupiter.usdPrice);
    const base = Math.max(pyth.usdPrice, jupiter.usdPrice);
    const deviationPct = base > 0 ? diff / base : 0;
    return { usdPrice: pyth.usdPrice, source: "pyth", lastUpdated: pyth.lastUpdated, deviationFlagged: deviationPct > PRICE_DEVIATION_FLAG_RATIO, deviationPct };
  }
  if (pyth) return { usdPrice: pyth.usdPrice, source: "pyth", lastUpdated: pyth.lastUpdated, deviationFlagged: false };
  if (jupiter) return { usdPrice: jupiter.usdPrice, source: "jupiter", lastUpdated: jupiter.lastUpdated, deviationFlagged: false };
  return null;
}
