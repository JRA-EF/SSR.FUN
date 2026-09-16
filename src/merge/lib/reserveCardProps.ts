// Shared card-presentation logic for genuine on-chain Reserves, used by both
// Discover.tsx and the native landing page's Featured Reserve section -- one
// code path instead of two independently-computed views of the same DTR, so
// they can never drift back out of sync with each other.
import { formatUsdc, formatUsdcOrUnavailable, buildLineSeries, calcAllTimeChangePct } from "./calculations";
import { applyDesignDemo } from "./designDemo";
import { computeMarketCap } from "./onChainReserve";
import { normalizeReserveCategory, type DTR } from "./types";

export interface ReserveCardData {
  name: string;
  ticker: string;
  description: string;
  avatarLabel: string;
  avatarImageUrl: string | undefined;
  categoryLabel: string;
  sourceBadge: { label: string; tone: "onchain" | "simulated" };
  priceFormatted: string;
  changePct: number;
  changeFormatted: string;
  sparkline: number[];
  sparklineTimestamps: number[];
  sparklineValueFmt: (v: number) => string;
  /** True when `sparkline` is a client-side flatline fallback (no genuine trade history yet), not real observations. */
  sparklineIsFallback: boolean;
  topAssets: string[];
  metrics: { key: string; label: string; value: string; tone?: "up" | "down" }[];
}

/**
 * Per-Reserve figures the card can't derive from the DTR alone -- today just
 * the all-time trade volume, which lives in the landing-stats API (see
 * hooks/useLandingStats.ts: `perReserve[reserve].volumeAllTimeUsd`). Callers
 * pass the hook's state through; the card renders the same "Loading…" /
 * "Unavailable" placeholders as DTRDetail's All-Time Volume tile, never a
 * fabricated $0 for a live Reserve.
 */
export interface ReserveCardStats {
  /** `landingStats.data?.perReserve[reserve]?.volumeAllTimeUsd`, or undefined when the response has no row for this Reserve. */
  volumeAllTimeUsd?: number | null;
  /** `landingStats.status`. */
  status: "loading" | "ready" | "unavailable";
}

/**
 * Derives every plain-data prop `ReserveCard` needs from a DTR -- identical
 * for Discover's grid and the landing page's Featured Reserves.
 *
 * `isMainnet` was previously hardcoded away entirely -- the on-chain source
 * badge always read "Live on Solana DevNet", even for a Reserve genuinely
 * deployed on Mainnet (see docs/project/DECISION_LOG.md's entry for this
 * pass). Accepted as a plain parameter (default false/DevNet, matching every
 * pre-existing test/caller unchanged) rather than importing IS_MAINNET from
 * ./solana-config directly -- that module reads import.meta.env (Vite-only
 * syntax) and this file is required directly by several tests/phase_*.ts
 * files via ts-mocha's CommonJS loader, which crashes on that syntax (same
 * constraint documented in onChainReserve.ts's own header). Real callers
 * (Discover.tsx, the landing page) pass the real IS_MAINNET themselves.
 */
