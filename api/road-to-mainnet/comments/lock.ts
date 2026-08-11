// POST /api/road-to-mainnet/comments/lock
// Locks every currently-open comment across every entity in one action --
// "the 1st pass ones get locked", as a single event for a whole round of
// feedback rather than a per-item toggle. Never touches the status/evidence/
// notes fields, and never deletes/edits a comment's own text -- only stamps
// locked_at so the frontend renders it read-only from then on. The very
// next comment posted anywhere automatically starts the next open pass
// (see lib/road-to-mainnet/store.ts's addComment/currentOpenPass).
import type { DashboardRequest, DashboardResponse } from '../../../lib/dashboard/http.js'
import { isAuthenticated, isSameOriginRequest, unauthorized } from '../../../lib/road-to-mainnet/auth.js'
import { lockOpenComments } from '../../../lib/road-to-mainnet/store.js'

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  if (!(await isAuthenticated(req))) {
    unauthorized(res)
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: 'Cross-site request rejected.' })
    return
  }

  res.setHeader('Cache-Control', 'no-store')
  const lockedCount = await lockOpenComments()
  res.status(200).json({ lockedCount })
}
