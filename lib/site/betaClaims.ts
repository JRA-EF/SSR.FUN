// Neon store for public BETA key claims (DEC-0276). The source of truth for
// who claimed which key: the Google Sheet is a copy for the team to read, and
// the gate itself never reads this table (issued keys verify by MAC, see
// lib/site/session.ts). The table is created on demand, like the
// agent-feedback tables, so no migration step is needed.
import { getSql } from '../agent-feedback/db.js'

let schemaReady = false

async function ensureSchema(): Promise<void> {
  if (schemaReady) return
  const sql = getSql()
  await sql`
    CREATE TABLE IF NOT EXISTS beta_key_claims (
      handle_lower       text PRIMARY KEY,
      handle             text NOT NULL,
      email              text,
      beta_key           text NOT NULL UNIQUE,
      created_at         timestamptz NOT NULL DEFAULT now(),
      site               text,
      user_agent         text,
      sheet_synced       boolean NOT NULL DEFAULT false,
      first_redeemed_at  timestamptz,
      last_redeemed_at   timestamptz,
      redeem_count       integer NOT NULL DEFAULT 0
    )`
  schemaReady = true
}

export interface ClaimRow {
  handle: string
  email: string | null
  betaKey: string
  createdAt: string
  sheetSynced: boolean
}

function toRow(r: Record<string, unknown>): ClaimRow {
  return {
    handle: String(r.handle),
    email: (r.email as string | null) ?? null,
    betaKey: String(r.beta_key),
    createdAt: new Date(r.created_at as string).toISOString(),
    sheetSynced: Boolean(r.sheet_synced),
  }
}

export async function findClaim(handleLower: string): Promise<ClaimRow | null> {
  await ensureSchema()
  const rows = (await getSql()`SELECT * FROM beta_key_claims WHERE handle_lower = ${handleLower}`) as Record<string, unknown>[]
  return rows[0] ? toRow(rows[0]) : null
}

export async function countClaims(): Promise<number> {
  await ensureSchema()
  const rows = (await getSql()`SELECT count(*)::int AS n FROM beta_key_claims`) as { n: number }[]
  return rows[0]?.n ?? 0
}

/**
 * Stores a new claim, or returns the existing one when the handle already has
 * a key (a race between two requests for the same handle resolves to the one
 * that landed first). `created` tells the caller which happened.
 */
export async function insertClaim(input: {
  handle: string
  handleLower: string
  email: string | null
  betaKey: string
  site: string
  userAgent: string
}): Promise<{ row: ClaimRow; created: boolean }> {
  await ensureSchema()
  const sql = getSql()
  const inserted = (await sql`
    INSERT INTO beta_key_claims (handle_lower, handle, email, beta_key, site, user_agent)
    VALUES (${input.handleLower}, ${input.handle}, ${input.email}, ${input.betaKey}, ${input.site}, ${input.userAgent})
    ON CONFLICT (handle_lower) DO NOTHING
    RETURNING *`) as Record<string, unknown>[]
  if (inserted[0]) return { row: toRow(inserted[0]), created: true }
  const existing = await findClaim(input.handleLower)
  if (!existing) throw new Error('Claim vanished between insert and read.')
  return { row: existing, created: false }
}

/** Fills in an email on an existing claim that had none (never overwrites one). */
export async function addEmailIfMissing(handleLower: string, email: string): Promise<void> {
  await ensureSchema()
  await getSql()`UPDATE beta_key_claims SET email = ${email} WHERE handle_lower = ${handleLower} AND email IS NULL`
}

/** Oldest claims not yet copied to the Sheet (lower-cased handle + row), for catch-up. */
export async function listUnsynced(limit: number): Promise<{ handleLower: string; row: ClaimRow }[]> {
  await ensureSchema()
  const rows = (await getSql()`SELECT * FROM beta_key_claims WHERE NOT sheet_synced ORDER BY created_at LIMIT ${limit}`) as Record<string, unknown>[]
  return rows.map(r => ({ handleLower: String(r.handle_lower), row: toRow(r) }))
}

export async function markSheetSynced(handleLower: string): Promise<void> {
  await getSql()`UPDATE beta_key_claims SET sheet_synced = true WHERE handle_lower = ${handleLower}`
}

export async function recordRedemption(betaKey: string): Promise<void> {
  await ensureSchema()
  await getSql()`
    UPDATE beta_key_claims
    SET first_redeemed_at = COALESCE(first_redeemed_at, now()), last_redeemed_at = now(), redeem_count = redeem_count + 1
    WHERE beta_key = ${betaKey}`
}
