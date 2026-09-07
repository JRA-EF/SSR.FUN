// Client for the backend WARM CACHE (api/mainnet/reserves-snapshot, refreshed
// every ~15s by api/mainnet/warm-cache-cron even with no users). On Mainnet the
// homepage/Discover page hydrates from this ONE cheap read the instant it
// mounts -- painting real Reserves immediately -- instead of waiting on the
// in-browser on-chain discovery burst (which was slow and self-inflicted the
// rpc-proxy 429s). RealReserveSync's normal poll still runs and REPLACES this
// seed with fully-live data (balances, delegates, holdings) a moment later; the
// snapshot is purely a fast first paint, never the source of truth.
//
// It reuses the EXACT same buildDtrFromDiscoveredReserve path RealReserveSync
// uses, fed from the snapshot's DiscoveredReserve[] + priceByMint +
// per-Reserve metadata, so the seeded DTRs are identical to what a live pass
// would produce (minus the supplementary delegate/holding data the poll fills).
import {
  buildDtrFromDiscoveredReserve,
  type AssetPriceInfo,
} from "./onChainReserve";
import type { DiscoveredReserve, ParsedReserveMetadata } from "@ssr/sdk";
import type { DTR } from "./types";
import { SOLANA_CLUSTER, SSR_PROGRAM_ID } from "./solana-config";

export interface ReserveSnapshot {
  reserves: DiscoveredReserve[];
  /** mint -> USD price (USDC is 1). Converted to AssetPriceInfo below. */
  priceByMint: Record<string, number>;
  /** reserveId -> resolved off-chain metadata (name/ticker/category/...), or null. */
  metadataByReserve: Record<string, ParsedReserveMetadata | null>;
  generatedAt: string | null;
  ageMs: number | null;
  warming?: boolean;
}

/** Fetch the warm snapshot. Returns null on any failure/empty so callers fall
 *  back cleanly to the live discovery pass -- never throws, never blocks.
 *  Retries a few times: the snapshot endpoint is a cheap DB read but can
 *  cold-start on a warm-cache serverless instance, and the whole point is to
 *  win the first paint, so a transient miss is worth a quick retry. Sends the
 *  site-gate cookie automatically (same-origin credentials). */
export async function fetchReserveSnapshot(origin: string): Promise<ReserveSnapshot | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${origin}/api/mainnet/reserves-snapshot`, { cache: "no-store", credentials: "same-origin" });
      if (res.ok) {
        const s = (await res.json()) as ReserveSnapshot;
        if (s && Array.isArray(s.reserves) && s.reserves.length > 0) return s;
      }
    } catch {
      // fall through to retry
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** Build the DTR[] the store renders from a snapshot, via the same builder the
 *  live poll uses. delegates/mintMeta/entryPrices are left empty here (the poll
 *  fills them); prices are converted from the flat USD map to AssetPriceInfo. */
export function buildDtrsFromSnapshot(snapshot: ReserveSnapshot, walletKey: string | null): DTR[] {
  const asOf = snapshot.generatedAt ? new Date(snapshot.generatedAt).getTime() : Date.now();
  const priceByMint: Record<string, AssetPriceInfo> = {};
  for (const [mint, price] of Object.entries(snapshot.priceByMint || {})) {
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      priceByMint[mint] = { usdPrice: price, source: "jupiter", lastUpdated: asOf };
    }
  }
  return snapshot.reserves.map((reserve) =>
    buildDtrFromDiscoveredReserve(
      reserve,
      [],
      walletKey,
      snapshot.metadataByReserve?.[reserve.reserveId] ?? null,
      SSR_PROGRAM_ID,
      SOLANA_CLUSTER,
      {},
      priceByMint,
      {},
    ),
  );
}
