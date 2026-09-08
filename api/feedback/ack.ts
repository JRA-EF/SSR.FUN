// POST /api/feedback/ack -- the daemon calls this after a human decision, to
// mark an item 'dispatched' (injected to an agent) or 'dismissed'. Protected
// by the same shared secret as /pending.
import { markStatus } from '../../lib/agent-feedback/db.js'

interface Req { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> }
interface Res { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void }

function header(req: Req, name: string): string {
  const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}
function parseBody(req: Req): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return {} } }
  return {}
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }

  const expected = process.env.FEEDBACK_DAEMON_SECRET
  if (!expected) { res.status(500).json({ error: 'FEEDBACK_DAEMON_SECRET is not configured.' }); return }
  if (header(req, 'authorization') !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'Unauthorized.' }); return
  }

  const body = parseBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  const status = body.status === 'dispatched' || body.status === 'dismissed' ? body.status : ''
  const dispatchedTo = typeof body.dispatchedTo === 'string' ? body.dispatchedTo : null
  if (!id || !status) { res.status(400).json({ error: 'id and status (dispatched|dismissed) required.' }); return }

  try {
    await markStatus(id, status, dispatchedTo)
    res.status(200).json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to update.' })
  }
}
