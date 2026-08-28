// Protocol-wide KPI aggregation for /internal/kpis, built on top of
// reserve_activity_log's structured amount_raw/amount_kind columns (see
// schema.sql's comment on this migration and activityLog.ts's
// ActivityAmountKind). Two halves, deliberately split:
//   - Pure, offline-testable bucketing/formatting helpers (below), covered
//     by tests/phase_kpis.ts -- no DB, no RPC.
//   - computeProtocolKpis, which runs the real SQL against Postgres and
//     joins in one piece of live on-chain state (per-Reserve assetCount,
//     for the monthly-avg-assets metric, which the log alone can't answer
//     since assetCount is current state, not an emitted amount).
import { getSql } from "./db";
import { ACTIVITY_CLUSTERS, type ActivityCluster } from "./clusters";

/** "YYYY-MM" in UTC from a Unix-seconds timestamp -- stable, sortable, no locale/timezone ambiguity. */
export function monthKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 7);
}

/** "YYYY-MM-DD" in UTC from a Unix-seconds timestamp. */
export function dayKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** BigInt-safe sum of decimal-string amounts -- never a JS `number` intermediate (see activityLog.ts's addBig for why). */
export function sumBigStrings(vals: (string | null | undefined)[]): string {
  return vals.reduce((sum: bigint, v) => sum + BigInt(v && v.length > 0 ? v : "0"), 0n).toString();
}

export interface ReservesCreatedByMonth {
  month: string;
  count: number;
  cumulative: number;
}

/** Pure: buckets a list of reserveCreated event timestamps into per-month counts plus a running cumulative total, sorted chronologically. */
export function bucketReservesCreatedByMonth(creationTimestamps: number[]): ReservesCreatedByMonth[] {
  const counts = new Map<string, number>();
  for (const ts of creationTimestamps) counts.set(monthKey(ts), (counts.get(monthKey(ts)) ?? 0) + 1);
  const months = [...counts.keys()].sort();
  let cumulative = 0;
  return months.map((month) => {
    const count = counts.get(month) ?? 0;
    cumulative += count;
    return { month, count, cumulative };
  });
}

export interface MonthlyAvgAssets {
  month: string;
  avgAssetCount: number;
  reserveCount: number;
}

/**
 * Pure: for each month, the average CURRENT assetCount (composition
 * breadth) across every Reserve created that month. Deliberately joins
 * live discovery state (assetCount) with historical creation timestamps
 * from the log, rather than trying to reconstruct historical composition
 * changes -- "how many assets does a Reserve created in month X end up
 * with" is the honest, answerable question here, not "how many assets did
 * it have on day one" (composition can change after creation via Phase F/G
 * add/remove-asset actions, which this metric doesn't attempt to unwind).
 * A Reserve with no matching live assetCount (e.g. discovery excluded it)
 * is silently skipped, never counted as 0.
 */
export function computeMonthlyAvgAssets(creationEvents: { reserve: string; ts: number }[], liveAssetCounts: Map<string, number>): MonthlyAvgAssets[] {
  const byMonth = new Map<string, number[]>();
  for (const { reserve, ts } of creationEvents) {
    const count = liveAssetCounts.get(reserve);
    if (count === undefined) continue;
    const month = monthKey(ts);
    const list = byMonth.get(month) ?? [];
    list.push(count);
    byMonth.set(month, list);
  }
  return [...byMonth.keys()]
    .sort()
    .map((month) => {
      const list = byMonth.get(month) ?? [];
      const avg = list.reduce((s, v) => s + v, 0) / list.length;
      return { month, avgAssetCount: Math.round(avg * 100) / 100, reserveCount: list.length };
    });
}

/** RFC 4180-ish CSV field escaping: wraps in quotes and doubles any embedded quote whenever the field contains a comma, quote, or newline. */
export function csvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: (string | number | null | undefined)[]): string {
  return fields.map(csvField).join(",") + "\r\n";
}

export interface ProtocolKpiTotals {
  reservesDiscovered: number;
  totalMintVolumeRaw: string;
  totalRedeemVolumeRaw: string;
  totalProtocolFeeRaw: string;
  totalManagerFeeRaw: string;
  totalManagerFeeClaimedRaw: string;
}

