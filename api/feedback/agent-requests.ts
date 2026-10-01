// Start/stop requests for the fixer agent, made on the team board.
//
// GET  /api/feedback/agent-requests
//      -> { requests: [{ request, item }] }: atomically claims waiting requests,
//         oldest first. Called by the Mac daemon on every poll.
// POST /api/feedback/agent-requests { requestId, ok, result?, dispatchedTo? }
//      -> records the outcome. A delivered start marks the item dispatched and
//         in progress. Safe to repeat: a finished request is left unchanged.
//
// Bearer-secret auth only (FEEDBACK_DAEMON_SECRET): no person calls this.
import { claimAgentRequests, completeAgentRequest } from '../../lib/agent-feedback/db.js'
import { parseBody, requireDaemonSecret, type Req, type Res } from './_auth.js'

const MAX_BATCH = 10
const MAX_RESULT = 500

export default async function handler(req: Req, res: Res) {
  if (!requireDaemonSecret(req, res)) return
  try {
    if (req.method === 'GET') {
      res.status(200).json({ requests: await claimAgentRequests(MAX_BATCH) })
      return
    }
    if (req.method === 'POST') {
      const body = parseBody(req)
      const requestId = typeof body.requestId === 'number' ? body.requestId : Number(body.requestId)
      if (!Number.isSafeInteger(requestId) || requestId <= 0) { res.status(400).json({ error: 'requestId required.' }); return }
      if (typeof body.ok !== 'boolean') { res.status(400).json({ error: 'ok (boolean) required.' }); return }
      const result = typeof body.result === 'string' ? body.result.trim().slice(0, MAX_RESULT) || null : null
      const dispatchedTo = typeof body.dispatchedTo === 'string' ? body.dispatchedTo.slice(0, 100) : null
      const recorded = await completeAgentRequest(requestId, body.ok, result, dispatchedTo)
      res.status(200).json({ ok: true, recorded })
      return
    }
    res.status(405).json({ error: 'Method not allowed.' })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Agent request failed.' })
  }
}
