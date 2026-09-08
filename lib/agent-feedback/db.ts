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
  status: string
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
  _schemaReady = true
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
export async function markStatus(id: string, status: 'dispatched' | 'dismissed', dispatchedTo: string | null): Promise<void> {
  await ensureSchema()
  const sql = getSql()
  await sql`
    update agent_feedback
       set status = ${status}, handled_at = now(), dispatched_to = ${dispatchedTo}
     where id = ${id}`
}
