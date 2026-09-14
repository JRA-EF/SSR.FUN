// Lazy Neon client + queries for the Reserve NAV History store -- mirrors
// lib/reserve-warm-cache/db.ts exactly (same DATABASE_URL, same lazy-init
// rationale: importing this module must never throw at build/typecheck time
// before DATABASE_URL exists, since Vite/tsc evaluate top-level module code
// eagerly -- the error only surfaces when a request actually needs the
// database). Do NOT wrap in a Proxy.

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { bucketWidthSeconds, type NavPoint } from './navMath'

let _sql: NeonQueryFunction<false, false> | null = null

export function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not configured.')
    _sql = neon(url)
  }
  return _sql
}

/** Latest recorded point per Reserve -- what the recorder throttles against. */
export async function readLatestNavPoints(cluster: string): Promise<Map<string, NavPoint>> {
  const sql = getSql()
  const rows = (await sql`
    select distinct on (reserve) reserve, t, nav_usd
    from reserve_nav_history
    where cluster = ${cluster}
    order by reserve, t desc
  `) as { reserve: string; t: string; nav_usd: number }[]
  const out = new Map<string, NavPoint>()
  for (const r of rows) out.set(r.reserve, { t: new Date(r.t).getTime(), nav: r.nav_usd })
  return out
}

/** Appends one observation per Reserve in a single multi-row insert. */
export async function appendNavPoints(cluster: string, points: { reserve: string; t: number; nav: number }[]): Promise<void> {
  if (points.length === 0) return
  const sql = getSql()
  const reserves = points.map((p) => p.reserve)
  const times = points.map((p) => new Date(p.t).toISOString())
  const navs = points.map((p) => p.nav)
  await sql`
    insert into reserve_nav_history (cluster, reserve, t, nav_usd)
    select ${cluster}, r, t, n
    from unnest(${reserves}::text[], ${times}::timestamptz[], ${navs}::float8[]) as u(r, t, n)
  `
}

export interface ReserveNavSeries {
  reserve: string
  points: NavPoint[]
  /** Time of the first genuinely recorded observation (before it, nothing was recorded). */
  recordedFrom: number
}

/**
 * Every Reserve's recorded series, downsampled server-side to at most
 * `maxPointsPerReserve` points each (time-bucketed, keeping the LAST
 * observation in each bucket so the newest point is always exact). Bucket
 * width scales with each Reserve's own span, so a young Reserve keeps full
 * resolution and an old one stays a bounded payload.
 */
export async function readNavSeries(cluster: string, maxPointsPerReserve: number): Promise<ReserveNavSeries[]> {
  const sql = getSql()
  const summary = (await sql`
    select reserve, min(t) as t0, max(t) as t1, count(*)::int as n
    from reserve_nav_history
    where cluster = ${cluster}
    group by reserve
  `) as { reserve: string; t0: string; t1: string; n: number }[]

  const out: ReserveNavSeries[] = []
  for (const s of summary) {
    const t0 = new Date(s.t0).getTime()
    const t1 = new Date(s.t1).getTime()
    let rows: { t: string; nav_usd: number }[]
    if (s.n <= maxPointsPerReserve) {
      rows = (await sql`
        select t, nav_usd from reserve_nav_history
        where cluster = ${cluster} and reserve = ${s.reserve}
        order by t
      `) as { t: string; nav_usd: number }[]
    } else {
      const width = bucketWidthSeconds(t1 - t0, maxPointsPerReserve)
      rows = (await sql`
        select max(t) as t, (array_agg(nav_usd order by t desc))[1] as nav_usd
        from reserve_nav_history
        where cluster = ${cluster} and reserve = ${s.reserve}
        group by floor(extract(epoch from t) / ${width})
        order by max(t)
      `) as { t: string; nav_usd: number }[]
    }
    out.push({
      reserve: s.reserve,
      recordedFrom: t0,
      points: rows.map((r) => ({ t: new Date(r.t).getTime(), nav: r.nav_usd })),
    })
  }
  return out
}
