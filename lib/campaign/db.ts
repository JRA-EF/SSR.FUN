// Neon store for Beta Campaign entries (DEC-0279). One row per Reserve: the
// creator's signed statement linking the Reserve's on-chain manager wallet to
// an X handle. The signature and the exact signed message are kept, so anyone
// on the team can re-verify an entry before paying a prize. Created on demand
// (like beta_key_claims), so no migration step is needed.
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
    CREATE TABLE IF NOT EXISTS campaign_entries (
      reserve      text PRIMARY KEY,
      wallet       text NOT NULL,
      handle       text NOT NULL,
      message      text NOT NULL,
      signature    text NOT NULL,
      entered_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`
  schemaReady = true
}

export interface CampaignEntry {
  reserve: string
  wallet: string
  handle: string
  message: string
  signature: string
  enteredAt: string
}

function toEntry(r: Record<string, unknown>): CampaignEntry {
  return {
    reserve: String(r.reserve),
    wallet: String(r.wallet),
    handle: String(r.handle),
    message: String(r.message),
    signature: String(r.signature),
    enteredAt: new Date(r.entered_at as string).toISOString(),
  }
}

export async function listEntries(): Promise<CampaignEntry[]> {
  await ensureSchema()
  return ((await getSql()`SELECT * FROM campaign_entries ORDER BY entered_at`) as Record<string, unknown>[]).map(toEntry)
}

export async function findEntry(reserve: string): Promise<CampaignEntry | null> {
  await ensureSchema()
  const rows = (await getSql()`SELECT * FROM campaign_entries WHERE reserve = ${reserve}`) as Record<string, unknown>[]
  return rows[0] ? toEntry(rows[0]) : null
}

/** Insert or replace (a creator may correct their handle); entered_at keeps the first entry time. */
export async function upsertEntry(e: Omit<CampaignEntry, 'enteredAt'>): Promise<CampaignEntry> {
  await ensureSchema()
  const rows = (await getSql()`
    INSERT INTO campaign_entries (reserve, wallet, handle, message, signature)
    VALUES (${e.reserve}, ${e.wallet}, ${e.handle}, ${e.message}, ${e.signature})
    ON CONFLICT (reserve) DO UPDATE
    SET wallet = EXCLUDED.wallet, handle = EXCLUDED.handle, message = EXCLUDED.message,
        signature = EXCLUDED.signature, updated_at = now()
    RETURNING *`) as Record<string, unknown>[]
  return toEntry(rows[0])
}

export { getSql as getCampaignSql }

/** When this Reserve was created (unix s): its reserveCreated event, else its earliest indexed activity; null if not indexed yet. */
export async function createdTsOf(reserve: string): Promise<number | null> {
  const rows = (await getSql()`
    SELECT COALESCE(min(ts) FILTER (WHERE kind = 'reserveCreated'), min(ts))::bigint AS created
    FROM reserve_activity_log WHERE cluster = 'mainnet-beta' AND reserve = ${reserve}`) as { created: string | null }[]
  return rows[0]?.created ? Number(rows[0].created) : null
}

// --- Trader entries (owner, 2026-11-04): one row per wallet ----------------
let traderSchemaReady = false
async function ensureTraderSchema(): Promise<void> {
  if (traderSchemaReady) return
  await getSql()`
    CREATE TABLE IF NOT EXISTS campaign_traders (
      wallet       text PRIMARY KEY,
      handle       text NOT NULL,
      message      text NOT NULL,
      signature    text NOT NULL,
      entered_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`
  traderSchemaReady = true
}

export interface TraderEntry { wallet: string; handle: string; message: string; signature: string; enteredAt: string }

function toTrader(r: Record<string, unknown>): TraderEntry {
  return { wallet: String(r.wallet), handle: String(r.handle), message: String(r.message), signature: String(r.signature), enteredAt: new Date(r.entered_at as string).toISOString() }
}

export async function listTraders(): Promise<TraderEntry[]> {
  await ensureTraderSchema()
  return ((await getSql()`SELECT * FROM campaign_traders ORDER BY entered_at`) as Record<string, unknown>[]).map(toTrader)
}

export async function findTrader(wallet: string): Promise<TraderEntry | null> {
  await ensureTraderSchema()
  const rows = (await getSql()`SELECT * FROM campaign_traders WHERE wallet = ${wallet}`) as Record<string, unknown>[]
  return rows[0] ? toTrader(rows[0]) : null
}

/** Insert or replace the handle; entered_at keeps the first sign-up time. */
export async function upsertTrader(e: Omit<TraderEntry, 'enteredAt'>): Promise<TraderEntry> {
  await ensureTraderSchema()
  const rows = (await getSql()`
    INSERT INTO campaign_traders (wallet, handle, message, signature)
    VALUES (${e.wallet}, ${e.handle}, ${e.message}, ${e.signature})
    ON CONFLICT (wallet) DO UPDATE
    SET handle = EXCLUDED.handle, message = EXCLUDED.message, signature = EXCLUDED.signature, updated_at = now()
    RETURNING *`) as Record<string, unknown>[]
  return toTrader(rows[0])
}
