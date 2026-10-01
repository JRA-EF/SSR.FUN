// The Robinhood Chain asset catalogue's rules, kept pure (no RPC, no DB) so
// tests/phase_robinhood_catalogue.ts can exercise them offline. The job that
// applies them is lib/robinhood/catalogue.ts; the route that serves the
// result is api/robinhood/asset-catalogue.ts.
//
// WHAT THE CATALOGUE IS. Every token that actually trades on Robinhood Chain
// against one of the two quote assets (USDG, the cash leg, or WETH) in a
// Uniswap v3 pool with real depth -- discovered from the v3 factory's own
// PoolCreated logs, never from a hand-kept list. That is what makes a token
// usable as a Reserve asset here: the Launch flow buys it with the creator's
// USDG through that pool, and the reserve page marks it to USD from the same
// pool. It covers Robinhood's stock tokens AND the launchpad tokens that have
// graduated to Uniswap (Pons, Stonklauncher and the rest), because graduation
// is exactly "has a Uniswap pool with locked liquidity".
//
// WHAT "ROBINHOOD STOCK TOKEN" MEANS. Robinhood's stock tokens are all the
// same beacon proxy: 283 bytes of runtime code that embed the issuer's
// beacon, so every official token has the SAME code hash
// (OFFICIAL_STOCK_TOKEN_CODE_HASH, read live 2026-10-01 from AAPL, AMZN and
// AAOI). The name suffix "• Robinhood Token" is NOT proof: on 2026-10-01 the
// chain carried copycats with that exact name, 10,000,000 supply, a dust pool
// and no ERC-8056 multiplier (e.g. the "ARM" at 0x5f0e3d5d..., which the
// previous hand-generated list offered). A token that CLAIMS the name without
// the code is refused outright, not merely unlabelled.
import type { Address } from "viem";

/** Uniswap v3 on Robinhood Chain mainnet (developers.uniswap.org, v3 deployments, chain 4663). */
export const UNISWAP_V3_FACTORY: Address = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
export const UNISWAP_V3_FEES = [100, 500, 3000, 10000] as const;

export type QuoteSymbol = "USDG" | "WETH";
export interface QuoteAsset {
  symbol: QuoteSymbol;
  address: Address;
  decimals: number;
}
export const QUOTES: Record<QuoteSymbol, QuoteAsset> = {
  USDG: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
  WETH: { symbol: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18 },
};

/** keccak256 of the runtime code every official Robinhood stock token shares (a beacon proxy on OFFICIAL_STOCK_TOKEN_BEACON). */
export const OFFICIAL_STOCK_TOKEN_CODE_HASH = "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630";
/** The beacon that code points at -- Robinhood's upgradeable stock-token implementation. */
export const OFFICIAL_STOCK_TOKEN_BEACON: Address = "0xe10b6f6b275de231345c20d14ab812db62151b00";

/** The name pattern Robinhood's tokens carry -- and that copycats copy. */
export const ROBINHOOD_NAME_RE = /\s*[•·]\s*Robinhood Token\s*$/i;

/**
 * Minimum depth (USD value of the quote asset sitting in the token's deepest
 * pool) for a token that is NOT an official stock token to be offered. A
 * graduated launchpad token bonds a few thousand dollars of locked
 * liquidity; a dust pool is not a market a reserve can be seeded from.
 */
export const MIN_DEPTH_USD_FOR_OTHER_TOKENS = 1_000;

export type IssuerId = "robinhood";

export interface TokenFacts {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  /** keccak256 of the runtime code, or null when it was not read (only read for Robinhood-named tokens). */
  codeHash: string | null;
  /** USD value of the quote asset in the token's deepest pool, or null when no pool could be valued. */
  depthUsd: number | null;
}

export interface Classification {
  issuer: IssuerId | null;
  eligible: boolean;
  /** Plain-words reason when not eligible; null when eligible. Stored, never shown as a safety rating. */
  ineligibleReason: string | null;
  /** The issuer's display name with the "• Robinhood Token" suffix removed, e.g. "Apple". */
  displayName: string;
}

export function isRobinhoodNamed(name: string): boolean {
  return ROBINHOOD_NAME_RE.test(name);
}

export function stripRobinhoodSuffix(name: string): string {
  return name.replace(ROBINHOOD_NAME_RE, "").trim();
}

/**
 * Pure: issuer + eligibility for one token from on-chain facts.
 *
 *  - Official stock token (code hash matches): issuer "robinhood", always
 *    eligible -- Robinhood lists it, and a thin pool is a sizing problem the
 *    Launch quote catches, not a reason to hide the asset.
 *  - Robinhood-named but a different code: a copycat. Never eligible.
 *  - Anything else: eligible when its deepest pool holds at least
 *    MIN_DEPTH_USD_FOR_OTHER_TOKENS of the quote asset.
 *  - The quote assets themselves (USDG, WETH) are catalogue entries too, so
 *    a reserve can hold cash or ETH; they are always eligible.
 */
