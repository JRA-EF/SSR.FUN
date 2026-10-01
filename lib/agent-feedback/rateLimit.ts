// Rate limiting for the PUBLIC feedback endpoint (api/feedback/submit.ts).
// ESM-scoped twin of lib/rate-limit (which is a CommonJS scope and cannot be
// imported from here under verbatimModuleSyntax): the same in-memory burst
// window (rateLimitPure.ts) and the SAME durable `rate_limit_window` table /
// upsert as lib/rate-limit/durableRateWindow.ts, so the two never disagree.
import { getSql } from './db.js'

export { checkBurstWindow, rateLimitVerdict } from './rateLimitPure.js'

export interface DurableVerdict {
  allowed: boolean
  /** false when the database was unreachable (fail-open; the burst window still applies). */
  durable: boolean
  count: number
}

/** Atomic hit + verdict against the shared `rate_limit_window` table (fixed window). */
export async function checkDurableWindow(key: string, windowMs: number, maxCount: number, now: number = Date.now()): Promise<DurableVerdict> {
  try {
    const sql = getSql()
    const rows = (await sql`
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
    `) as { count: number; window_start: number }[]
    const count = rows[0]?.count ?? 1
    return { allowed: count <= maxCount, durable: true, count }
  } catch {
    return { allowed: true, durable: false, count: 0 }
  }
}
