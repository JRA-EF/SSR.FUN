// Shared card-presentation logic for genuine on-chain Reserves, used by both
// Discover.tsx and the native landing page's Featured Reserve section -- one
// code path instead of two independently-computed views of the same DTR, so
// they can never drift back out of sync with each other.
import { isReserveTradable } from "@ssr/sdk";
import { formatUsdc, buildLineSeries } from "./calculations";
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

/** Derives every plain-data prop `ReserveCard` needs from a DTR -- identical for Discover's grid and the landing page's Featured Reserves. */
export function buildReserveCardProps(dtr: DTR): ReserveCardData {
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

  return {
    name: dtr.name,
    ticker: dtr.ticker,
    description: dtr.description,
    avatarLabel: dtr.ticker.slice(0, 2),
    avatarImageUrl: dtr.logoUrl,
    categoryLabel: normalizeReserveCategory(dtr.category),
    sourceBadge: dtr.onChain
      ? { label: "Live on Solana DevNet", tone: "onchain" }
      : { label: "Simulated Demo", tone: "simulated" },
    priceFormatted: formatUsdc(dtr.tokenPrice),
    changePct: dtr.change24h,
    changeFormatted: `${dtr.change24h >= 0 ? "+" : ""}${dtr.change24h.toFixed(2)}%`,
    sparkline: recentHistory.unavailable ? [] : recentHistory.points.map((p) => p.price),
    sparklineTimestamps: recentHistory.unavailable ? [] : recentHistory.points.map((p) => p.t),
    sparklineValueFmt: formatUsdc,
    sparklineIsFallback: recentHistory.isFallback,
    topAssets,
    metrics: [
      { key: "price", label: "Price", value: formatUsdc(dtr.tokenPrice) },
      { key: "24h", label: "24h", value: `${dtr.change24h >= 0 ? "+" : ""}${dtr.change24h.toFixed(2)}%`, tone: dtr.change24h >= 0 ? "up" : "down" },
      { key: "nav", label: "NAV", value: validNav !== null ? formatUsdc(validNav) : "—" },
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
