// POST /api/feedback/resolve {id, resolution} -- records the fixer agent's
// conclusion on a dispatched item (status -> resolved). The frame the daemon
// pastes into the fixer tells it to call `feedback-daemon.py --resolve <id>
// "<summary>"`, which hits this. Bearer-secret auth.
import { resolveFeedback } from '../../lib/agent-feedback/db.js'
import { requireDaemonSecret, parseBody, type Req, type Res } from './_auth.js'

const MAX_RESOLUTION = 8000

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }
  if (!requireDaemonSecret(req, res)) return
  const body = parseBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  const resolution = typeof body.resolution === 'string' ? body.resolution.trim().slice(0, MAX_RESOLUTION) : ''
  if (!id || !resolution) { res.status(400).json({ error: 'id and resolution required.' }); return }
  try {
    const found = await resolveFeedback(id, resolution)
    if (!found) { res.status(404).json({ error: 'Not found.' }); return }
    res.status(200).json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to resolve.' })
  }
}
