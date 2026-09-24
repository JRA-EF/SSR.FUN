// GET /api/feedback/list?status=<optional>&limit=<n> -- newest-first listing of
// every feedback item ever submitted (the permanent record). Bearer-secret
// auth; the daemon's --list / --export flags read this.
import { listFeedback } from '../../lib/agent-feedback/db.js'
import { requireDaemonSecret, queryParam, type Req, type Res } from './_auth.js'

const STATUSES = new Set(['new', 'raised', 'dispatched', 'dismissed', 'resolved'])

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed.' }); return }
  if (!requireDaemonSecret(req, res)) return
  const statusRaw = queryParam(req, 'status')
  const status = STATUSES.has(statusRaw) ? statusRaw : null
  const limit = Math.min(Math.max(Number(queryParam(req, 'limit')) || 200, 1), 1000)
  try {
    res.status(200).json({ items: await listFeedback(limit, status) })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to list.' })
  }
}
