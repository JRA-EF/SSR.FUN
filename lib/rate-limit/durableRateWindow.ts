// Durable, cross-instance fixed-window rate limiter.
//
// The check-and-increment is a SINGLE atomic SQL statement (INSERT ... ON
// CONFLICT ... RETURNING), so two requests racing on different serverless
// instances can never both read a stale count and both be admitted -- the row
// is locked for the duration of the upsert. This is the property the
// in-memory limiter fundamentally cannot provide across instances.
//
// FAIL-OPEN BY DESIGN: if the database is unreachable or errors, this returns
// `true` (allow). A rate limiter that fails CLOSED would take the whole
// feature down on a transient DB blip -- for sendTransaction that means users
// cannot trade. Availability wins; the ultimate backstop is always Helius's
// own API-key-scoped quota. Callers combine this with the cheap in-memory L1
// (see rpc-proxy), so even during a DB outage a per-instance limit still holds.

/** Minimal shape of the query function this module needs -- lets tests inject
 *  a fake without a live database. Matches @neondatabase/serverless's tagged
 *  template call signature loosely enough to accept the real client. */
export type RateLimitQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<{ count: number; window_start: number }>>

export interface DurableRateResult {
  allowed: boolean
  /** true when the verdict came from the database; false when it fell back
   *  (DB error) so the caller can apply its in-memory L1 instead. */
  durable: boolean
  count: number
}

/**
 * Atomically records one hit against `key` in a fixed `windowMs` window and
 * reports whether the window is still at or under `maxCount`.
 *
 * @returns allowed=true while count <= maxCount; durable=false only if the DB
 *          threw (then allowed is reported true and the caller should fall
 *          back to its in-memory check).
 */
export async function checkDurableRateWindow(
  sql: RateLimitQuery,
  key: string,
  windowMs: number,
  maxCount: number,
  now: number = Date.now(),
): Promise<DurableRateResult> {
  try {
    const rows = await sql`
      INSERT INTO rate_limit_window (key, window_start, count)
      VALUES (${key}, ${now}, 1)
      ON CONFLICT (key) DO UPDATE SET
        window_start = CASE
          WHEN ${now} - rate_limit_window.window_start >= ${windowMs}
          THEN ${now} ELSE rate_limit_window.window_start END,
        count = CASE
          WHEN ${now} - rate_limit_window.window_start >= ${windowMs}
          THEN 1 ELSE rate_limit_window.count + 1 END
      RETURNING count, window_start
    `
    const count = rows[0]?.count ?? 1
    return { allowed: count <= maxCount, durable: true, count }
  } catch {
    // DB unreachable/misconfigured -> fail open, signal non-durable so the
    // caller applies its in-memory L1 as the remaining line of defense.
    return { allowed: true, durable: false, count: 0 }
  }
}
