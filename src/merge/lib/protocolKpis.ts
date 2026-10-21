/**
 * Homepage protocol KPIs that combine SSR's own market with DEX pools
 * (DEC-0254). The backend reports each part separately; only these helpers
 * add them together for display.
 */

export interface PoolReserves {
  pooledTokensRaw: string;
  poolUsdcRaw: string;
}

/**
 * Market cap of one Reserve: tokens outside its SSR pool at NAV, plus tokens
 * inside the pool at the pool's price. In a constant-product pool the pooled
 * tokens at the pool price are worth exactly the pool's USDC, so that part is
 * the USDC side. No token is counted twice.
 */
export function splitMarketCap(supplyRaw: string, nav: number, pool: PoolReserves | undefined, decimals = 6): { navCapUsd: number; poolCapUsd: number } {
  const supply = BigInt(supplyRaw || "0");
  let pooled = pool ? BigInt(pool.pooledTokensRaw) : 0n;
  if (pooled > supply) pooled = supply;
  const outside = Number(supply - pooled) / 10 ** decimals;
  const navCapUsd = nav > 0 ? outside * nav : 0;
  const poolCapUsd = pooled > 0n && pool ? Number(BigInt(pool.poolUsdcRaw)) / 1e6 : 0;
  return { navCapUsd, poolCapUsd };
}

/** All-time volume shown on the homepage: SSR mint/redeem plus DEX swaps. null only when the mint/redeem figure itself is unavailable. */
export function combinedAllTimeVolume(mintRedeemUsd: number | null | undefined, dexUsd: number | null | undefined): number | null {
  if (mintRedeemUsd == null) return null;
  return mintRedeemUsd + (dexUsd ?? 0);
}
