// Neon-backed store for the agent-feedback pipeline. Mirrors
// lib/reserve-warm-cache/db.ts (same DATABASE_URL, same lazy-init rationale so
// importing this never throws at build/typecheck time before DATABASE_URL
// exists). The table is created on demand (idempotent) so no separate
// migration step is needed -- see ensureSchema().

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

export interface FeedbackRow {
  id: string
  createdAt: string
  category: string
  message: string
  contact: string | null
  pageUrl: string | null
  status: string            // new | raised | dispatched | dismissed | resolved
  raisedAt?: string | null
  handledAt?: string | null
  handledBy?: string | null // Telegram "@handle (id)" that tapped Approve/Dismiss
  dispatchedTo?: string | null
  resolution?: string | null // the fixer agent's conclusion
  resolvedAt?: string | null
}

let _schemaReady = false
export async function ensureSchema(): Promise<void> {
  if (_schemaReady) return
  const sql = getSql()
  await sql`
    create table if not exists agent_feedback (
      id            uuid primary key default gen_random_uuid(),
      created_at    timestamptz not null default now(),
      category      text not null default 'general',
      message       text not null,
      contact       text,
      page_url      text,
      status        text not null default 'new',   -- new | raised | dispatched | dismissed
      raised_at     timestamptz,
      handled_at    timestamptz,
      dispatched_to text
    )`
  await sql`create index if not exists agent_feedback_status_idx on agent_feedback (status, created_at)`
  // Added 2026-09-08 (DEC-0197): the row is the permanent record of the whole
  // life of a feedback item -- who decided, and what the fixer concluded.
  await sql`alter table agent_feedback add column if not exists handled_by text`
  await sql`alter table agent_feedback add column if not exists resolution text`
  await sql`alter table agent_feedback add column if not exists resolved_at timestamptz`
  _schemaReady = true
}

const ROW_COLUMNS = `id,
              created_at   as "createdAt",
              category,
              message,
              contact,
              page_url     as "pageUrl",
              status,
              raised_at    as "raisedAt",
              handled_at   as "handledAt",
              handled_by   as "handledBy",
              dispatched_to as "dispatchedTo",
              resolution,
              resolved_at  as "resolvedAt"`

/** One item by id (any status), or null. Lets the daemon recover the full
 *  text on Approve after a restart instead of relying on its memory. */
export async function getFeedback(id: string): Promise<FeedbackRow | null> {
  await ensureSchema()
  const sql = getSql()
  const rows = (await sql.query(
    `select ${ROW_COLUMNS} from agent_feedback where id = $1`, [id])) as FeedbackRow[]
  return rows[0] ?? null
}

/** Newest-first listing, optionally filtered by status. */
export async function listFeedback(limit: number, status: string | null): Promise<FeedbackRow[]> {
  await ensureSchema()
  const sql = getSql()
  return (await sql.query(
    `select ${ROW_COLUMNS} from agent_feedback
      where ($2::text is null or status = $2)
      order by created_at desc limit $1`, [limit, status])) as FeedbackRow[]
}

/** Record the fixer's conclusion for a dispatched item (status -> resolved). */
export async function resolveFeedback(id: string, resolution: string): Promise<boolean> {
  await ensureSchema()
  const sql = getSql()
  const rows = (await sql`
    update agent_feedback
       set status = 'resolved', resolution = ${resolution}, resolved_at = now()
     where id = ${id}
    returning id`) as { id: string }[]
  return rows.length > 0
}

/** Insert a freshly-submitted feedback item; returns its id. */
export async function insertFeedback(input: {
  category: string; message: string; contact: string | null; pageUrl: string | null
}): Promise<string> {
  await ensureSchema()
  const sql = getSql()
  const rows = (await sql`
    insert into agent_feedback (category, message, contact, page_url)
    values (${input.category}, ${input.message}, ${input.contact}, ${input.pageUrl})
    returning id`) as { id: string }[]
  return rows[0].id
}

/**
 * Atomically claim up to `limit` un-raised items: flips their status new->raised
 * and returns them. The UPDATE...RETURNING makes claiming race-safe, so even a
 * daemon restart (or two daemons) never raises the same item twice.
 */
export async function claimNewFeedback(limit: number): Promise<FeedbackRow[]> {
  await ensureSchema()
  const sql = getSql()
  return (await sql`
    update agent_feedback
       set status = 'raised', raised_at = now()
     where id in (
       select id from agent_feedback
        where status = 'new'
        order by created_at
        limit ${limit}
       for update skip locked
     )
    returning id,
              created_at   as "createdAt",
              category,
              message,
              contact,
              page_url     as "pageUrl",
              status`) as FeedbackRow[]
}

/** Mark an item dispatched (injected to an agent) or dismissed. */
export async function markStatus(id: string, status: 'dispatched' | 'dismissed', dispatchedTo: string | null, handledBy: string | null = null): Promise<void> {
  await ensureSchema()
  const sql = getSql()
  await sql`
    update agent_feedback
       set status = ${status}, handled_at = now(), dispatched_to = ${dispatchedTo}, handled_by = ${handledBy}
     where id = ${id}`
}
