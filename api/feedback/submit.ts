// POST /api/feedback/submit -- public endpoint the feedback form posts to.
// Stores one feedback item (status 'new'); the local agent-feedback daemon
// later claims it via /api/feedback/pending and raises it to a human on
// Telegram for approval. Public, no auth (it only ever CREATES a queued item;
// nothing is acted on until a human approves it in Telegram).
import { insertFeedback } from '../../lib/agent-feedback/db.js'

interface Req { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> }
interface Res {
  status: (n: number) => Res
  json: (b: unknown) => void
  setHeader: (k: string, v: string) => void
  end: () => void
}

const MAX_MESSAGE = 4000
const MAX_FIELD = 400

function parseBody(req: Req): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return {} } }
  return {}
}
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

export default async function handler(req: Req, res: Res) {
  // Permissive CORS: the form may be served from a different origin.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }

  const body = parseBody(req)
  const message = str(body.message, MAX_MESSAGE)
  if (!message) { res.status(400).json({ error: 'A feedback message is required.' }); return }
  const category = str(body.category, 40) ?? 'general'
  const contact = str(body.contact, MAX_FIELD)
  const pageUrl = str(body.pageUrl ?? body.page_url, MAX_FIELD)

  try {
    const id = await insertFeedback({ category, message, contact, pageUrl })
    res.status(201).json({ ok: true, id })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to store feedback.' })
  }
}
