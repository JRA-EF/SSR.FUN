// Lazy Neon client for the Reserve Warm Cache -- mirrors lib/reserve-image/db.ts
// exactly (same DATABASE_URL, same lazy-init rationale: importing this module
// must never throw at build/typecheck time before DATABASE_URL exists, since
// Vite/tsc evaluate top-level module code eagerly -- the error only surfaces
// when a request actually needs the database). Do NOT wrap in a Proxy.

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

let _sql: NeonQueryFunction<false, false> | null = null

export function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not configured.')
    _sql = neon(url)
  }
  return _sql
}

export interface ReserveSnapshotRow {
  /** The whole payload the snapshot endpoint serves verbatim (jsonb). */
  snapshot: unknown
  /** ISO timestamp of when the cron last wrote this row. */
  generatedAt: string
}

/** Read the latest snapshot for a cluster, or null if the cron hasn't run yet. */
export async function readReserveSnapshot(cluster: string): Promise<ReserveSnapshotRow | null> {
  const sql = getSql()
  const rows = (await sql`
    select snapshot, generated_at as "generatedAt"
    from reserve_snapshot
    where cluster = ${cluster}
    limit 1
  `) as { snapshot: unknown; generatedAt: string }[]
  return rows[0] ?? null
}

/**
 * Upsert the single per-cluster snapshot row. The value is parameterized and
 * cast to jsonb server-side, so an arbitrarily large payload never has to be
 * escaped by hand.
 */
export async function writeReserveSnapshot(cluster: string, snapshot: unknown): Promise<void> {
  const sql = getSql()
  await sql`
    insert into reserve_snapshot (cluster, snapshot, generated_at)
    values (${cluster}, ${JSON.stringify(snapshot)}::jsonb, now())
    on conflict (cluster) do update
      set snapshot = excluded.snapshot,
          generated_at = excluded.generated_at
  `
}
