// Deterministic fictional DTR catalog + mock price history.
// No live data is ever fetched -- everything here is generated from fixed seeds
// so numbers stay stable across reloads and sessions.

import type { DTR, DTRAsset, FeeConfig, PricePoint, PriceRange } from "./types";
import { DEFAULT_MANAGER_TAX_BPS, DEFAULT_MINT_FEE_BPS, DEFAULT_TVL_FEE_BPS } from "./calculations";

import blueLogo from "@/assets/dtr-logos/blue.png";
import memeLogo from "@/assets/dtr-logos/meme.png";
import sdefiLogo from "@/assets/dtr-logos/sdefi.png";
import ssrresLogo from "@/assets/dtr-logos/ssrres.png";
import infraLogo from "@/assets/dtr-logos/infra.png";
import gamingLogo from "@/assets/dtr-logos/gaming.png";

const DTR_LOGOS: Record<string, string> = {
  blue: blueLogo,
  meme: memeLogo,
  sdefi: sdefiLogo,
  ssrres: ssrresLogo,
  infra: infraLogo,
  gaming: gamingLogo,
};

/** Shared logo art pool -- every DTR (seeded or user-created) gets a real image, never just letters. */
export const DTR_LOGO_POOL: string[] = Object.values(DTR_LOGOS);

/** Deterministically picks a logo for any DTR id/ticker so user-created DTRs also get a real image. */
export function pickLogoForId(id: string): string {
  const hash = hashSeed(id);
  return DTR_LOGO_POOL[hash % DTR_LOGO_POOL.length];
}

// --- Deterministic PRNG (mulberry32) seeded from a string hash ---------

function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = new Date("2026-07-14T12:00:00Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Generates a deterministic random-walk price series ending at `endPrice`. */
function generateSeries(
  seedKey: string,
  points: number,
  stepMs: number,
  endPrice: number,
  volatility: number,
): PricePoint[] {
  const rand = mulberry32(hashSeed(seedKey));
  // Walk forward from an offset start price so the series ends at endPrice.
  const walk: number[] = [0];
  for (let i = 1; i < points; i++) {
    const shock = (rand() - 0.5) * 2 * volatility;
    walk.push(walk[i - 1] + shock);
  }
  const lastWalk = walk[walk.length - 1];
  const startTime = NOW - stepMs * (points - 1);
  return walk.map((w, i) => {
    // Normalize so the walk ends exactly at endPrice, preserving relative shape.
    const normalized = endPrice * (1 + (w - lastWalk) * 0.15);
    return {
      t: startTime + i * stepMs,
      price: Math.max(normalized, endPrice * 0.05),
    };
  });
}

function buildPriceHistory(seedKey: string, endPrice: number): Record<PriceRange, PricePoint[]> {
  return {
    "24H": generateSeries(`${seedKey}-24h`, 24, HOUR, endPrice, 0.6),
    "7D": generateSeries(`${seedKey}-7d`, 28, 6 * HOUR, endPrice, 1.1),
    "30D": generateSeries(`${seedKey}-30d`, 30, DAY, endPrice, 1.8),
    All: generateSeries(`${seedKey}-all`, 52, 7 * DAY, endPrice, 2.6),
  };
}

interface DTRSeed {
  id: string;
  name: string;
  ticker: string;
  description: string;
  category: string;
  nav: number;
  premiumPct: number; // token price = nav * (1 + premiumPct/100)
  aum: number;
  change24h: number;
  change7d: number;
  holders: number;
  composition: DTRAsset[];
}

const DTR_SEEDS: DTRSeed[] = [
  {
    id: "blue",
    name: "Solana Blue Chips",
    ticker: "BLUE",
    description:
      "A DTR of the most established, highest-liquidity assets in the Solana ecosystem. Built for holders who want broad exposure without picking individual winners.",
    category: "Blue Chip",
    nav: 18.42,
    premiumPct: 1.8,
    aum: 24_600_000,
    change24h: 2.4,
    change7d: 6.1,
    holders: 3182,
    composition: [
      { symbol: "SOL", name: "Solana", weight: 0.4 },
      { symbol: "JUP", name: "Jupiter", weight: 0.2 },
      { symbol: "JTO", name: "Jito", weight: 0.15 },
      { symbol: "RAY", name: "Raydium", weight: 0.15 },
      { symbol: "USDC", name: "USD Coin", weight: 0.1 },
    ],
  },
  {
    id: "meme",
    name: "Meme Machine",
    ticker: "MEME",
    description:
      "High-beta exposure to the Solana meme coin complex. Volatile by design -- for holders who want the reserve to ride the cycle, not dampen it.",
    category: "Meme",
    nav: 4.07,
    premiumPct: -3.2,
    aum: 9_850_000,
    change24h: -5.8,
    change7d: 14.3,
    holders: 5941,
    composition: [
      { symbol: "BONK", name: "Bonk", weight: 0.25 },
      { symbol: "WIF", name: "dogwifhat", weight: 0.25 },
      { symbol: "POPCAT", name: "Popcat", weight: 0.2 },
      { symbol: "FARTCOIN", name: "Fartcoin", weight: 0.2 },
      { symbol: "USDC", name: "USD Coin", weight: 0.1 },
    ],
  },
  {
    id: "sdefi",
    name: "Solana DeFi",
    ticker: "SDEFI",
    description:
      "Concentrated exposure to the protocols powering Solana DeFi -- DEXs, lending, and liquid staking infrastructure in a single reserve.",
    category: "DeFi",
    nav: 11.95,
    premiumPct: 0.6,
    aum: 15_200_000,
    change24h: 1.1,
    change7d: -2.4,
    holders: 2467,
    composition: [
      { symbol: "JUP", name: "Jupiter", weight: 0.3 },
      { symbol: "RAY", name: "Raydium", weight: 0.25 },
      { symbol: "DRIFT", name: "Drift Protocol", weight: 0.2 },
      { symbol: "JTO", name: "Jito", weight: 0.15 },
      { symbol: "USDC", name: "USD Coin", weight: 0.1 },
    ],
  },
  {
    id: "ssrres",
    name: "SSR Strategic Reserve",
    ticker: "SSRRES",
    description:
      "The flagship reserve anchored in SSR itself, paired with core Solana infrastructure assets. Designed for long-horizon holders aligned with the protocol.",
    category: "Strategic",
    nav: 32.18,
    premiumPct: 4.1,
    aum: 41_300_000,
    change24h: 3.6,
    change7d: 9.8,
    holders: 6820,
    composition: [
      { symbol: "SSR", name: "SSR", weight: 0.5 },
      { symbol: "SOL", name: "Solana", weight: 0.2 },
      { symbol: "JUP", name: "Jupiter", weight: 0.1 },
      { symbol: "RENDER", name: "Render", weight: 0.1 },
      { symbol: "USDC", name: "USD Coin", weight: 0.1 },
    ],
  },
  {
    id: "infra",
    name: "Solana Infrastructure",
    ticker: "INFRA",
    description:
      "Exposure to the picks-and-shovels layer of Solana -- oracles, RPC networks, storage, and depin infrastructure that the rest of the ecosystem depends on.",
    category: "Infrastructure",
    nav: 8.63,
    premiumPct: -1.1,
    aum: 6_400_000,
    change24h: -0.7,
    change7d: 3.2,
    holders: 1284,
    composition: [
      { symbol: "RENDER", name: "Render", weight: 0.3 },
      { symbol: "HNT", name: "Helium", weight: 0.25 },
      { symbol: "PYTH", name: "Pyth Network", weight: 0.25 },
      { symbol: "SOL", name: "Solana", weight: 0.1 },
      { symbol: "USDC", name: "USD Coin", weight: 0.1 },
    ],
  },
  {
    id: "gaming",
    name: "Solana Gaming & NFT",
    ticker: "PLAY",
    description:
      "A reserve tracking Solana's gaming and NFT-adjacent tokens. Speculative and narrative-driven -- built for holders chasing the next consumer wave.",
    category: "Gaming",
    nav: 3.21,
    premiumPct: 2.9,
    aum: 4_150_000,
    change24h: 7.2,
    change7d: -6.5,
    holders: 972,
    composition: [
      { symbol: "ATLAS", name: "Star Atlas", weight: 0.3 },
      { symbol: "GARI", name: "Gari Network", weight: 0.2 },
      { symbol: "AURORY", name: "Aurory", weight: 0.2 },
      { symbol: "SOL", name: "Solana", weight: 0.2 },
      { symbol: "USDC", name: "USD Coin", weight: 0.1 },
    ],
  },
];

function fictionalAddress(seedKey: string): string {
  const rand = mulberry32(hashSeed(seedKey));
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 44; i++) {
    out += chars[Math.floor(rand() * chars.length)];
  }
  return out;
}

