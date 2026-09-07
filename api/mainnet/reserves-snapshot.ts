// GET /api/mainnet/reserves-snapshot -- serves the pre-computed, backend-warmed
// snapshot of the discoverable Mainnet Reserve set so the homepage/Discover
// page paints INSTANTLY from one cheap DB read, instead of each browser running
// the full on-chain discovery burst (the burst that self-inflicted the
// rpc-proxy 429s and left Discover showing "No Reserves launched yet" under
// load -- see ssr-review/08-DEPLOY-INCIDENTS). The snapshot is refreshed every
// ~15s even with zero users by api/mainnet/warm-cache-cron.ts.
//
// The payload is exactly what RealReserveSync feeds its EXISTING
// buildDtrFromDiscoveredReserve pipeline -- { reserves: DiscoveredReserve[],
// priceByMint, metadataByReserve } -- so the client builds identical DTRs with
// ZERO further RPC. `generatedAt`/`ageMs` let the client fall back to a live
// discovery pass if the snapshot is ever stale (cron wedged), never trusting it
// blindly.
import { readReserveSnapshot } from "../../lib/reserve-warm-cache/db";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const row = await readReserveSnapshot("mainnet-beta");
    if (!row) {
      // Cron hasn't populated the row yet (fresh deploy / DB just migrated).
      // 200 with warming:true so the client cleanly falls back to a live pass
      // rather than treating an empty list as "no reserves".
      res.status(200).json({ reserves: [], priceByMint: {}, metadataByReserve: {}, generatedAt: null, ageMs: null, warming: true });
      return;
    }
    const ageMs = Date.now() - new Date(row.generatedAt).getTime();
    // Edge-cache briefly so bursts of homepage loads share one origin read,
    // while stale-while-revalidate keeps it feeling instant during a refresh.
    if (res.setHeader) res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    const payload = (row.snapshot && typeof row.snapshot === "object") ? (row.snapshot as Record<string, unknown>) : {};
    res.status(200).json({ ...payload, generatedAt: row.generatedAt, ageMs });
  } catch (e) {
    // Sanitized -- never echo a raw driver exception. Full detail server-side.
    console.error("api/mainnet/reserves-snapshot: read failed:", e);
    res.status(503).json({ error: "Reserve snapshot temporarily unavailable." });
  }
}
