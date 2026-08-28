// Cluster targets for the Reserve Activity pipeline (/internal/kpis, the
// backfill sweep, and the nightly cron). The pipeline originally indexed
// DevNet only; the protocol has been live on Mainnet since 2026-08-19
// (DEC-0115), so "all protocol activity" now means BOTH clusters, with
// Mainnet first-class (DEC-0175).
//
// Each cluster is a self-contained target: its own RPC endpoint, program
// id, and candidate-mint strategy. Callers iterate targets and isolate
// failures per cluster -- one cluster's discovery failing (live 2026-08-28:
// the DevNet program's upgraded account layout no longer decodes with the
// SDK's deployed-Mainnet-shape IDL, "Invalid bool: 87") must never take
// down the other cluster's data or the whole KPIs page.
//
// RPC resolution deliberately mirrors api/devnet/_lib/rpc.ts and
// api/mainnet/_lib/rpc.ts (same env vars, same fallbacks) rather than
// importing them: those modules live under api/, and lib/ must not import
// api/ code (the dependency points the other way everywhere else in this
// repo). The two-line resolution logic is duplicated knowingly.
import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_FIXTURES, DEVUSDC_MINT, MAINNET_USDC_MINT, WRAPPED_SOL_MINT, enumerateReserveAssetMintsOnChain, type ActivityValuation, type AssetPricing, type DiscoveredReserve } from "@ssr/sdk";

export type ActivityCluster = "mainnet-beta" | "devnet";

/** Mainnet first: it is the live protocol and must never be starved of sweep budget by DevNet (whose discovery currently errors -- see module header). */
export const ACTIVITY_CLUSTERS: ActivityCluster[] = ["mainnet-beta", "devnet"];

export type ClusterFilter = ActivityCluster | "all";

/** Pure: validates a ?cluster= query value. Absent/empty means "mainnet-beta" -- the KPIs surface is Mainnet by default per the Creator's 2026-08-28 directive (DEC-0176); "all"/"devnet" remain available explicitly. Anything unrecognized is null (caller should 400). */
export function parseClusterFilter(value: unknown): ClusterFilter | null {
  if (value === undefined || value === null || value === "") return "mainnet-beta";
  if (value === "all" || value === "mainnet-beta" || value === "devnet") return value;
  return null;
}

/** Pure: the concrete cluster tags a filter selects, in sweep order. */
export function clustersForFilter(filter: ClusterFilter): ActivityCluster[] {
  return filter === "all" ? [...ACTIVITY_CLUSTERS] : [filter];
}

// The deployed Mainnet program -- same literal api/mainnet/landing-stats.ts
// pins (deployed 2026-08-19, DEC-0115; never a VITE_ env read on the server
// side, see landing-stats.ts's own comment).
export const MAINNET_PROGRAM_ID = "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9";

export interface ClusterTarget {
  cluster: ActivityCluster;
  connection: Connection;
  programId: PublicKey;
  /** Discovery hint mints -- resolved lazily because Mainnet's list needs a live chain scan. */
  candidateMints(): Promise<PublicKey[]>;
  /**
   * Per-Reserve USD valuation contexts from live discovery state + live
   * asset prices (DEC-0176) -- present only where a price source exists
   * (Mainnet with a fetchPricesUsd supplied). Best-effort: a pricing
   * failure yields null and events index unvalued rather than blocking.
   */
  buildValuations?(reserves: DiscoveredReserve[]): Promise<Map<string, ActivityValuation> | null>;
}

export interface ClusterTargetOptions {
  /** Live USD price source for Mainnet asset mints (the caller passes api/mainnet/asset-prices.ts's fetchJupiterPrices -- lib/ must not import api/). */
  fetchPricesUsd?(mints: string[]): Promise<Map<string, { usdPrice?: number | null }>>;
}

