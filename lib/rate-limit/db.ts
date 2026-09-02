// Lazy Neon client for the durable rate limiter -- mirrors
// lib/reserve-activity/db.ts exactly (same DATABASE_URL, same lazy-init
// rationale: importing this module must never throw at build/typecheck time
// before DATABASE_URL exists). Do NOT wrap in a Proxy.

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
