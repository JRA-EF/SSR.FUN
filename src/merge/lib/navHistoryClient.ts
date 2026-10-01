// Browser-side client for /api/mainnet/reserve-nav-history -- the shared,
// server-recorded Reserve Token price history (lib/reserve-nav-history) that
// every visitor's Price History chart and 24h/7d/all-time performance are
// computed from on Mainnet. Fetched once per discovery pass (RealReserveSync)
// and once by the warm-cache first paint (ReserveSnapshotHydrator); merged
// UNDER the browser's own live points by calculations.ts's
// mergePriceHistories -- the server owns the past, the browser only extends
// it forward. Mainnet-only: DevNet has no recorder (fixture prices never
// move) and keeps its per-browser history exactly as before.
import type { PricePoint } from "./types";

/** How long one fetched history is reused across poll ticks (rpcResilience's getCached). The recorder adds at most one point per Reserve per minute and the endpoint is edge-cached ~30s, so re-fetching faster buys nothing; the live NAV between refreshes is appended client-side anyway. One shared key so ReserveSnapshotHydrator's first paint and RealReserveSync's first poll collapse into a single request. */
export const NAV_HISTORY_CACHE_KEY = "reserve-nav-history";
export const NAV_HISTORY_CACHE_TTL_MS = 60_000;

export interface ServerPriceHistory {
  /** Chronological, strictly-increasing-timestamp points; the first one may be the derived launch anchor (see the endpoint's header). */
  points: PricePoint[];
  /** Unix ms of the first genuinely RECORDED observation, or null when the recorder hasn't written this Reserve yet (only the anchor is served). */
  recordedFrom: number | null;
}

/**
 * Fetches every Reserve's server history, keyed by Reserve address.
 * Best-effort by design (same contract as fetchReserveEntryPrices): any
 * failure returns an empty map, so a history-service hiccup can only ever
 * leave the chart on its per-browser points, never fail a discovery pass.
 */
export async function fetchReserveNavHistory(origin: string): Promise<Record<string, ServerPriceHistory>> {
  try {
    const response = await fetch(`${origin}/api/mainnet/reserve-nav-history`, { credentials: "same-origin" });
    if (!response.ok) return {};
    const body = (await response.json().catch(() => null)) as { series?: Record<string, unknown> } | null;
    if (!body || typeof body.series !== "object" || body.series === null) return {};
    const result: Record<string, ServerPriceHistory> = {};
    for (const [reserve, raw] of Object.entries(body.series)) {
      if (typeof raw !== "object" || raw === null) continue;
      const { points, recordedFrom } = raw as { points?: unknown; recordedFrom?: unknown };
      if (!Array.isArray(points)) continue;
      const clean: PricePoint[] = [];
      for (const p of points) {
        const t = (p as { t?: unknown })?.t;
        const price = (p as { price?: unknown })?.price;
        if (typeof t !== "number" || !Number.isFinite(t)) continue;
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
        // Keep strictly increasing timestamps -- the chart's series contract.
        if (clean.length > 0 && t <= clean[clean.length - 1].t) continue;
        clean.push({ t, price });
      }
      if (clean.length === 0) continue;
      result[reserve] = { points: clean, recordedFrom: typeof recordedFrom === "number" && Number.isFinite(recordedFrom) ? recordedFrom : null };
    }
    return result;
  } catch {
    return {};
  }
}
