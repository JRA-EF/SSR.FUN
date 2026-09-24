// POST /api/feedback/ack -- the daemon calls this after a human decision, to
// mark an item 'dispatched' (injected to an agent) or 'dismissed', recording
// WHO decided (`handledBy`, the Telegram "@handle (id)" that tapped). Protected
// by the same shared secret as /pending.
import { markStatus } from '../../lib/agent-feedback/db.js'
import { requireDaemonSecret, parseBody, type Req, type Res } from './_auth.js'

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }
  if (!requireDaemonSecret(req, res)) return

  const body = parseBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  const status = body.status === 'dispatched' || body.status === 'dismissed' ? body.status : ''
  const dispatchedTo = typeof body.dispatchedTo === 'string' ? body.dispatchedTo : null
  const handledBy = typeof body.handledBy === 'string' ? body.handledBy.slice(0, 200) : null
  if (!id || !status) { res.status(400).json({ error: 'id and status (dispatched|dismissed) required.' }); return }

  try {
    await markStatus(id, status, dispatchedTo, handledBy)
    res.status(200).json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to update.' })
  }
}
