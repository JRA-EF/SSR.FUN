// One shape for "a reserve" in the directory, whichever chain it lives on.
//
// Home (Featured) and Discover both build these, so a Robinhood Chain reserve
// is ranked, filtered and rendered exactly like a Solana one instead of
// sitting in a section of its own. Type-only imports of the EVM modules keep
// this file viem-free, so the main bundle stays unchanged.
import type { ReserveCardProps } from "../../components/ReserveCard";
import type { ReserveSnapshot } from "./evmReserve";
import type { DTR } from "./types";
import { buildReserveCardProps, type ReserveCardStats } from "./reserveCardProps";
import { normalizeReserveCategory } from "./types";
import { formatUsdc } from "./calculations";
import { rhReserveId } from "./evmReserveId";

export type EntryChain = "solana" | "robinhood";

export interface DirectoryEntry {
  key: string;
  chain: EntryChain;
  name: string;
  ticker: string;
  category: string | null;
  /** Ranking value. An unpriced reserve contributes 0 rather than a guess. */
  aum: number;
  price: number;
  change24h: number;
  /** Route into the shared /dtr/:id reserve page. */
  href: string;
  card: Omit<ReserveCardProps, "renderCta">;
}

export function solanaEntry(dtr: DTR, isMainnet: boolean, stats: ReserveCardStats): DirectoryEntry {
  return {
    key: `sol:${dtr.id}`,
    chain: "solana",
    name: dtr.name,
    ticker: dtr.ticker,
    category: normalizeReserveCategory(dtr.category),
    aum: dtr.aum,
    price: dtr.tokenPrice,
    change24h: dtr.change24h,
    href: `/dtr/${dtr.id}`,
    card: buildReserveCardProps(dtr, isMainnet, stats),
  };
}

/**
 * A Robinhood Chain reserve as a standard card. Every number is on-chain:
 * holdings from the reserve, marked to USDG at Uniswap v3 spot. There is no
 * price history or volume index for Robinhood yet, so those read "—" rather
 * than inventing a figure.
 */
export function robinhoodEntry(r: ReserveSnapshot): DirectoryEntry {
  const byValue = [...r.basket].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const price = r.navPerShare;
  const aum = r.aumUsd;
  return {
    key: `rh:${r.address}`,
    chain: "robinhood",
    name: r.name,
    ticker: r.symbol,
    category: null,
    aum: aum ?? 0,
    price: price ?? 0,
    change24h: 0,
    href: `/dtr/${rhReserveId(r.address)}`,
    card: {
      name: r.name,
      ticker: r.symbol,
      description: `A basket of ${byValue.map((b) => b.symbol).join(", ")} held on Robinhood Chain.`,
      avatarLabel: r.symbol.slice(0, 2),
      categoryLabel: "Robinhood Chain",
      sourceBadge: { label: "Live on Robinhood Chain", tone: "onchain" },
      priceFormatted: price === null ? "Price unavailable" : formatUsdc(price),
      changePct: 0,
      changeFormatted: "—",
      sparkline: [],
      topAssets: byValue.map((b) => b.symbol),
      metrics: [
        { key: "price", label: "Price", value: price === null ? "—" : formatUsdc(price) },
        { key: "mcap", label: "Market Cap", value: aum === null ? "—" : formatUsdc(aum, { compact: true }) },
        { key: "pnl", label: "All-Time PNL (%)", value: "—" },
        { key: "volume", label: "All-Time Volume", value: "—" },
      ],
    },
  };
}

/** Featured = the largest live reserves, across every chain. */
export function selectFeaturedEntries(entries: DirectoryEntry[], n = 3): DirectoryEntry[] {
  return [...entries].sort((a, b) => b.aum - a.aum).slice(0, n);
}
