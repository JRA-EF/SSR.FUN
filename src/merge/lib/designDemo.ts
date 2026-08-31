/* Design-preview chart data (design branch tooling).
 *
 * The DevNet fixture Reserves sit at a flat $1.00 with no trade history, so
 * every chart renders as a flatline while designing. This module overlays a
 * DETERMINISTIC synthetic price series on top of a Reserve whose real
 * recorded history is empty/flat, so chart styling can be judged against
 * realistic movement.
 *
 * Honesty constraints (per CLAUDE.md's "nothing here is invented history"
 * standards):
 * - Opt-in only: enabled with ?demo=1 in the URL (persisted to localStorage,
 *   cleared with ?demo=0). Never on by default.
 * - Never on Mainnet: callers pass their IS_MAINNET and the overlay refuses.
 * - Never replaces genuine data: if a Reserve has real price movement, the
 *   overlay declines and the real series renders.
 * - Always disclosed: consumers must surface `active` as a visible
 *   "synthetic preview data" note wherever the series is charted.
 *
 * Kept import-light (types only) so test files that load reserveCardProps
 * through ts-mocha's CommonJS loader never pull in import.meta-dependent
 * modules (same constraint as reserveCardProps.ts itself).
 */

import type { DTR, PricePoint } from "./types";

const FLAG_KEY = "ssr-design-demo";
const DAY_MS = 86_400_000;

export function isDesignDemoEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("demo");
    if (q === "1") window.localStorage.setItem(FLAG_KEY, "1");
    if (q === "0") window.localStorage.removeItem(FLAG_KEY);
    return window.localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Deterministic PRNG so a given Reserve always draws the same curve. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 30 days of synthetic history ending exactly at `endPrice`: 2h resolution
 * for the older span, 5min for the trailing 24h (so intraday timeframes have
 * something to show), random-walk steps with volatility scaled by step size.
 */
export function demoPriceHistory(seed: string, endPrice: number, now: number): PricePoint[] {
  const rnd = mulberry32(hashSeed(seed));
  const times: number[] = [];
  for (let t = now - 30 * DAY_MS; t < now - DAY_MS; t += 2 * 3_600_000) times.push(t);
  for (let t = now - DAY_MS; t < now; t += 5 * 60_000) times.push(t);
  times.push(now);

  const drift = (rnd() - 0.42) * 0.0035; // mild per-2h bias, usually upward
  let price = 1;
  const points: PricePoint[] = [];
  let prev = times[0];
  for (const t of times) {
    const dtScale = Math.sqrt(Math.max(t - prev, 60_000) / (2 * 3_600_000));
    price *= 1 + drift * dtScale * dtScale + (rnd() - 0.5) * 0.016 * dtScale;
    points.push({ t, price });
    prev = t;
  }
  const k = endPrice / points[points.length - 1].price;
  for (const p of points) p.price *= k;
  return points;
}

function isEffectivelyFlat(history: PricePoint[]): boolean {
  const prices = history.map((p) => p.price).filter((v) => Number.isFinite(v) && v > 0);
  if (prices.length < 5) return true;
  const max = Math.max(...prices);
  return (max - Math.min(...prices)) / max < 0.001;
}

export interface DemoCompositionAsset {
  symbol: string;
  name: string;
  weight: number;
  priceUsd: number;
  pnlPct: number;
  valueUsd: number;
  marketCapUsd: number;
  change7dPct: number;
  volume24hUsd: number;
}

/* Illustrative 7-asset Solana basket (the same roster the marketing site's
 * basket demo uses), with fixed plausible prices/P&L so the composition
 * grid and table have real-looking variety to be designed against. TVL is
 * the marketing demo's $2.41M figure. */