/**
 * Pure math over discovered state + fetched prices: per-Reserve
 * ActivityValuation. NAV per raw Reserve Token unit = (sum of vault
 * balances x asset USD price) / raw supply; null (never a guess) when
 * supply is zero, resolution is incomplete, or any resolved asset with a
 * real balance has no price -- a partial NAV would misstate every fee
 * valuation derived from it.
 */
export function computeReserveValuations(reserves: DiscoveredReserve[], priceByMint: Map<string, { usdPrice?: number | null }>): Map<string, ActivityValuation> {
  const pricing: Record<string, AssetPricing> = {};
  for (const r of reserves) {
    for (const a of r.assets) {
      if (pricing[a.assetMint]) continue;
      const fixed = a.assetMint === MAINNET_USDC_MINT ? 1 : undefined;
      const live = priceByMint.get(a.assetMint)?.usdPrice;
      pricing[a.assetMint] = { decimals: a.decimals, priceUsd: fixed ?? (Number.isFinite(live) && (live as number) > 0 ? (live as number) : 0) };
    }
  }
  const valuations = new Map<string, ActivityValuation>();
  for (const r of reserves) {
    let navUsdPerRtRawUnit: number | null = null;
    const supplyRaw = Number(r.reserveTokenSupplyRaw);
    if (supplyRaw > 0 && r.resolvedAssetCount === r.assetCount) {
      let tvlUsd = 0;
      let unpriced = false;
      for (const a of r.assets) {
        const p = pricing[a.assetMint];
        const balance = Number(a.vaultBalanceRaw);
        if (balance > 0 && (!p || p.priceUsd <= 0)) unpriced = true;
        if (p) tvlUsd += (balance / 10 ** p.decimals) * p.priceUsd;
      }
      if (!unpriced) navUsdPerRtRawUnit = tvlUsd / supplyRaw;
    }
    valuations.set(r.reserve, { pricing, navUsdPerRtRawUnit });
  }
  return valuations;
}

export function buildClusterTargets(clusters: ActivityCluster[], options: ClusterTargetOptions = {}): ClusterTarget[] {
  return clusters.map((cluster) => {
    if (cluster === "mainnet-beta") {
      const connection = new Connection(process.env.HELIUS_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
      return {
        cluster,
        connection,
        programId: new PublicKey(MAINNET_PROGRAM_ID),
        // Same strategy landing-stats.ts uses (DEC-0158): USDC plus every
        // mint any ReserveAsset account genuinely holds on-chain. The scan
        // failing degrades to USDC-only resolution (assetCount/status come
        // from the Reserve account itself either way), never to a throw.
        candidateMints: async () => {
          const known = await enumerateReserveAssetMintsOnChain(connection).catch(() => [] as string[]);
          return [new PublicKey(MAINNET_USDC_MINT), ...known.filter((m) => m !== MAINNET_USDC_MINT).map((m) => new PublicKey(m))];
        },
        buildValuations: options.fetchPricesUsd
          ? async (reserves) => {
              try {
                const mints = [...new Set(reserves.flatMap((r) => r.assets.map((a) => a.assetMint)))].filter((m) => m !== MAINNET_USDC_MINT);
                const prices = mints.length > 0 ? await options.fetchPricesUsd!(mints) : new Map<string, { usdPrice?: number | null }>();
                return computeReserveValuations(reserves, prices);
              } catch {
                return null;
              }
            }
          : undefined,
      };
    }
    const connection = new Connection(process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
    return {
      cluster,
      connection,
      programId: new PublicKey(DEVNET_FIXTURES.programId),
      // The fixed DevNet hint list every DevNet caller of discoverAllReserves
      // already uses (public DevNet RPC blocks the gPA scan -- see
      // enumerateReserveAssetMintsOnChain's doc comment).
      candidateMints: async () => [
        new PublicKey(DEVNET_FIXTURES.mints.mintX.address),
        new PublicKey(DEVNET_FIXTURES.mints.mintY.address),
        new PublicKey(DEVNET_FIXTURES.mints.mintZ.address),
        WRAPPED_SOL_MINT,
        DEVUSDC_MINT,
      ],
    };
  });
}
