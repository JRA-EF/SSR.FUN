// Browser-side client for /api/mainnet/asset-prices -- the ONLY place this
// app reads a Reserve Asset's real USD price from on Mainnet (see
// api/mainnet/asset-prices.ts's header for the full Pyth/Jupiter hierarchy).
// DevNet never calls this: its fixture mints have no real market price by
// design, and onChainReserve.ts's TEST_ASSET_PRICES_USD (a fixed, clearly
// documented test table) remains its pricing source, unchanged by this
// module.
export interface AssetPriceInfo {
  usdPrice: number | null;
  source: "pyth" | "jupiter" | "unavailable";
  lastUpdated: number | null;
  deviationFlagged?: boolean;
  deviationPct?: number;
}

export interface PriceRequestAsset {
  mint: string;
  decimals: number;
}

/** Fetches validated USD prices for up to 30 mints in one batched request. Never throws for an individual unpriced mint -- callers get an honest {usdPrice: null, source: "unavailable"} entry for it, per-mint, rather than the whole call failing. Only throws on a genuine request-level failure (network error, non-2xx, malformed body). */
export async function fetchAssetPricesUsd(assets: PriceRequestAsset[]): Promise<Record<string, AssetPriceInfo>> {
  if (assets.length === 0) return {};
  const res = await fetch("/api/mainnet/asset-prices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assets }),
  });
  if (!res.ok) {
    throw new Error(`Mainnet asset pricing request failed (${res.status}).`);
  }
  const body = (await res.json()) as { prices?: Record<string, AssetPriceInfo> };
  return body.prices ?? {};
}