const DEMO_TVL_USD = 2_412_880;
const DEMO_COMPOSITION: DemoCompositionAsset[] = (
  [
    // symbol, name, weight, price, pnl%, mcap, 7d%, 24h volume
    ["SOL", "Solana", 0.28, 158.42, 34.1, 74_500_000_000, 6.2, 2_100_000_000],
    ["JUP", "Jupiter", 0.17, 0.92, 18.6, 2_480_000_000, 3.1, 88_000_000],
    ["JTO", "Jito", 0.13, 3.41, -7.2, 1_150_000_000, -1.8, 46_000_000],
    ["RAY", "Raydium", 0.12, 4.85, 22.9, 1_320_000_000, 4.4, 61_000_000],
    ["PYTH", "Pyth Network", 0.11, 0.38, -12.4, 1_390_000_000, -2.6, 52_000_000],
    ["BONK", "Bonk", 0.1, 0.0000214, 41.7, 1_580_000_000, 9.8, 210_000_000],
    ["WIF", "dogwifhat", 0.09, 2.06, 9.3, 2_060_000_000, 2.2, 145_000_000],
  ] as const
).map(([symbol, name, weight, priceUsd, pnlPct, marketCapUsd, change7dPct, volume24hUsd]) => ({
  symbol,
  name,
  weight,
  priceUsd,
  pnlPct,
  valueUsd: weight * DEMO_TVL_USD,
  marketCapUsd,
  change7dPct,
  volume24hUsd,
}));

export interface DemoCreatorNote {
  t: number;
  title: string;
  body: string;
  /** Short label for the note's marker pill on the price chart. */
  tag: string;
}

/** Illustrative "Notes from the Creator" changelog, newest first. */
function demoCreatorNotes(now: number): DemoCreatorNote[] {
  return [
    {
      t: now - 2 * DAY_MS,
      title: "Mint fee reduced to 0.50%",
      body: "Lowered from 0.75% to make smaller first-time mints cheaper during the growth phase.",
      tag: "Fee cut",
    },
    {
      t: now - 6 * DAY_MS,
      title: "Composition change: added WIF at 9%",
      body: "Added WIF for memecoin exposure after the community vote; funded by trimming JTO (14% → 13%) and RAY.",
      tag: "Added WIF",
    },
    {
      t: now - 14 * DAY_MS,
      title: "Rebalanced: trimmed SOL, added to PYTH",
      body: "SOL had drifted above 32% of the basket after its rally. Trimmed back to the 28% target and raised PYTH to 11% to keep oracle-network exposure meaningful.",
      tag: "Rebalance",
    },
    {
      t: now - 26 * DAY_MS,
      title: "Reserve launched",
      body: "Deployed with a 7-asset Solana basket spanning the ecosystem's core infrastructure, liquidity, and community tokens.",
      tag: "Launch",
    },
  ];
}

export interface DesignDemoOverlay {
  active: true;
  priceHistory: PricePoint[];
  change24h: number;
  change7d: number;
  /** Illustrative 7-asset composition for the detail page's grid/table. */
  composition: DemoCompositionAsset[];
  /** Illustrative creator changelog for the "Notes from the Creator" section. */
  creatorNotes: DemoCreatorNote[];
}

/* One overlay per Reserve per session, so timestamps/curve stay stable
   across re-renders instead of resampling on every render's Date.now(). */
const cache = new Map<string, DesignDemoOverlay>();

export function applyDesignDemo(dtr: DTR, isMainnet: boolean): DesignDemoOverlay | null {
  if (isMainnet || !isDesignDemoEnabled()) return null;
  if (!isEffectivelyFlat(dtr.priceHistory)) return null;

  const endPrice = Number.isFinite(dtr.tokenPrice) && dtr.tokenPrice > 0 ? dtr.tokenPrice : 1;
  const key = `${dtr.id}:${endPrice.toFixed(6)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const now = Date.now();
  const priceHistory = demoPriceHistory(dtr.id, endPrice, now);
  const priceAt = (ageMs: number): number => {
    const cutoff = now - ageMs;
    for (let i = priceHistory.length - 1; i >= 0; i--) {
      if (priceHistory[i].t <= cutoff) return priceHistory[i].price;
    }
    return priceHistory[0].price;
  };
  const changeSince = (base: number) => (base > 0 ? ((endPrice - base) / base) * 100 : 0);
  const overlay: DesignDemoOverlay = {
    active: true,
    priceHistory,
    change24h: changeSince(priceAt(DAY_MS)),
    change7d: changeSince(priceAt(7 * DAY_MS)),
    composition: DEMO_COMPOSITION,
    creatorNotes: demoCreatorNotes(now),
  };
  cache.set(key, overlay);
  return overlay;
}
