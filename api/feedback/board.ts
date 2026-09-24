// The team feedback board (/internal/feedback-board).
//
// GET  /api/feedback/board
//      -> { items, statuses, priorities }: every item newest first, with its
//         board status, priority, history, and latest fixer-agent request.
//         The page filters (rejected is hidden by default there).
// GET  /api/feedback/board?format=csv[&statuses=reported,testing]
//      -> CSV download. Default: every status except rejected.
// POST /api/feedback/board { id, status?, priority?, note?, actor? }
//      -> changes status and/or priority, or just adds a note.
// POST /api/feedback/board { id, action: 'start' | 'stop', note?, actor? }
//      -> asks the fixer agent to start or stop work on the item. The Mac
//         daemon claims the request (api/feedback/agent-requests.ts), pastes
//         it into the fixer's tmux session, and reports the outcome back.
//
// Two kinds of caller, both authenticated HERE. middleware.ts exempts this
// path from its page gates because the agent has no browser cookie:
//   - people: the SSR_DASHBOARD_PASSWORD session, same login as /internal/status
//   - the fixer agent: the FEEDBACK_DAEMON_SECRET bearer, via
//     `feedback-daemon.py --board <id> <status> "<note>"`
// Only a person can mark an item live or start/stop the agent: the agent works
// on branches, never deploys, and never schedules its own work.
import { listBoard, requestAgent, updateBoardItem } from '../../lib/agent-feedback/db.js'
import {
  BOARD_STATUSES, PRIORITIES, agentSummary, canSetStatus, isAgentAction, isBoardStatus, isPriority,
  latestNote, parseStatusList, toCsv,
} from '../../lib/agent-feedback/boardPure.js'
import { parseCookie, SESSION_COOKIE_NAME, timingSafeEqual, verifySessionCookie } from '../../lib/dashboard/session.js'
import { parseBody, queryParam, type Req } from './_auth.js'

interface Res {
  status: (n: number) => Res
  json: (b: unknown) => void
  setHeader: (k: string, v: string) => void
  end: (chunk?: string) => void
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NOTE = 2000
const MAX_ACTOR = 60

function header(req: Req, name: string): string {
  const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

async function callerKind(req: Req): Promise<'human' | 'agent' | null> {
  const secret = process.env.FEEDBACK_DAEMON_SECRET ?? ''
  if (secret && timingSafeEqual(header(req, 'authorization'), `Bearer ${secret}`)) return 'agent'
  const session = parseCookie(header(req, 'cookie'), SESSION_COOKIE_NAME)
  if (await verifySessionCookie(session, process.env.SSR_DASHBOARD_PASSWORD ?? '')) return 'human'
  return null
}

// Defense in depth on top of the SameSite=Strict session cookie (same rule as
// lib/road-to-mainnet/auth.ts): refuse a cookie-authenticated POST whose
// Origin is another site.
function isSameOrigin(req: Req): boolean {
  const origin = header(req, 'origin')
  if (!origin) return true
  try {
    return new URL(origin).host === header(req, 'host')
  } catch {
    return false
  }
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim().slice(0, max)
  return t || null
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  const caller = await callerKind(req)
  if (!caller) { res.status(401).json({ error: 'Unauthorized' }); return }

  try {
    if (req.method === 'GET') {
      const items = await listBoard()
      if (queryParam(req, 'format') === 'csv') {
        const wanted = parseStatusList(queryParam(req, 'statuses'))
        const rows = items
          .filter((it) => wanted.includes(it.boardStatus))
          .map((it) => ({ ...it, latestNote: latestNote(it.history), agent: agentSummary(it.agentRequest) }))
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="ssr-feedback-${new Date().toISOString().slice(0, 10)}.csv"`)
        res.status(200)
        res.end(toCsv(rows))
        return
      }
      res.status(200).json({ items, statuses: BOARD_STATUSES, priorities: PRIORITIES })
      return
    }

    if (req.method === 'POST') {
      if (caller === 'human' && !isSameOrigin(req)) { res.status(403).json({ error: 'Cross-site request rejected.' }); return }
      const body = parseBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!UUID_RE.test(id)) { res.status(400).json({ error: 'A valid item id is required.' }); return }
      const note = cleanText(body.note, MAX_NOTE)
      const name = cleanText(body.actor, MAX_ACTOR) ?? (caller === 'agent' ? 'fixer agent' : 'team')
      const actor = `${name} (${caller === 'agent' ? 'agent' : 'board'})`

      if (body.action !== undefined) {
        const action = body.action
        if (!isAgentAction(action)) { res.status(400).json({ error: 'action must be start or stop.' }); return }
        if (caller !== 'human') { res.status(403).json({ error: 'Only a person can start or stop the fixer agent.' }); return }
        const queued = await requestAgent(id, action, actor, note)
        if (!queued) { res.status(404).json({ error: 'Not found.' }); return }
        res.status(200).json({ ok: true, queued: queued.created, item: queued.row })
        return
      }

      const status = body.status
      const priority = body.priority
      if (status !== undefined && !isBoardStatus(status)) { res.status(400).json({ error: `status must be one of: ${BOARD_STATUSES.join(', ')}.` }); return }
      if (priority !== undefined && !isPriority(priority)) { res.status(400).json({ error: `priority must be one of: ${PRIORITIES.join(', ')}.` }); return }
      if (status === undefined && priority === undefined && !note) { res.status(400).json({ error: 'Nothing to change: send a status, a priority, or a note.' }); return }
      if (status !== undefined && !canSetStatus(caller, status)) { res.status(403).json({ error: 'Only a person can mark an item live.' }); return }
      const item = await updateBoardItem(id, { status, priority }, actor, note)
      if (!item) { res.status(404).json({ error: 'Not found.' }); return }
      res.status(200).json({ ok: true, item })
      return
    }

    res.status(405).json({ error: 'Method not allowed.' })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Board request failed.' })
  }
}

