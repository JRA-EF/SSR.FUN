// Shared card-presentation logic for genuine on-chain Reserves, used by both
// Discover.tsx and the native landing page's Featured Reserve section -- one
// code path instead of two independently-computed views of the same DTR, so
// they can never drift back out of sync with each other.
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
  topAssets: string[];
  metrics: { key: string; label: string; value: string; tone?: "up" | "down" }[];
}

/** Derives every plain-data prop `ReserveCard` needs from a DTR -- identical for Discover's grid and the landing page's Featured Reserves. */
export function buildReserveCardProps(dtr: DTR): ReserveCardData {
  const premiumDiscount = ((dtr.tokenPrice - dtr.nav) / dtr.nav) * 100;
  const topAssets = [...dtr.composition]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((a) => a.symbol);
  const recentHistory = buildLineSeries(dtr.priceHistory, "7d").points;

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
    sparkline: recentHistory.map((p) => p.price),
    sparklineTimestamps: recentHistory.map((p) => p.t),
    sparklineValueFmt: formatUsdc,
    topAssets,
    metrics: [
      { key: "price", label: "Price", value: formatUsdc(dtr.tokenPrice) },
      { key: "24h", label: "24h", value: `${dtr.change24h >= 0 ? "+" : ""}${dtr.change24h.toFixed(2)}%`, tone: dtr.change24h >= 0 ? "up" : "down" },
      { key: "nav", label: "NAV", value: formatUsdc(dtr.nav) },
      { key: "prem", label: "Prem/Discount", value: `${premiumDiscount >= 0 ? "+" : ""}${premiumDiscount.toFixed(2)}%`, tone: premiumDiscount >= 0 ? "up" : "down" },
    ],
  };
}

/** Picks the top `n` genuinely on-chain-verified Reserves by AUM -- never a simulated/placeholder DTR, no matter how large its fixture AUM is. */
export function selectFeaturedReserves(dtrs: DTR[], n = 3): DTR[] {
  return dtrs
    .filter((d) => Boolean(d.onChain))
    .sort((a, b) => b.aum - a.aum)
    .slice(0, n);
}
