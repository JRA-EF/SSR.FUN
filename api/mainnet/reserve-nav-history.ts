// GET /api/mainnet/reserve-nav-history -- the shared, server-side Reserve
// Token price history behind every Price History chart and every
// 24h/7d/all-time performance figure on Mainnet (docs/project/DECISION_LOG.md's
// entry for this pass). Serves, per displayable Reserve:
//
//   { series: { <reserve>: { points: [{ t, price }], recordedFrom } }, generatedAt }
//
// `points` is the Reserve's recorded NAV series (lib/reserve-nav-history --
// appended by api/mainnet/warm-cache-cron.ts every ~15s, downsampled here to
// a bounded payload), PREFIXED by a single derived LAUNCH ANCHOR when the
// anchor predates the first recorded point: the Reserve's current holdings
// valued at their ENTRY prices (the Reserve Asset Entry Price Store, DEC-0172
// -- the same baseline the Composition table's per-asset P&L uses), stamped
// at the moment those entry prices were captured. That anchor is what makes
// "All-Time Performance" the value-weighted aggregate of the per-asset P&L
// rows, and what gives the "All" chart a genuine starting value instead of a
// flat line at today's NAV. `recordedFrom` (unix ms, or null when nothing has
// been recorded yet) tells the client where genuine recorded history begins,
// so it can disclose that the segment before it is a straight line from the
// launch value rather than recorded movement.
//
// Balances/supply for the anchor come from the warm-cache snapshot (the same
// row the homepage paints from), so this endpoint never touches RPC. The
// client (src/merge/lib/navHistoryClient.ts) merges this under its own live
// points -- server history is authoritative for the past, the browser only
// ever extends it forward.
import { readReserveSnapshot } from "../../lib/reserve-warm-cache/db";
import { readNavSeries } from "../../lib/reserve-nav-history/db";
import { getSql as getEntryPriceSql } from "../../lib/reserve-entry-price/db";
import { computeEntryNavUsd, withAnchor, type NavInputReserve, type NavPoint } from "../../lib/reserve-nav-history/navMath";

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

const CLUSTER = "mainnet-beta";
/** Per-Reserve cap on served points. The chart samples to 300 for drawing; 600 keeps 24h/7d change bases exact on a fresh Reserve while bounding an old one. */
const MAX_POINTS_PER_RESERVE = 600;

export interface ServedPricePoint {
  t: number;
  price: number;
}

export interface ServedReserveHistory {
  points: ServedPricePoint[];
  recordedFrom: number | null;
}

interface SnapshotReserveShape {
  reserve: string;
  assetCount: number;
  resolvedAssetCount: number;
  reserveTokenSupplyRaw: string;
  assets: { assetMint: string; vaultBalanceRaw: string; decimals: number }[];
}

/** Pure assembly of the served payload from its three inputs -- unit-tested in tests/phase_nav_history.ts. */
export function assembleNavHistory(
  recorded: { reserve: string; points: NavPoint[]; recordedFrom: number }[],
  snapshotReserves: NavInputReserve[],
  entryPrices: Map<string, { prices: Record<string, number>; capturedAt: number }>,
): Record<string, ServedReserveHistory> {
  const byReserve = new Map(recorded.map((r) => [r.reserve, r]));
  const out: Record<string, ServedReserveHistory> = {};
  const reserves = new Set<string>([...byReserve.keys(), ...snapshotReserves.map((r) => r.reserve)]);
  const snapshotByReserve = new Map(snapshotReserves.map((r) => [r.reserve, r]));
  for (const reserve of reserves) {
    const rec = byReserve.get(reserve);
    const snap = snapshotByReserve.get(reserve);
    const entry = entryPrices.get(reserve);
    let anchor: NavPoint | null = null;
    if (snap && entry) {
      const nav = computeEntryNavUsd(snap, entry.prices);
      if (nav !== null) anchor = { t: entry.capturedAt, nav };
    }
    const points = withAnchor(rec?.points ?? [], anchor);
    if (points.length === 0) continue;
    out[reserve] = {
      points: points.map((p) => ({ t: p.t, price: p.nav })),
      recordedFrom: rec ? rec.recordedFrom : null,
    };
  }
  return out;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const [recorded, snapshotRow] = await Promise.all([readNavSeries(CLUSTER, MAX_POINTS_PER_RESERVE), readReserveSnapshot(CLUSTER)]);
    const snapshot = snapshotRow?.snapshot && typeof snapshotRow.snapshot === "object" ? (snapshotRow.snapshot as { reserves?: SnapshotReserveShape[] }) : null;
    const snapshotReserves: NavInputReserve[] = Array.isArray(snapshot?.reserves)
      ? snapshot!.reserves.map((r) => ({
          reserve: r.reserve,
          assetCount: r.assetCount,
          resolvedAssetCount: r.resolvedAssetCount,
          reserveTokenSupplyRaw: r.reserveTokenSupplyRaw,
          assets: r.assets.map((a) => ({ assetMint: a.assetMint, vaultBalanceRaw: a.vaultBalanceRaw, decimals: a.decimals })),
        }))
      : [];

    // Entry prices + their capture time for every snapshot Reserve -- the
    // launch anchor's inputs. Best-effort: a read failure just means no
    // anchor this response (recorded points still serve), never a 503.
    const entryPrices = new Map<string, { prices: Record<string, number>; capturedAt: number }>();
    if (snapshotReserves.length > 0) {
      try {
        const sql = getEntryPriceSql();
        const rows = (await sql`
          select reserve, mint, entry_price_usd, captured_at
          from reserve_asset_entry_price
          where reserve = any(${snapshotReserves.map((r) => r.reserve)})
        `) as { reserve: string; mint: string; entry_price_usd: number; captured_at: string }[];
        for (const r of rows) {
          const capturedAt = new Date(r.captured_at).getTime();
          const cur = entryPrices.get(r.reserve) ?? { prices: {}, capturedAt };
          cur.prices[r.mint] = r.entry_price_usd;
          if (capturedAt < cur.capturedAt) cur.capturedAt = capturedAt;
          entryPrices.set(r.reserve, cur);
        }
      } catch (e) {
        console.error("api/mainnet/reserve-nav-history: entry-price read failed (non-fatal):", e);
      }
    }

    const series = assembleNavHistory(recorded, snapshotReserves, entryPrices);
    // Edge-cache briefly so a burst of detail-page loads shares one origin
    // read; the recorder only adds a point at most once a minute anyway.
    res.setHeader?.("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.status(200).json({ series, generatedAt: Date.now() });
  } catch (e) {
    console.error("api/mainnet/reserve-nav-history: read failed:", e);
    res.status(503).json({ error: "Reserve price history temporarily unavailable." });
  }
}
