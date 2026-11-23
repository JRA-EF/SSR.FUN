// One shape for "a reserve" in the directory, whichever chain it lives on.
//
// Home (Featured) and Discover both build these, so a Robinhood Chain reserve
// is ranked, filtered and rendered exactly like a Solana one instead of
// sitting in a section of its own. Type-only imports of the EVM modules keep
// this file viem-free, so the main bundle stays unchanged.
import type { ReserveCardProps } from "../../components/ReserveCard";
import type { ReserveSnapshot } from "./evmReserve";
import type { DTR } from "./types";
import { buildReserveCardProps, isNearlyEmptyReserve, type ReserveCardStats } from "./reserveCardProps";
import type { LiquidityPoolPreview } from "./liquidityPreview";
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
  /** Hidden from Discover by default (see isSmallOrInactiveReserve); shown with "Show small/inactive Reserves". */
  smallOrInactive: boolean;
  card: Omit<ReserveCardProps, "renderCta">;
}

/** `pool` = the Reserve Token's liquidity pool preview (DEC-0217/0218), when one exists -- drives the card's trust badges. */
export function solanaEntry(dtr: DTR, isMainnet: boolean, stats: ReserveCardStats, pool?: LiquidityPoolPreview): DirectoryEntry {
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
    smallOrInactive: isSmallOrInactiveReserve(dtr),
    card: buildReserveCardProps(dtr, isMainnet, stats, pool),
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
  // The creator's own profile (description, category, picture) when the
  // reserve's mandate points at this app's metadata store -- the same fields
  // a Solana card shows. A reserve created elsewhere falls back to a
  // basket-derived line and the ticker-initial avatar, never an invented one.
  const meta = r.meta;
  const category = normalizeReserveCategory(meta?.category);
  return {
    key: `rh:${r.address}`,
    chain: "robinhood",
    name: r.name,
    ticker: r.symbol,
    category,
    aum: aum ?? 0,
    price: price ?? 0,
    change24h: 0,
    href: `/dtr/${rhReserveId(r.address)}`,
    smallOrInactive: aum !== null && aum < SMALL_RESERVE_TVL_USD,
    card: {
      name: r.name,
      ticker: r.symbol,
      description: meta?.description.trim() || `A basket of ${byValue.map((b) => b.symbol).join(", ")} held on Robinhood Chain.`,
      avatarLabel: r.symbol.slice(0, 2),
      avatarImageUrl: meta?.imageUrl,
      categoryLabel: meta?.category.trim() ? category : "Robinhood Chain",
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

/** Below this TVL (USD) a live Reserve counts as "small" and Discover hides it by default. */
export const SMALL_RESERVE_TVL_USD = 1;

/**
 * Discover's default filter (beta feedback, 2026-11-23): hides test/junk
 * Reserves -- under one Reserve Token in circulation (empty Reserves included,
 * DEC-0246) or a priced TVL under $1 -- behind the "Show small/inactive
 * Reserves" toggle. A Reserve whose price is unavailable is never hidden for
 * its TVL (its $0 AUM is "unknown", not "small"); simulated fixtures are never
 * hidden. The Reserve page and direct links are unaffected.
 */
export function isSmallOrInactiveReserve(dtr: Pick<DTR, "aum" | "onChain">): boolean {
  const oc = dtr.onChain;
  if (!oc) return false;
  if (isNearlyEmptyReserve(oc)) return true;
  if (oc.priceSource === "unavailable" || oc.priceSource === "none") return false;
  return Number.isFinite(dtr.aum) && dtr.aum < SMALL_RESERVE_TVL_USD;
}

/** Featured = the largest live reserves, across every chain. */
export function selectFeaturedEntries(entries: DirectoryEntry[], n = 3): DirectoryEntry[] {
  return [...entries].sort((a, b) => b.aum - a.aum).slice(0, n);
}
