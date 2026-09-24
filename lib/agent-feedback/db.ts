// Neon-backed store for the agent-feedback pipeline. Mirrors
// lib/reserve-warm-cache/db.ts (same DATABASE_URL, same lazy-init rationale so
// importing this never throws at build/typecheck time before DATABASE_URL
// exists). The tables are created on demand (idempotent) so no separate
// migration step is needed -- see ensureSchema().

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { deriveBoardStatus, isPriority, type AgentAction, type BoardPriority, type BoardStatus } from './boardPure.js'

let _sql: NeonQueryFunction<false, false> | null = null

export function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not configured.')
    _sql = neon(url)
  }
  return _sql
}

/** Test seam: run the store against another SQL function (tests use a local Postgres). */
export function setSqlForTests(fn: NeonQueryFunction<false, false>): void {
  _sql = fn
  _schemaReady = false
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
  // Team board (/internal/feedback-board). Rows returned from this module
  // always carry a derived boardStatus and a priority (default normal).
  boardStatus?: BoardStatus
  priority?: BoardPriority
  boardUpdatedAt?: string | null
  boardUpdatedBy?: string | null
}

export interface BoardHistoryEntry {
  at: string
  actor: string | null
  kind: 'status' | 'priority' | 'note' | 'agent_start' | 'agent_stop' | 'agent_result'
  from: string | null
  to: string | null
  note: string | null
}

export type AgentRequestState = 'new' | 'claimed' | 'done' | 'failed'

export interface AgentRequestSummary {
  id: number
  action: AgentAction
  state: AgentRequestState
  requestedBy: string | null
  requestedAt: string
  doneAt: string | null
  result: string | null
}

export interface BoardRow extends FeedbackRow {
  boardStatus: BoardStatus
  priority: BoardPriority
  history: BoardHistoryEntry[]
  agentRequest: AgentRequestSummary | null // the latest start/stop request, if any
}

export interface ClaimedAgentRequest {
  request: { id: number; feedbackId: string; action: AgentAction; requestedBy: string | null; requestedAt: string; note: string | null }
  item: BoardRow | null
}