export function classifyToken(t: TokenFacts): Classification {
  const lower = t.address.toLowerCase();
  if (lower === QUOTES.USDG.address.toLowerCase()) return { issuer: null, eligible: true, ineligibleReason: null, displayName: "Global Dollar" };
  if (lower === QUOTES.WETH.address.toLowerCase()) return { issuer: null, eligible: true, ineligibleReason: null, displayName: "Wrapped Ether" };
  if (t.codeHash && t.codeHash.toLowerCase() === OFFICIAL_STOCK_TOKEN_CODE_HASH) {
    return { issuer: "robinhood", eligible: true, ineligibleReason: null, displayName: stripRobinhoodSuffix(t.name) || t.symbol };
  }
  if (isRobinhoodNamed(t.name)) {
    return {
      issuer: null,
      eligible: false,
      ineligibleReason: "named like a Robinhood stock token but not the official contract",
      displayName: stripRobinhoodSuffix(t.name) || t.symbol,
    };
  }
  if (t.depthUsd === null) return { issuer: null, eligible: false, ineligibleReason: "no pool could be valued", displayName: t.name || t.symbol };
  if (t.depthUsd < MIN_DEPTH_USD_FOR_OTHER_TOKENS) {
    return { issuer: null, eligible: false, ineligibleReason: `deepest pool holds under $${MIN_DEPTH_USD_FOR_OTHER_TOKENS} of USDG/WETH`, displayName: t.name || t.symbol };
  }
  return { issuer: null, eligible: true, ineligibleReason: null, displayName: t.name || t.symbol };
}

export interface PoolFacts {
  pool: Address;
  token: Address;
  quote: QuoteSymbol;
  fee: number;
  /** Quote-asset balance of the pool, human units. */
  quoteBalance: number;
  /** Uniswap liquidity() -- zero means nothing is in range. */
  liquidity: bigint;
  /** sqrtPriceX96 from slot0, or null if unreadable. */
  sqrtPriceX96: bigint | null;
}

/** Pure: the pool a token should be priced and bought through -- the one holding the most quote value, among pools with in-range liquidity. */
export function selectBestPool(pools: PoolFacts[], wethUsd: number | null): { pool: PoolFacts; depthUsd: number } | null {
  let best: { pool: PoolFacts; depthUsd: number } | null = null;
  for (const p of pools) {
    if (p.liquidity <= 0n) continue;
    const usd = p.quote === "USDG" ? p.quoteBalance : wethUsd === null ? null : p.quoteBalance * wethUsd;
    if (usd === null) continue;
    if (!best || usd > best.depthUsd) best = { pool: p, depthUsd: usd };
  }
  return best;
}

/**
 * Pure: the price of one whole token in the quote asset from a v3 pool's
 * sqrtPriceX96 (token1 per token0, adjusted for decimals). Mirrors
 * src/merge/lib/evmReserve.ts's v3Spot so the catalogue and the reserve
 * page mark identically.
 */
export function spotFromSqrtPrice(sqrtPriceX96: bigint, token: Address, tokenDecimals: number, quote: QuoteAsset): number | null {
  const tokenIs0 = token.toLowerCase() < quote.address.toLowerCase();
  const [dec0, dec1] = tokenIs0 ? [tokenDecimals, quote.decimals] : [quote.decimals, tokenDecimals];
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = ratio * ratio * 10 ** (dec0 - dec1);
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  return tokenIs0 ? p1per0 : 1 / p1per0;
}

/** The entry the API serves and the Launch form consumes. */
export interface RobinhoodCatalogueToken {
  address: Address;
  symbol: string;
  /** Display name: the issuer's company name for a stock token ("Apple"), the token's own name otherwise. */
  name: string;
  decimals: number;
  issuer: IssuerId | null;
  /** The pool the Launch flow buys through and the app prices from. Null only for USDG, which IS the cash leg and is deposited directly. */
  pool: { address: Address; fee: number; quote: QuoteSymbol } | null;
  /** USD value of the quote asset in that pool at the last refresh. */
  depthUsd: number | null;
  /** USD price of one whole token at the last refresh, or null. */
  priceUsd: number | null;
}

/**
 * Pure: drops tokens that borrow a reserved symbol -- a token calling itself
 * USDG or WETH that is not the real one, or a token calling itself AAPL that
 * is not the code-proven stock token. Found live 2026-10-01: a 0.0000056-USD
 * "USDG" sat above the real one in the picker. Two launchpad tokens sharing
 * a symbol between themselves are both kept (the picker shows name and
 * address); only reserved symbols are protected.
 */
export function dropSymbolImpersonators(tokens: RobinhoodCatalogueToken[]): RobinhoodCatalogueToken[] {
  const reserved = new Map<string, string>([
    ["USDG", QUOTES.USDG.address.toLowerCase()],
    ["WETH", QUOTES.WETH.address.toLowerCase()],
    ["ETH", QUOTES.WETH.address.toLowerCase()],
  ]);
  for (const t of tokens) if (t.issuer === "robinhood") reserved.set(t.symbol.toUpperCase(), t.address.toLowerCase());
  return tokens.filter((t) => {
    const owner = reserved.get(t.symbol.toUpperCase());
    return owner === undefined || owner === t.address.toLowerCase();
  });
}

/** Pure: the serving order -- the cash leg, then ETH, then stock tokens alphabetically, then everything else by depth. */
export function sortForPicker(tokens: RobinhoodCatalogueToken[]): RobinhoodCatalogueToken[] {
  const rank = (t: RobinhoodCatalogueToken) => (t.symbol === "USDG" ? 0 : t.symbol === "WETH" ? 1 : t.issuer === "robinhood" ? 2 : 3);
  return [...tokens].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 2) return a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address);
    return (b.depthUsd ?? 0) - (a.depthUsd ?? 0) || a.symbol.localeCompare(b.symbol);
  });
}
