// Pure math for the Reserve NAV History store -- no I/O, fully unit-tested
// in tests/phase_nav_history.ts. Shared by the recorder
// (api/mainnet/warm-cache-cron.ts via recorder.ts) and the read endpoint
// (api/mainnet/reserve-nav-history.ts).

/** Reserve Token decimals -- mirrors src/merge/lib/onChainReserve.ts's RESERVE_TOKEN_DECIMALS (lib/ must not import src/ UI code). */
export const RESERVE_TOKEN_DECIMALS = 6;

export interface NavPoint {
  /** Unix milliseconds. */
  t: number;
  /** USD value of one Reserve Token. */
  nav: number;
}

export interface NavInputAsset {
  assetMint: string;
  vaultBalanceRaw: string;
  decimals: number;
}

export interface NavInputReserve {
  reserve: string;
  assets: NavInputAsset[];
  reserveTokenSupplyRaw: string;
  assetCount: number;
  resolvedAssetCount: number;
}

/**
 * NAV per Reserve Token = (sum of vault balance x USD price) / supply --
 * the exact Token Price the app displays (no secondary market exists, so
 * Token Price IS NAV). null (never a guess) when supply is zero, the
 * Reserve's asset set is under-resolved, or any asset with a real balance
 * has no valid price -- a partial NAV would be a fabricated number.
 */
export function computeNavUsd(reserve: NavInputReserve, priceByMint: Record<string, number>): number | null {
  const supply = Number(reserve.reserveTokenSupplyRaw) / 10 ** RESERVE_TOKEN_DECIMALS;
  if (!(supply > 0)) return null;
  if (reserve.resolvedAssetCount !== reserve.assetCount) return null;
  let aumUsd = 0;
  for (const a of reserve.assets) {
    const balance = Number(a.vaultBalanceRaw) / 10 ** a.decimals;
    if (!(balance > 0)) continue;
    const price = priceByMint[a.assetMint];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
    aumUsd += balance * price;
  }
  const nav = aumUsd / supply;
  return Number.isFinite(nav) && nav > 0 ? nav : null;
}

/**
 * The Reserve's "launch value": its CURRENT holdings valued at each asset's
 * ENTRY price (the Reserve Asset Entry Price Store -- the same baseline the
 * Composition table's per-asset P&L uses) divided by the current supply.
 * Mint/redeem are pro-rata, so per-token holdings are constant across
 * trades and this equals the NAV at the moment the entry prices were
 * captured, up to fee-share dilution and manager rebalances. It is the
 * anchor point of the all-time series and what "All-Time Performance"
 * measures from -- so the Reserve-level figure is always the value-weighted
 * aggregate of the per-asset P&L rows beneath it. Same null rules as
 * computeNavUsd (every held asset needs an entry price).
 */
export function computeEntryNavUsd(reserve: NavInputReserve, entryPriceByMint: Record<string, number>): number | null {
  return computeNavUsd(reserve, entryPriceByMint);
}

/** A quiet Reserve still records a point this often, so the chart never has multi-hour gaps. */
export const NAV_RECORD_MIN_INTERVAL_MS = 15 * 60_000;
/** A move this large (relative) is recorded as soon as NAV_RECORD_MIN_SPACING_MS has elapsed. */
export const NAV_RECORD_MOVE_FRACTION = 0.005; // 0.5%
/** Floor between two recorded points, whatever the move -- bounds a volatile basket to ~1440 rows/day. */
export const NAV_RECORD_MIN_SPACING_MS = 60_000;

/** Whether a fresh NAV observation is worth a row, given the last recorded one. */
export function shouldRecordNavPoint(last: NavPoint | null, nav: number, now: number): boolean {
  if (!(nav > 0) || !Number.isFinite(nav)) return false;
  if (!last) return true;
  const elapsed = now - last.t;
  if (elapsed < NAV_RECORD_MIN_SPACING_MS) return false;
  if (elapsed >= NAV_RECORD_MIN_INTERVAL_MS) return true;
  return last.nav > 0 && Math.abs(nav - last.nav) / last.nav >= NAV_RECORD_MOVE_FRACTION;
}

/** Bucket width (whole seconds, >= 1) that downsamples a span to at most `maxPoints` buckets. */
export function bucketWidthSeconds(spanMs: number, maxPoints: number): number {
  if (!(maxPoints > 0)) return 1;
  return Math.max(1, Math.ceil(spanMs / 1000 / maxPoints));
}

/**
 * Prepends the launch anchor to a recorded series when it genuinely predates
 * the first recorded point (or when nothing has been recorded yet). Never
 * inserts an anchor newer than a real observation -- a real point always
 * wins over a derived one.
 */
export function withAnchor(points: NavPoint[], anchor: NavPoint | null): NavPoint[] {
  if (!anchor || !(anchor.nav > 0)) return points;
  if (points.length === 0) return [anchor];
  return anchor.t < points[0].t ? [anchor, ...points] : points;
}