function withBoardFields<T extends FeedbackRow>(row: T): T & { boardStatus: BoardStatus; priority: BoardPriority } {
  return {
    ...row,
    boardStatus: deriveBoardStatus(row.status, row.boardStatus),
    priority: isPriority(row.priority) ? row.priority : 'normal',
  }
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
  // Added 2026-09-15: the team board. board_status stays null until the item
  // is placed (by a person, the fixer agent, or a decision); deriveBoardStatus()
  // fills the gap. priority null means normal.
  await sql`alter table agent_feedback add column if not exists board_status text`
  await sql`alter table agent_feedback add column if not exists priority text`
  await sql`alter table agent_feedback add column if not exists board_updated_at timestamptz`
  await sql`alter table agent_feedback add column if not exists board_updated_by text`
  // Everything that happens to an item on the board, append-only: status and
  // priority changes, notes, and start/stop requests with their outcome.
  await sql`
    create table if not exists agent_feedback_board_events (
      id          bigserial primary key,
      feedback_id uuid not null references agent_feedback(id),
      at          timestamptz not null default now(),
      actor       text,
      kind        text not null,   -- status | priority | note | agent_start | agent_stop | agent_result
      from_value  text,
      to_value    text,
      note        text
    )`
  await sql`create index if not exists agent_feedback_board_events_item_idx on agent_feedback_board_events (feedback_id, at)`
  // Start/stop requests for the fixer agent, queued by the board and claimed
  // by the Mac daemon (api/feedback/agent-requests.ts). Never deleted.
  await sql`
    create table if not exists agent_feedback_agent_requests (
      id           bigserial primary key,
      feedback_id  uuid not null references agent_feedback(id),
      action       text not null,   -- start | stop
      requested_by text,
      requested_at timestamptz not null default now(),
      note         text,
      state        text not null default 'new',   -- new | claimed | done | failed
      claimed_at   timestamptz,
      done_at      timestamptz,
      result       text
    )`
  await sql`create index if not exists agent_feedback_agent_requests_state_idx on agent_feedback_agent_requests (state, requested_at)`
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
              resolved_at  as "resolvedAt",
              board_status as "boardStatus",
              priority,
              board_updated_at as "boardUpdatedAt",
              board_updated_by as "boardUpdatedBy"`

// Per-item extras for the board; the FROM clause must alias agent_feedback as f.
const BOARD_EXTRAS = `coalesce((
                select json_agg(json_build_object('at', e.at, 'actor', e.actor, 'kind', e.kind,
                                                  'from', e.from_value, 'to', e.to_value, 'note', e.note)
                                order by e.at, e.id)
                  from agent_feedback_board_events e
                 where e.feedback_id = f.id), '[]'::json) as history,
              (select json_build_object('id', r.id, 'action', r.action, 'state', r.state,
                                        'requestedBy', r.requested_by, 'requestedAt', r.requested_at,
                                        'doneAt', r.done_at, 'result', r.result)
                 from agent_feedback_agent_requests r
                where r.feedback_id = f.id
                order by r.requested_at desc, r.id desc
                limit 1) as "agentRequest"`

/** One item by id (any status), or null. Lets the daemon recover the full
 *  text on Approve after a restart instead of relying on its memory. */
export async function getFeedback(id: string): Promise<FeedbackRow | null> {
  await ensureSchema()
  const sql = getSql()
  const rows = (await sql.query(
    `select ${ROW_COLUMNS} from agent_feedback where id = $1`, [id])) as FeedbackRow[]
  return rows[0] ? withBoardFields(rows[0]) : null
}

/** Newest-first listing, optionally filtered by status. */
export async function listFeedback(limit: number, status: string | null): Promise<FeedbackRow[]> {
  await ensureSchema()
  const sql = getSql()
  const rows = (await sql.query(
    `select ${ROW_COLUMNS} from agent_feedback
      where ($2::text is null or status = $2)
      order by created_at desc limit $1`, [limit, status])) as FeedbackRow[]
  return rows.map(withBoardFields)
}

/** Every item for the team board, newest first, with history and latest agent request. */
export async function listBoard(limit = 2000): Promise<BoardRow[]> {
  await ensureSchema()
  const rows = (await getSql().query(
    `select ${ROW_COLUMNS}, ${BOARD_EXTRAS}
       from agent_feedback f
      order by f.created_at desc limit $1`, [limit])) as BoardRow[]
  return rows.map(withBoardFields)
}

export async function getBoardItem(id: string): Promise<BoardRow | null> {
  await ensureSchema()
  const rows = (await getSql().query(
    `select ${ROW_COLUMNS}, ${BOARD_EXTRAS}
       from agent_feedback f
      where f.id = $1`, [id])) as BoardRow[]
  return rows[0] ? withBoardFields(rows[0]) : null
}

/**
 * Change an item's board status and/or priority, or just add a note. The
 * update and its history entries are written in one statement. Returns the
 * updated item, or null if the id does not exist.
 */
export async function updateBoardItem(
  id: string,
  change: { status?: BoardStatus; priority?: BoardPriority },
  actor: string,
  note: string | null,
): Promise<BoardRow | null> {
  await ensureSchema()
  const current = await getFeedback(id)
  if (!current) return null
  const fromStatus = deriveBoardStatus(current.status, current.boardStatus)
  const fromPriority: BoardPriority = current.priority ?? 'normal'
  const toStatus = change.status ?? fromStatus
  const toPriority = change.priority ?? fromPriority
  const events: { kind: string; from_value: string | null; to_value: string | null; note: string | null }[] = []
  if (toStatus !== fromStatus) events.push({ kind: 'status', from_value: fromStatus, to_value: toStatus, note })
  if (toPriority !== fromPriority) events.push({ kind: 'priority', from_value: fromPriority, to_value: toPriority, note: events.length ? null : note })
  if (!events.length && note) events.push({ kind: 'note', from_value: null, to_value: null, note })
  if (events.length) {
    await getSql().query(
      `with changed as (
         update agent_feedback
            set board_status = $2, priority = $3, board_updated_at = now(), board_updated_by = $4
          where id = $1
         returning id)
       insert into agent_feedback_board_events (feedback_id, actor, kind, from_value, to_value, note)
       select changed.id, $4::text, ev.kind, ev.from_value, ev.to_value, ev.note
         from changed
         cross join jsonb_to_recordset($5::jsonb) as ev(kind text, from_value text, to_value text, note text)`,
      [id, toStatus, toPriority, actor, JSON.stringify(events)])
  }
  return getBoardItem(id)
}

/**
 * Queue a start/stop request for the fixer agent. An identical request that is
 * still waiting is reused rather than duplicated (created = false).
 */
export async function requestAgent(id: string, action: AgentAction, actor: string, note: string | null): Promise<{ created: boolean; row: BoardRow } | null> {
  await ensureSchema()
  if (!(await getFeedback(id))) return null
  const rows = (await getSql().query(
    `with open_request as (
       select 1 from agent_feedback_agent_requests
        where feedback_id = $1::uuid and action = $2::text and state in ('new', 'claimed'))
     , created as (
       insert into agent_feedback_agent_requests (feedback_id, action, requested_by, note)
       select $1::uuid, $2::text, $3::text, $4::text
        where not exists (select 1 from open_request)
       returning feedback_id)
     , logged as (
       insert into agent_feedback_board_events (feedback_id, actor, kind, note)
       select feedback_id, $3::text, 'agent_' || $2::text, $4::text from created
       returning id)
     select (select count(*) from created)::int as created`,
    [id, action, actor, note])) as { created: number }[]
  const row = await getBoardItem(id)
  return row ? { created: (rows[0]?.created ?? 0) > 0, row } : null
}

/**
 * Atomically claim waiting start/stop requests for the daemon, oldest first.
 * A request claimed more than 10 minutes ago without an outcome is claimable
 * again (its claim response was lost, or the daemon died mid-way).
 */
export async function claimAgentRequests(limit: number): Promise<ClaimedAgentRequest[]> {
  await ensureSchema()
  const claimed = (await getSql().query(
    `update agent_feedback_agent_requests r
        set state = 'claimed', claimed_at = now()
      where r.id in (
        select id from agent_feedback_agent_requests
         where state = 'new' or (state = 'claimed' and claimed_at < now() - interval '10 minutes')
         order by requested_at, id
         limit $1
         for update skip locked)
     returning r.id, r.feedback_id as "feedbackId", r.action, r.requested_by as "requestedBy",
               r.requested_at as "requestedAt", r.note`, [limit])) as ClaimedAgentRequest['request'][]
  const ordered = claimed.map((r) => ({ ...r, id: Number(r.id) })).sort((a, b) => a.id - b.id)
  return Promise.all(ordered.map(async (request) => ({ request, item: await getBoardItem(request.feedbackId) })))
}

/**
 * Record what happened to a start/stop request. A delivered start also marks
 * the item dispatched and moves it to in progress. Repeating the call for an
 * already finished request is a no-op (returns false), so retries are safe.
 */
export async function completeAgentRequest(requestId: number, ok: boolean, result: string | null, dispatchedTo: string | null): Promise<boolean> {
  await ensureSchema()
  const rows = (await getSql().query(
    `with finished as (
       update agent_feedback_agent_requests
          set state = $2::text, done_at = now(), result = $3::text
        where id = $1::bigint and state in ('new', 'claimed')
       returning feedback_id, action, requested_by)
     , logged as (
       insert into agent_feedback_board_events (feedback_id, actor, kind, note)
       select feedback_id, 'feedback daemon', 'agent_result',
              action || case when $2::text = 'done' then ' delivered to the fixer agent' else ' failed' end
                     || coalesce(': ' || $3::text, '')
         from finished
       returning id)
     select feedback_id as "feedbackId", action, requested_by as "requestedBy" from finished`,
    [requestId, ok ? 'done' : 'failed', result])) as { feedbackId: string; action: AgentAction; requestedBy: string | null }[]
  const done = rows[0]
  if (!done) return false
  if (ok && done.action === 'start') {
    await markStatus(done.feedbackId, 'dispatched', dispatchedTo, done.requestedBy, 'board')
  }
  return true
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
              status,
              priority`) as FeedbackRow[]
}