export interface ProtocolKpis {
  generatedAt: string;
  totals: ProtocolKpiTotals;
  lifecycleCounts: { status: string; count: number }[];
  reservesCreatedByMonth: ReservesCreatedByMonth[];
  dailyVolume: { day: string; mintVolumeRaw: string; redeemVolumeRaw: string }[];
  monthlyFees: { month: string; protocolFeeRaw: string; managerFeeRaw: string }[];
  monthlyAvgAssetsPerReserve: MonthlyAvgAssets[];
  topReservesByVolume: { reserve: string; totalVolumeRaw: string }[];
  eventKindCounts: { kind: string; count: number }[];
  backfillStatus: { reservesFullyBackfilled: number; reservesStillIncomplete: number };
}

/**
 * Live-discovery lifecycle status + assetCount, passed in rather than
 * fetched here so the one discoverAllReserves() call this endpoint needs
 * (also used by backfillAll.ts) is made exactly once per request, not
 * duplicated across this module and its caller.
 */
export interface LiveReserveState {
  reserve: string;
  status: string;
  assetCount: number;
}

/**
 * `clusters` scopes every SQL aggregate to rows indexed from those clusters
 * (DEC-0175); callers pass the result of clustersForFilter. Live reserve
 * state is the caller's responsibility to pre-filter the same way (kpis.ts
 * the endpoint only discovers the selected clusters in the first place).
 */
export async function computeProtocolKpis(liveReserves: LiveReserveState[], clusters: ActivityCluster[] = [...ACTIVITY_CLUSTERS]): Promise<ProtocolKpis> {
  const sql = getSql();

  const lifecycleMap = new Map<string, number>();
  for (const r of liveReserves) lifecycleMap.set(r.status, (lifecycleMap.get(r.status) ?? 0) + 1);
  const lifecycleCounts = [...lifecycleMap.entries()].map(([status, count]) => ({ status, count }));

  const [dailyVolumeRows, monthlyFeeRows, eventKindRows, topReserveRows, creationRows, cursorRows] = await Promise.all([
    sql`
      select
        to_char(to_timestamp(ts), 'YYYY-MM-DD') as day,
        coalesce(sum(amount_raw::numeric) filter (where amount_kind = 'mintVolume'), 0)::text as mint_volume,
        coalesce(sum(amount_raw::numeric) filter (where amount_kind = 'redeemVolume'), 0)::text as redeem_volume
      from reserve_activity_log
      where amount_kind in ('mintVolume', 'redeemVolume') and cluster = any(${clusters})
      group by 1 order by 1
    `,
    sql`
      with amounts as (
        select ts, amount_kind as k, amount_raw::numeric as v from reserve_activity_log where amount_kind in ('protocolFee', 'managerFee') and cluster = any(${clusters})
        union all
        select ts, amount_kind_2 as k, amount_raw_2::numeric as v from reserve_activity_log where amount_kind_2 in ('protocolFee', 'managerFee') and cluster = any(${clusters})
      )
      select
        to_char(to_timestamp(ts), 'YYYY-MM') as month,
        coalesce(sum(v) filter (where k = 'protocolFee'), 0)::text as protocol_fee,
        coalesce(sum(v) filter (where k = 'managerFee'), 0)::text as manager_fee
      from amounts
      group by 1 order by 1
    `,
    sql`select kind, count(*)::int as count from reserve_activity_log where cluster = any(${clusters}) group by 1 order by 2 desc`,
    sql`
      select reserve, sum(amount_raw::numeric)::text as total_volume
      from reserve_activity_log
      where amount_kind in ('mintVolume', 'redeemVolume') and cluster = any(${clusters})
      group by reserve
      order by sum(amount_raw::numeric) desc nulls last
      limit 10
    `,
    sql`select reserve, ts from reserve_activity_log where kind = 'reserveCreated' and cluster = any(${clusters}) order by ts`,
    sql`select count(*) filter (where backfill_complete) as complete, count(*) filter (where not backfill_complete) as incomplete from reserve_activity_cursor where cluster = any(${clusters})`,
  ]);

  const totalsRow = (
    await sql`
      with amounts as (
        select amount_kind as k, amount_raw::numeric as v from reserve_activity_log where amount_kind is not null and cluster = any(${clusters})
        union all
        select amount_kind_2 as k, amount_raw_2::numeric as v from reserve_activity_log where amount_kind_2 is not null and cluster = any(${clusters})
      )
      select
        coalesce(sum(v) filter (where k = 'mintVolume'), 0)::text as mint_volume,
        coalesce(sum(v) filter (where k = 'redeemVolume'), 0)::text as redeem_volume,
        coalesce(sum(v) filter (where k = 'protocolFee'), 0)::text as protocol_fee,
        coalesce(sum(v) filter (where k = 'managerFee'), 0)::text as manager_fee,
        coalesce(sum(v) filter (where k = 'managerFeeClaimed'), 0)::text as manager_fee_claimed
      from amounts
    `
  )[0] as { mint_volume: string; redeem_volume: string; protocol_fee: string; manager_fee: string; manager_fee_claimed: string };

  const liveAssetCounts = new Map(liveReserves.map((r) => [r.reserve, r.assetCount]));
  const creationEvents = (creationRows as { reserve: string; ts: number }[]).map((r) => ({ reserve: r.reserve, ts: Number(r.ts) }));

  const cursor = cursorRows[0] as { complete: string | number; incomplete: string | number } | undefined;

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      reservesDiscovered: liveReserves.length,
      totalMintVolumeRaw: totalsRow?.mint_volume ?? "0",
      totalRedeemVolumeRaw: totalsRow?.redeem_volume ?? "0",
      totalProtocolFeeRaw: totalsRow?.protocol_fee ?? "0",
      totalManagerFeeRaw: totalsRow?.manager_fee ?? "0",
      totalManagerFeeClaimedRaw: totalsRow?.manager_fee_claimed ?? "0",
    },
    lifecycleCounts,
    reservesCreatedByMonth: bucketReservesCreatedByMonth(creationEvents.map((e) => e.ts)),
    dailyVolume: (dailyVolumeRows as { day: string; mint_volume: string; redeem_volume: string }[]).map((r) => ({
      day: r.day,
      mintVolumeRaw: r.mint_volume,
      redeemVolumeRaw: r.redeem_volume,
    })),
    monthlyFees: (monthlyFeeRows as { month: string; protocol_fee: string; manager_fee: string }[]).map((r) => ({
      month: r.month,
      protocolFeeRaw: r.protocol_fee,
      managerFeeRaw: r.manager_fee,
    })),
    monthlyAvgAssetsPerReserve: computeMonthlyAvgAssets(creationEvents, liveAssetCounts),
    topReservesByVolume: (topReserveRows as { reserve: string; total_volume: string }[]).map((r) => ({ reserve: r.reserve, totalVolumeRaw: r.total_volume })),
    eventKindCounts: (eventKindRows as { kind: string; count: number }[]).map((r) => ({ kind: r.kind, count: r.count })),
    backfillStatus: {
      reservesFullyBackfilled: Number(cursor?.complete ?? 0),
      reservesStillIncomplete: Number(cursor?.incomplete ?? 0),
    },
  };
}

