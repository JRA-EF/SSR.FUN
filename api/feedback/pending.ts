// GET /api/feedback/pending -- the local daemon polls this to claim new
// feedback (atomically flips new->raised and returns the items). Protected by
// a shared secret: `Authorization: Bearer $FEEDBACK_DAEMON_SECRET`. This only
// READS/claims the queue; it never acts on anything (a human still approves
// each item in Telegram before it reaches an agent).
import { claimNewFeedback } from '../../lib/agent-feedback/db.js'

interface Req { method?: string; headers?: Record<string, string | string[] | undefined> }
interface Res { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void }

function header(req: Req, name: string): string {
  const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

const MAX_BATCH = 10

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed.' }); return }

  const expected = process.env.FEEDBACK_DAEMON_SECRET
  if (!expected) { res.status(500).json({ error: 'FEEDBACK_DAEMON_SECRET is not configured.' }); return }
  if (header(req, 'authorization') !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'Unauthorized.' }); return
  }

  try {
    const rows = await claimNewFeedback(MAX_BATCH)
    res.status(200).json({ items: rows })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to read queue.' })
  }
}