/**
 * Mark an item dispatched (injected to an agent) or dismissed, and mirror it
 * onto the team board: dismissed -> rejected, dispatched -> in progress.
 * A Telegram decision only places an item nobody has placed yet (or that is
 * still "reported"), so it never overwrites a placement someone made. A start
 * requested on the board (via = 'board') is explicit, so it always moves the item.
 */
export async function markStatus(
  id: string,
  status: 'dispatched' | 'dismissed',
  dispatchedTo: string | null,
  handledBy: string | null = null,
  via: 'telegram' | 'board' = 'telegram',
): Promise<void> {
  await ensureSchema()
  const boardTo: BoardStatus = status === 'dismissed' ? 'rejected' : 'in_progress'
  const fromBoard = via === 'board'
  const actor = fromBoard ? 'feedback daemon' : handledBy ? `${handledBy} via Telegram` : 'Telegram'
  const note = fromBoard
    ? `Started from the team board by ${handledBy ?? 'a teammate'}`
    : status === 'dismissed' ? 'Dismissed in Telegram' : 'Approved in Telegram and sent to the fixer agent'
  await getSql().query(
    `with prev as (
       select id, board_status from agent_feedback where id = $1)
     , upd as (
       update agent_feedback f
          set status = $2, handled_at = now(), dispatched_to = $3, handled_by = $4,
              board_status     = case when $8::boolean or f.board_status is null or f.board_status = 'reported' then $5::text else f.board_status end,
              board_updated_at = case when $8::boolean or f.board_status is null or f.board_status = 'reported' then now() else f.board_updated_at end,
              board_updated_by = case when $8::boolean or f.board_status is null or f.board_status = 'reported' then $6::text else f.board_updated_by end
        where f.id = $1
       returning f.id)
     insert into agent_feedback_board_events (feedback_id, actor, kind, from_value, to_value, note)
     select upd.id, $6::text, 'status', coalesce(prev.board_status, 'reported'), $5::text, $7::text
       from upd join prev on prev.id = upd.id
      where coalesce(prev.board_status, 'reported') <> $5::text
        and ($8::boolean or prev.board_status is null or prev.board_status = 'reported')`,
    [id, status, dispatchedTo, handledBy, boardTo, actor, note, fromBoard])
}
