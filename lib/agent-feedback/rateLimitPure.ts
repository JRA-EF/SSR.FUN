// Pure, dependency-free pieces of the feedback rate limiter (unit-tested
// directly by tests/phase_feedback_rate_limit.mjs under Node's native type
// stripping, which cannot follow a `./db.js` import to a .ts file).

// --- In-memory burst window (per warm instance; best-effort) --------------------
const windows = new Map<string, { count: number; windowStart: number }>()

/** Records one hit and returns whether `key` is still within `maxCount` per `windowMs` on this instance. */
export function checkBurstWindow(key: string, windowMs: number, maxCount: number, now: number = Date.now()): boolean {
  const entry = windows.get(key)
  if (!entry || now - entry.windowStart >= windowMs) {
    windows.set(key, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= maxCount) return false
  entry.count += 1
  return true
}

/** Pure: which limit (if any) refuses this request -- cheapest window first. */
export function rateLimitVerdict(burstOk: boolean, ipOk: boolean, globalOk: boolean): 'ok' | 'burst' | 'ip' | 'global' {
  if (!burstOk) return 'burst'
  if (!ipOk) return 'ip'
  if (!globalOk) return 'global'
  return 'ok'
}