function defaultFeeConfig(managerAddress: string): FeeConfig {
  return {
    mintFeeBps: DEFAULT_MINT_FEE_BPS,
    tvlFeeBps: DEFAULT_TVL_FEE_BPS,
    managerTaxBps: DEFAULT_MANAGER_TAX_BPS,
    creatorFeeDestination: managerAddress,
    feeRecipients: [],
  };
}

/** Predefined category suggestions, plus any custom categories already in use across the catalog. */
export const CATEGORY_SUGGESTIONS = [
  "Blue Chip",
  "DeFi",
  "Meme",
  "Infrastructure",
  "Gaming",
  "Strategic",
  "Stablecoin",
  "AI",
  "DePIN",
  "RWA",
  "NFT",
  "Layer 2",
  "Custom",
];

export const DTRS: DTR[] = DTR_SEEDS.map((seed) => {
  const tokenPrice = seed.nav * (1 + seed.premiumPct / 100);
  const managerAddress = fictionalAddress(`${seed.id}-manager`);
  return {
    id: seed.id,
    name: seed.name,
    ticker: seed.ticker,
    description: seed.description,
    category: seed.category,
    tags: [seed.category],
    logoSeed: seed.id,
    logoUrl: DTR_LOGOS[seed.id],
    dtrAddress: fictionalAddress(`${seed.id}-dtr`),
    managerAddress,
    delegates: [],
    feeConfig: defaultFeeConfig(managerAddress),
    tokenPrice,
    nav: seed.nav,
    aum: seed.aum,
    change24h: seed.change24h,
    change7d: seed.change7d,
    holders: seed.holders,
    composition: seed.composition,
    unallocatedPct: 0,
    isUserCreated: false,
    priceHistory: buildPriceHistory(seed.id, tokenPrice),
  };
});

export function getDtrById(id: string): DTR | undefined {
  return DTRS.find((d) => d.id === id);
}

export function searchDtrs(query: string): DTR[] {
  const q = query.trim().toLowerCase();
  if (!q) return DTRS;
  return DTRS.filter(
    (d) => d.name.toLowerCase().includes(q) || d.ticker.toLowerCase().includes(q),
  );
}

export const FEATURED_DTR_ID = "ssrres";
export const TRENDING_DTR_IDS = ["gaming", "meme", "blue"];
