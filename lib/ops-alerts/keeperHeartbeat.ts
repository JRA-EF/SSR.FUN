// DEC-0270: keeper heartbeat. The fee keeper writes one row per site at the end
// of every run it completes; api/mainnet/keeper-watchdog.ts (its own function,
// every 15 minutes) pages the team when that row goes stale. A keeper that
// crashes on load, times out, or throws never writes it -- exactly the case
// that sent no alert on 2026-10-28 (the 12:15 run died loading a module).
import type { NeonQueryFunction } from "@neondatabase/serverless";

type Sql = NeonQueryFunction<false, false>;

/** A keeper run older than this is a missed run (the cron is hourly at :15). */
export const KEEPER_STALE_AFTER_MINUTES = 75;

export async function ensureKeeperHeartbeatTable(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS keeper_heartbeat (
    site text PRIMARY KEY, last_ok_at timestamptz NOT NULL DEFAULT now(), summary text)`;
}

/** Keeper side: record a completed run. */
export async function writeKeeperHeartbeat(sql: Sql, site: string, summary: string): Promise<void> {
  await ensureKeeperHeartbeatTable(sql);
  await sql`INSERT INTO keeper_heartbeat (site, last_ok_at, summary) VALUES (${site}, now(), ${summary})
    ON CONFLICT (site) DO UPDATE SET last_ok_at = now(), summary = excluded.summary`;
}

/**
 * Watchdog side: the last completed run for this site. A site with no row yet
 * gets one dated now, so a keeper that has never once completed here is still
 * reported once the stale window passes.
 */
export async function readKeeperHeartbeat(sql: Sql, site: string): Promise<{ lastOkAt: Date; summary: string | null }> {
  await ensureKeeperHeartbeatTable(sql);
  await sql`INSERT INTO keeper_heartbeat (site, summary) VALUES (${site}, 'watchdog started') ON CONFLICT (site) DO NOTHING`;
  const [row] = (await sql`SELECT last_ok_at, summary FROM keeper_heartbeat WHERE site = ${site}`) as { last_ok_at: string | Date; summary: string | null }[];
  return { lastOkAt: new Date(row.last_ok_at), summary: row.summary };
}

/** Pure: minutes since the last completed run, when that is past the stale window; null when fresh. */
export function keeperStaleMinutes(lastOkAt: Date, now: Date): number | null {
  const minutes = Math.floor((now.getTime() - lastOkAt.getTime()) / 60_000);
  return minutes > KEEPER_STALE_AFTER_MINUTES ? minutes : null;
}
