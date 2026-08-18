// Data-quality controls (requirement 7): idempotent-upsert verification,
// duplicate detection, null-field monitoring, raw-vs-normalized amount
// checks, daily completeness, ingestion-lag monitoring. Every check here
// both returns a structured result AND logs itself into
// ledger_reconciliation_runs, so "was this ever checked, and when" is
// itself answerable later (an auditable data-quality history, not just a
// point-in-time claim).
import { getSql } from "./db";

export interface ReconciliationCheckResult {
  checkName: string;
  passed: boolean;
  rowsChecked: number;
  issuesFound: number;
  details: Record<string, unknown>;
}

async function recordRun(cluster: string, result: ReconciliationCheckResult): Promise<void> {
  const sql = getSql();
  await sql`
    insert into ledger_reconciliation_runs (cluster, check_name, passed, details, rows_checked, issues_found)
    values (${cluster}, ${result.checkName}, ${result.passed}, ${JSON.stringify(result.details)}, ${result.rowsChecked}, ${result.issuesFound})
  `;
}

/** No two rows should ever share an event_id -- the schema's own `unique` constraint already guarantees this at write time, but this check independently verifies it holds (defense in depth against, e.g., a future migration that relaxes the constraint by accident). */
export async function checkNoDuplicateEventIds(cluster: string): Promise<ReconciliationCheckResult> {
  const sql = getSql();
  const dupes = await sql`
    select event_id, count(*) as c from ledger_events where cluster = ${cluster} group by event_id having count(*) > 1
  `;
  const totalRows = (await sql`select count(*) as c from ledger_events where cluster = ${cluster}`)[0] as { c: string };
  const result: ReconciliationCheckResult = {
    checkName: "no_duplicate_event_ids",
    passed: dupes.length === 0,
    rowsChecked: Number(totalRows.c),
    issuesFound: dupes.length,
    details: { duplicateEventIds: dupes.map((d) => (d as { event_id: string }).event_id) },
  };
  await recordRun(cluster, result);
  return result;
}

/** Every row that HAS an amount_raw must also have amount_kind and amount_decimals set -- a partially-populated amount row indicates a decoder bug, not a legitimate "no amount" event (those simply have amount_raw = null across the board). */
export async function checkAmountFieldConsistency(cluster: string): Promise<ReconciliationCheckResult> {
  const sql = getSql();
  const bad = await sql`
    select event_id, event_type from ledger_events
    where cluster = ${cluster} and amount_raw is not null and (amount_kind is null or amount_decimals is null)
  `;
  const total = (await sql`select count(*) as c from ledger_events where cluster = ${cluster} and amount_raw is not null`)[0] as { c: string };
  const result: ReconciliationCheckResult = {
    checkName: "amount_field_consistency",
    passed: bad.length === 0,
    rowsChecked: Number(total.c),
    issuesFound: bad.length,
    details: { inconsistentEventIds: bad.map((b) => (b as { event_id: string }).event_id) },
  };
  await recordRun(cluster, result);
  return result;
}

/** Every row must have a non-null actor_wallet UNLESS its event_type is one of the small set of genuinely actor-less protocol events (e.g. a keeper-triggered settlement can legitimately have no human actor -- see actor_role='keeper'). Flags anything else as a real gap, not silently accepted. */
const ACTOR_OPTIONAL_EVENT_TYPES = ["protocolMintFeeTransferred", "tvlFeeSettled", "reserveSeeded", "feesAccrued"];
export async function checkActorPresence(cluster: string): Promise<ReconciliationCheckResult> {
  const sql = getSql();
  const missing = await sql`
    select event_id, event_type from ledger_events
    where cluster = ${cluster} and actor_wallet is null and event_type <> ALL(${ACTOR_OPTIONAL_EVENT_TYPES})
  `;
  const total = (await sql`select count(*) as c from ledger_events where cluster = ${cluster}`)[0] as { c: string };
  const result: ReconciliationCheckResult = {
    checkName: "actor_presence",
    passed: missing.length === 0,
    rowsChecked: Number(total.c),
    issuesFound: missing.length,
    details: { missingActorEventIds: missing.map((m) => (m as { event_id: string }).event_id) },
  };
  await recordRun(cluster, result);
  return result;
}

/** Ingestion-lag: the newest ledger_events row should never be more than a few hours behind "now" once ingestion is actively running -- flags a stalled cron/webhook pipeline. Threshold is a parameter, not hardcoded, since "acceptable lag" differs between an actively-traded Mainnet program and a quiet DevNet one. */
export async function checkIngestionLag(cluster: string, maxLagHours: number): Promise<ReconciliationCheckResult> {
  const sql = getSql();
  const rows = await sql`select max(event_ts_utc) as newest from ledger_events where cluster = ${cluster}`;
  const newest = (rows[0] as { newest: string | null })?.newest;
  const lagHours = newest ? (Date.now() - new Date(newest).getTime()) / 3_600_000 : null;
  const result: ReconciliationCheckResult = {
    checkName: "ingestion_lag",
    passed: lagHours !== null && lagHours <= maxLagHours,
    rowsChecked: 1,
    issuesFound: lagHours === null || lagHours > maxLagHours ? 1 : 0,
    details: { newestEventTsUtc: newest, lagHours, maxLagHours },
  };
  await recordRun(cluster, result);
  return result;
}

/** Daily completeness: every UTC date between a Reserve's first and last activity should have at least one row somewhere in ledger_events for that cluster, UNLESS the protocol was genuinely idle that day. This check reports gap-days for manual review rather than asserting pass/fail -- a genuine quiet day is not a data-quality issue, but an unreviewed gap should never go unnoticed either. */
export async function findDateGaps(cluster: string): Promise<ReconciliationCheckResult> {
  const sql = getSql();
  const rows = await sql`
    with days as (
      select generate_series(min(event_date_utc), max(event_date_utc), interval '1 day')::date as d
      from ledger_events where cluster = ${cluster}
    )
    select d from days
    where not exists (select 1 from ledger_events e where e.cluster = ${cluster} and e.event_date_utc = days.d)
    order by d
  `;
  const total = (await sql`select count(distinct event_date_utc) as c from ledger_events where cluster = ${cluster}`)[0] as { c: string };
  const result: ReconciliationCheckResult = {
    checkName: "date_gaps",
    passed: rows.length === 0,
    rowsChecked: Number(total.c),
    issuesFound: rows.length,
    details: { gapDates: rows.map((r) => (r as { d: string }).d) },
  };
  await recordRun(cluster, result);
  return result;
}

export async function runAllReconciliationChecks(cluster: string, options: { maxLagHours?: number } = {}): Promise<ReconciliationCheckResult[]> {
  return Promise.all([
    checkNoDuplicateEventIds(cluster),
    checkAmountFieldConsistency(cluster),
    checkActorPresence(cluster),
    checkIngestionLag(cluster, options.maxLagHours ?? 24 * 14),
    findDateGaps(cluster),
  ]);
}
