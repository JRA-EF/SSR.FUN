// Neon store for cancelled unfinished launches (DEC-0296). One row per
// Reserve: the manager's signed statement that it no longer wants the launch
// shown. Kept with the exact message and signature so anyone can re-check it.
// Created on demand (like campaign_entries), so no migration step is needed.
import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

let sqlClient: NeonQueryFunction<false, false> | null = null
function getSql(): NeonQueryFunction<false, false> {
  if (!sqlClient) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not configured.')
    sqlClient = neon(url)
  }
  return sqlClient
}

let schemaReady = false
async function ensureSchema(): Promise<void> {
  if (schemaReady) return
  await getSql()`
    CREATE TABLE IF NOT EXISTS launch_cancellations (
      reserve       text PRIMARY KEY,
      wallet        text NOT NULL,
      signature     text NOT NULL,
      message       text NOT NULL,
      cancelled_at  timestamptz DEFAULT now()
    )`
  schemaReady = true
}

export interface LaunchCancellation {
  reserve: string
  cancelledAt: string
}

export async function listCancellations(wallet: string): Promise<LaunchCancellation[]> {
  await ensureSchema()
  const rows = (await getSql()`SELECT reserve, cancelled_at FROM launch_cancellations WHERE wallet = ${wallet} ORDER BY cancelled_at`) as Record<string, unknown>[]
  return rows.map((r) => ({ reserve: String(r.reserve), cancelledAt: new Date(r.cancelled_at as string).toISOString() }))
}

/** Insert or refresh (a repeat cancel keeps one row per Reserve). */
export async function upsertCancellation(c: { reserve: string; wallet: string; signature: string; message: string }): Promise<LaunchCancellation> {
  await ensureSchema()
  const rows = (await getSql()`
    INSERT INTO launch_cancellations (reserve, wallet, signature, message)
    VALUES (${c.reserve}, ${c.wallet}, ${c.signature}, ${c.message})
    ON CONFLICT (reserve) DO UPDATE
    SET wallet = EXCLUDED.wallet, signature = EXCLUDED.signature, message = EXCLUDED.message, cancelled_at = now()
    RETURNING reserve, cancelled_at`) as Record<string, unknown>[]
  return { reserve: String(rows[0].reserve), cancelledAt: new Date(rows[0].cancelled_at as string).toISOString() }
}

export async function deleteCancellation(reserve: string, wallet: string): Promise<void> {
  await ensureSchema()
  await getSql()`DELETE FROM launch_cancellations WHERE reserve = ${reserve} AND wallet = ${wallet}`
}
