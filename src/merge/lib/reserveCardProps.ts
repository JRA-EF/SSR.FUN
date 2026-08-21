// Shared card-presentation logic for genuine on-chain Reserves, used by both
// Discover.tsx and the native landing page's Featured Reserve section -- one
// code path instead of two independently-computed views of the same DTR, so
// they can never drift back out of sync with each other.
import { isReserveTradable } from "@ssr/sdk";
import { formatUsdc, formatUsdcOrUnavailable, buildLineSeries } from "./calculations";
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
export function buildReserveCardProps(dtr: DTR, isMainnet: boolean = false): ReserveCardData {
  const clusterLabel = isMainnet ? "Mainnet" : "DevNet";
  // dtr.nav can be 0 when a Reserve's assets are under-resolved (AUM reads as
  // $0) even though it already has token supply -- guard against NaN rather
  // than computing 0/0 (same class of bug fixed in DTRDetail.tsx).
  const validNav = dtr.nav > 0 && Number.isFinite(dtr.nav) ? dtr.nav : null;
  const premiumDiscount = validNav !== null ? ((dtr.tokenPrice - validNav) / validNav) * 100 : null;
  const topAssets = [...dtr.composition]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((a) => a.symbol);
  const recentHistory = buildLineSeries(dtr.priceHistory, "7d", validNav);
  const pricingUnavailable = isMainnet && dtr.onChain?.priceSource === "unavailable";
  const marketCap = computeMarketCap(dtr.onChain?.reserveTokenSupplyRaw ?? "0", dtr.tokenPrice);

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
    changePct: dtr.change24h,
    changeFormatted: `${dtr.change24h >= 0 ? "+" : ""}${dtr.change24h.toFixed(2)}%`,
    sparkline: recentHistory.unavailable ? [] : recentHistory.points.map((p) => p.price),
    sparklineTimestamps: recentHistory.unavailable ? [] : recentHistory.points.map((p) => p.t),
    sparklineValueFmt: formatUsdc,
    sparklineIsFallback: recentHistory.isFallback,
    topAssets,
    metrics: [
      { key: "price", label: "Price", value: formatUsdcOrUnavailable(dtr.tokenPrice, !pricingUnavailable) },
      { key: "24h", label: "24h", value: `${dtr.change24h >= 0 ? "+" : ""}${dtr.change24h.toFixed(2)}%`, tone: dtr.change24h >= 0 ? "up" : "down" },
      { key: "mcap", label: "Market Cap", value: formatUsdcOrUnavailable(marketCap, !pricingUnavailable, { compact: true }) },
      {
        key: "prem",
        label: "Prem/Discount",
        value: premiumDiscount !== null ? `${premiumDiscount >= 0 ? "+" : ""}${premiumDiscount.toFixed(2)}%` : "—",
        tone: premiumDiscount !== null ? (premiumDiscount >= 0 ? "up" : "down") : undefined,
      },
    ],
  };
}

/**
 * Picks the top `n` genuinely on-chain-verified, fully-resolved, tradable,
 * named Reserves by AUM -- never a simulated/placeholder DTR no matter how
 * large its fixture AUM is, and never a Reserve this discovery pass couldn't
 * fully resolve, couldn't confirm is within the supported asset set, or
 * couldn't recover a real name for (an "Unnamed Reserve (#N)" placeholder is
 * exactly the kind of Reserve that shouldn't be prominently featured).
 */
export function selectFeaturedReserves(dtrs: DTR[], n = 3): DTR[] {
  return dtrs
    .filter((d) => {
      if (!d.onChain) return false;
      if (d.onChain.assetsResolvedFully !== true) return false;
      if (!isReserveTradable(d.onChain.assets.map((a) => a.mint))) return false;
      if (d.name.startsWith("Unnamed Reserve")) return false;
      // A wound-down Reserve is genuinely visible/tradable-out (see
      // reserveEligibility.ts's WD-01 fix) but shouldn't be curated as a
      // "Featured" highlight while it's on its way to closing.
      if (d.onChain.status === "windDown") return false;
      return true;
    })
    .sort((a, b) => b.aum - a.aum)
    .slice(0, n);
}
