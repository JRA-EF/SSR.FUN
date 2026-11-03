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

/** Counts a sign-in with this key; true on its FIRST sign-in (so the caller can mark it Used in the Sheet). */
export async function recordRedemption(betaKey: string): Promise<boolean> {
  await ensureSchema()
  const rows = (await getSql()`
    UPDATE beta_key_claims
    SET first_redeemed_at = COALESCE(first_redeemed_at, now()), last_redeemed_at = now(), redeem_count = redeem_count + 1
    WHERE beta_key = ${betaKey}
    RETURNING redeem_count`) as { redeem_count: number }[]
  return rows[0]?.redeem_count === 1
}

/** Marks the key Used (with today's date) in the team's key inventory Sheet. Best effort. */
export async function markUsedInSheet(betaKey: string): Promise<void> {
  const webhook = process.env.FEEDBACK_SHEET_WEBHOOK_URL
  const secret = process.env.FEEDBACK_SHEET_SECRET
  if (!webhook || !secret) return
  const r = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, action: 'beta-used', key: betaKey, at: new Date().toISOString() }),
    redirect: 'follow',
    signal: AbortSignal.timeout(8_000),
  })
  const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (!r.ok || !j?.ok) throw new Error(`sheet beta-used failed: ${r.status} ${j?.error ?? ''}`)
}

// --- Sign-ins with env-list keys (SSR_BETA_KEYS / SSR_TEAM_KEYS / SSR_SITE_PASSWORD) ---
// Wave 1 keys are handed out from the env list, not issued by /beta, so they
// have no beta_key_claims row. This table counts their sign-ins by a short
// hash tag (betaKeyTag), never the key itself, so the team can see which keys
// are in use; the key's own row in the Sheet is marked Used on first sign-in.

let keyUseSchemaReady = false

export type ListedKeyKind = 'beta' | 'team' | 'password'

async function ensureKeyUseSchema(): Promise<void> {
  if (keyUseSchemaReady) return
  await getSql()`
    CREATE TABLE IF NOT EXISTS site_key_redemptions (
      key_tag            text PRIMARY KEY,
      kind               text NOT NULL,
      first_redeemed_at  timestamptz NOT NULL DEFAULT now(),
      last_redeemed_at   timestamptz NOT NULL DEFAULT now(),
      redeem_count       integer NOT NULL DEFAULT 1
    )`
  keyUseSchemaReady = true
}

/** Counts a sign-in with an env-list key (by its tag); true on its FIRST recorded sign-in. */
export async function recordListedKeyRedemption(keyTag: string, kind: ListedKeyKind): Promise<boolean> {
  await ensureKeyUseSchema()
  const rows = (await getSql()`
    INSERT INTO site_key_redemptions (key_tag, kind) VALUES (${keyTag}, ${kind})
    ON CONFLICT (key_tag) DO UPDATE
    SET last_redeemed_at = now(), redeem_count = site_key_redemptions.redeem_count + 1, kind = EXCLUDED.kind
    RETURNING redeem_count`) as { redeem_count: number }[]
  return rows[0]?.redeem_count === 1
}
