// Postgres-touching query layer for ledger_events exports and daily
// totals. Deterministic sort order everywhere (slot, signature,
// instruction_index, event_index) -- requirement 5's "deterministic
// sorting" -- so the same query run twice against unchanged data always
// returns rows in the same order, and a diff between two exports is
// meaningful.
import { getSql } from "./db";
import { LEDGER_EVENT_CSV_COLUMNS, ledgerEventCsvHeader, ledgerEventToCsvRow, type LedgerEventCsvRow } from "./csv";

const PAGE_SIZE = 5000;

const SELECT_COLUMNS = LEDGER_EVENT_CSV_COLUMNS.join(", ");
const SORT_CLAUSE = "order by slot asc nulls last, signature asc nulls last, instruction_index asc nulls last, event_index asc nulls last, id asc";

/** Streams every ledger_events row for one exact UTC calendar date, for one cluster, as CSV -- requirement 5's "filtering by exact UTC date" + "daily CSV export". */
export async function* streamLedgerEventsCsvForDate(cluster: string, dateUtc: string): AsyncGenerator<string> {
  yield ledgerEventCsvHeader();
  const sql = getSql();
  let offset = 0;
  for (;;) {
    const rows = (await sql.query(
      `select ${SELECT_COLUMNS} from ledger_events where cluster = $1 and event_date_utc = $2 ${SORT_CLAUSE} limit $3 offset $4`,
      [cluster, dateUtc, PAGE_SIZE, offset],
    )) as unknown as LedgerEventCsvRow[];
    if (rows.length === 0) break;
    for (const r of rows) yield ledgerEventToCsvRow(r);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

/** Streams every ledger_events row in an inclusive UTC date range, for one cluster, as CSV -- requirement 5's "date ranges". */
export async function* streamLedgerEventsCsvForRange(cluster: string, fromDateUtc: string, toDateUtc: string): AsyncGenerator<string> {
  yield ledgerEventCsvHeader();
  const sql = getSql();
  let offset = 0;
  for (;;) {
    const rows = (await sql.query(
      `select ${SELECT_COLUMNS} from ledger_events where cluster = $1 and event_date_utc >= $2 and event_date_utc <= $3 ${SORT_CLAUSE} limit $4 offset $5`,
      [cluster, fromDateUtc, toDateUtc, PAGE_SIZE, offset],
    )) as unknown as LedgerEventCsvRow[];
    if (rows.length === 0) break;
    for (const r of rows) yield ledgerEventToCsvRow(r);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

/** Streams the COMPLETE historical export for one cluster -- requirement 5's "complete historical CSV export". No date filter, same deterministic sort, same paginated streaming (never one giant query result held in memory). */
export async function* streamLedgerEventsCsvComplete(cluster: string): AsyncGenerator<string> {
  yield ledgerEventCsvHeader();
  const sql = getSql();
  let offset = 0;
  for (;;) {
    const rows = (await sql.query(`select ${SELECT_COLUMNS} from ledger_events where cluster = $1 ${SORT_CLAUSE} limit $2 offset $3`, [cluster, PAGE_SIZE, offset])) as unknown as LedgerEventCsvRow[];
    if (rows.length === 0) break;
    for (const r of rows) yield ledgerEventToCsvRow(r);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

export interface DailyTotals {
  dateUtc: string;
  txCount: number;
  txFailedCount: number;
  mintVolumeRaw: string;
  redeemVolumeRaw: string;
  protocolFeeRaw: string;
  managerFeeRaw: string;
  uniqueActors: number;
}

/** Requirement 5's "daily totals and reconciliation" -- computed on demand from ledger_events (never a separately-drifting stored duplicate for THIS purpose; ledger_daily_rollups exists for point-in-time-locked history instead, see schema.sql's comment on why both exist). */
export async function getDailyTotals(cluster: string, dateUtc: string): Promise<DailyTotals> {
  const sql = getSql();
  const [row] = await sql`
    with amounts as (
      select amount_kind as k, amount_raw::numeric as v from ledger_events
      where cluster = ${cluster} and event_date_utc = ${dateUtc} and amount_kind is not null
    )
    select
      (select count(*) from ledger_events where cluster = ${cluster} and event_date_utc = ${dateUtc})::int as tx_count,
      (select count(*) from ledger_events where cluster = ${cluster} and event_date_utc = ${dateUtc} and status = 'failed')::int as tx_failed_count,
      (select count(distinct actor_wallet) from ledger_events where cluster = ${cluster} and event_date_utc = ${dateUtc} and actor_wallet is not null)::int as unique_actors,
      coalesce((select sum(v) from amounts where k = 'mintVolume'), 0)::text as mint_volume_raw,
      coalesce((select sum(v) from amounts where k = 'redeemVolume'), 0)::text as redeem_volume_raw,
      coalesce((select sum(v) from amounts where k = 'protocolFee'), 0)::text as protocol_fee_raw,
      coalesce((select sum(v) from amounts where k = 'managerFee'), 0)::text as manager_fee_raw
  `;
  const r = row as { tx_count: number; tx_failed_count: number; unique_actors: number; mint_volume_raw: string; redeem_volume_raw: string; protocol_fee_raw: string; manager_fee_raw: string };
  return {
    dateUtc,
    txCount: r.tx_count,
    txFailedCount: r.tx_failed_count,
    mintVolumeRaw: r.mint_volume_raw,
    redeemVolumeRaw: r.redeem_volume_raw,
    protocolFeeRaw: r.protocol_fee_raw,
    managerFeeRaw: r.manager_fee_raw,
    uniqueActors: r.unique_actors,
  };
}
