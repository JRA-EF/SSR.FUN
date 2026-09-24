// POST /api/feedback/submit -- PUBLIC endpoint the feedback form (/feedback)
// posts to. Stores one feedback item (status 'new'); the local agent-feedback
// daemon later claims it via /api/feedback/pending and raises it to a human
// on Telegram for approval. Nothing is acted on until a human approves it.
//
// Being reachable without the site password, it is protected two ways:
//   1. Vercel BotID (checkBotId): the form page's initBotId() attaches an
//      invisible classification to the request; a bot gets 403. Requires the
//      project's OIDC token option and the vercel.json BotID proxy rewrites.
//   2. Rate limits: per-IP burst (in-memory, 5 per 10 min per warm instance)
//      + DURABLE per-IP (10 per hour) and global (120 per hour) windows in
//      Neon (lib/agent-feedback/rateLimit.ts, same table as lib/rate-limit), so a hammering client is
//      bounded across serverless instances.
import type { IncomingHttpHeaders } from 'node:http'
import { checkBotId } from 'botid/server'
import { insertFeedback } from '../../lib/agent-feedback/db.js'
import { checkBurstWindow, checkDurableWindow, rateLimitVerdict } from '../../lib/agent-feedback/rateLimit.js'

interface Req { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> }
interface Res {
  status: (n: number) => Res
  json: (b: unknown) => void
  setHeader: (k: string, v: string) => void
  end: () => void
}

const MAX_MESSAGE = 4000
const MAX_FIELD = 400
const BURST_WINDOW_MS = 10 * 60_000
const BURST_MAX = 5
const IP_WINDOW_MS = 60 * 60_000
const IP_MAX = 10
const GLOBAL_WINDOW_MS = 60 * 60_000
const GLOBAL_MAX = 120

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
function clientIp(req: Req): string {
  const fwd = req.headers?.['x-forwarded-for']
  const raw = Array.isArray(fwd) ? fwd[0] : fwd
  return (raw ?? 'unknown').split(',')[0].trim()
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }

  // --- Rate limits (cheap checks first, durable ones after) ---
  const ip = clientIp(req)
  const burstOk = checkBurstWindow(`feedback-submit:${ip}`, BURST_WINDOW_MS, BURST_MAX)
  let ipOk = true
  let globalOk = true
  if (burstOk) {
    const [ipWin, globalWin] = await Promise.all([
      checkDurableWindow(`feedback-submit:ip:${ip}`, IP_WINDOW_MS, IP_MAX),
      checkDurableWindow('feedback-submit:global', GLOBAL_WINDOW_MS, GLOBAL_MAX),
    ])
    ipOk = ipWin.allowed
    globalOk = globalWin.allowed
  }
  const verdict = rateLimitVerdict(burstOk, ipOk, globalOk)
  if (verdict !== 'ok') {
    res.setHeader('Retry-After', verdict === 'burst' ? '600' : '3600')
    res.status(429).json({ error: verdict === 'global' ? 'Feedback is receiving a lot of submissions right now -- please try again later.' : 'Too many submissions from your network -- please try again later.' })
    return
  }

  // --- Bot check (Vercel BotID) ---
  try {
    const verdictBot = await checkBotId({ advancedOptions: { headers: req.headers as IncomingHttpHeaders } })
    if (verdictBot.isBot && !verdictBot.isVerifiedBot) {
      res.status(403).json({ error: 'Automated submissions are not accepted.' })
      return
    }
  } catch (e) {
    // Misconfiguration (OIDC/proxy) must never silently open the endpoint to
    // bots, nor silently drop humans: fail closed with a clear server-side log.
    console.error('[feedback] BotID check failed:', e instanceof Error ? e.message : e)
    res.status(503).json({ error: 'Feedback is temporarily unavailable.' })
    return
  }

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