/** Streams the FULL raw activity log as CSV -- every indexed event, every column -- the "one big file" export. Ordered oldest-first so a re-export is stably diffable. */
export async function* streamActivityLogCsv(): AsyncGenerator<string> {
  const sql = getSql();
  yield csvRow(["reserve", "cluster", "signature", "kind", "ts", "iso_time", "actor", "summary", "amount_raw", "amount_kind", "amount_raw_2", "amount_kind_2"]);
  const pageSize = 5000;
  let offset = 0;
  for (;;) {
    const rows = (await sql`
      select reserve, cluster, signature, kind, ts, actor, summary, amount_raw, amount_kind, amount_raw_2, amount_kind_2
      from reserve_activity_log
      order by ts asc, id asc
      limit ${pageSize} offset ${offset}
    `) as {
      reserve: string;
      cluster: string;
      signature: string;
      kind: string;
      ts: number;
      actor: string | null;
      summary: string;
      amount_raw: string | null;
      amount_kind: string | null;
      amount_raw_2: string | null;
      amount_kind_2: string | null;
    }[];
    if (rows.length === 0) break;
    for (const r of rows) {
      yield csvRow([r.reserve, r.cluster, r.signature, r.kind, r.ts, new Date(Number(r.ts) * 1000).toISOString(), r.actor, r.summary, r.amount_raw, r.amount_kind, r.amount_raw_2, r.amount_kind_2]);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
}