export function buildReserveCardProps(dtr: DTR, isMainnet: boolean = false, stats?: ReserveCardStats): ReserveCardData {
  const clusterLabel = isMainnet ? "Mainnet" : "DevNet";
  // dtr.nav can be 0 when a Reserve's assets are under-resolved (AUM reads as
  // $0) even though it already has token supply -- guard against NaN rather
  // than computing 0/0 (same class of bug fixed in DTRDetail.tsx).
  const validNav = dtr.nav > 0 && Number.isFinite(dtr.nav) ? dtr.nav : null;
  const topAssets = [...dtr.composition]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((a) => a.symbol);
  // Design-preview overlay (?demo=1, DevNet-only): flat fixture Reserves get a
  // synthetic sparkline/change so chart styling can be reviewed -- see designDemo.ts.
  const demo = applyDesignDemo(dtr, isMainnet);
  const change24h = demo ? demo.change24h : dtr.change24h;
  const recentHistory = buildLineSeries(demo ? demo.priceHistory : dtr.priceHistory, "7d", validNav);
  const pricingUnavailable = isMainnet && dtr.onChain?.priceSource === "unavailable";
  const marketCap = computeMarketCap(dtr.onChain?.reserveTokenSupplyRaw ?? "0", dtr.tokenPrice);
  // All-time PNL (%): the same figure (and the same guards) as DTRDetail's
  // stats band -- current Token Price vs. the earliest point of the history.
  // On Mainnet that baseline is only meaningful once the server-served
  // launch anchor has been merged (priceHistoryRecordedFrom set); before
  // that the sole point is this browser's own first observation, which would
  // read as a misleading 0%, so it shows "--" instead.
  const allTimePnlPct = demo
    ? calcAllTimeChangePct(demo.priceHistory, demo.priceHistory[demo.priceHistory.length - 1]?.price)
    : !isMainnet || dtr.priceHistoryRecordedFrom !== undefined
      ? calcAllTimeChangePct(dtr.priceHistory, dtr.nav)
      : null;
  // All-time volume: a simulated DTR has no Ledger rows, so $0 is the honest
  // answer; a live Reserve reads the landing-stats row, with the same
  // Loading/Unavailable placeholders DTRDetail's tile shows.
  const allTimeVolume = !dtr.onChain
    ? formatUsdc(0, { compact: true })
    : typeof stats?.volumeAllTimeUsd === "number"
      ? formatUsdc(stats.volumeAllTimeUsd, { compact: true })
      : stats?.status === "loading"
        ? "Loading…"
        : "Unavailable";

  return {
    name: dtr.name,
    ticker: dtr.ticker,
    description: dtr.description,
    avatarLabel: dtr.ticker.slice(0, 2),
    avatarImageUrl: dtr.logoUrl,
    categoryLabel: normalizeReserveCategory(dtr.category),
    sourceBadge: dtr.onChain
      ? { label: `Live on Solana ${clusterLabel}`, tone: "onchain" }
      : { label: "Simulated Demo", tone: "simulated" },
    priceFormatted: formatUsdcOrUnavailable(dtr.tokenPrice, !pricingUnavailable),
    changePct: change24h,
    changeFormatted: `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`,
    sparkline: recentHistory.unavailable ? [] : recentHistory.points.map((p) => p.price),
    sparklineTimestamps: recentHistory.unavailable ? [] : recentHistory.points.map((p) => p.t),
    sparklineValueFmt: formatUsdc,
    sparklineIsFallback: recentHistory.isFallback,
    topAssets,
    // The same stats as DTRDetail's band under the chart (Market Cap,
    // All-Time PNL (%), All-Time Volume) plus Price -- the legacy 24h and
    // Prem/Discount chips are gone (Prem/Discount is always ~0% while every
    // Buy/Sell executes at NAV; see DTRDetail's stats-grid comment).
    metrics: [
      { key: "price", label: "Price", value: formatUsdcOrUnavailable(dtr.tokenPrice, !pricingUnavailable) },
      { key: "mcap", label: "Market Cap", value: formatUsdcOrUnavailable(marketCap, !pricingUnavailable, { compact: true }) },
      {
        key: "pnl",
        label: "All-Time PNL (%)",
        value: allTimePnlPct !== null ? `${allTimePnlPct >= 0 ? "+" : ""}${allTimePnlPct.toFixed(2)}%` : "—",
        tone: allTimePnlPct !== null ? (allTimePnlPct >= 0 ? "up" : "down") : undefined,
      },
      { key: "volume", label: "All-Time Volume", value: allTimeVolume },
    ],
  };
}

/**
 * Picks the top `n` on-chain Reserves by AUM -- the first `n` of Discover's
 * default (AUM-descending) order, so Featured mirrors the top of the Discover
 * grid (DEC-0201, 2026-09-16), with exactly two exclusions:
 *  - a purely local/simulated DTR (no onChain data), no matter how large its
 *    fixture AUM is;
 *  - a Reserve that is winding down (DEC-0202): it stays visible/tradable-out
 *    on Discover (see reserveEligibility.ts's WD-01 fix) but must never be
 *    curated as a "Featured" highlight while it's on its way to closing.
 * The earlier gates on assets-fully-resolved, tradable composition and a real
 * (non-"Unnamed Reserve") name were dropped on purpose in DEC-0201.
 */
export function selectFeaturedReserves(dtrs: DTR[], n = 3): DTR[] {
  return dtrs
    .filter((d) => Boolean(d.onChain) && d.onChain?.status !== "windDown")
    .sort((a, b) => b.aum - a.aum)
    .slice(0, n);
}
