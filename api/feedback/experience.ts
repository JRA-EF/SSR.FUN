// POST /api/feedback/experience -- the in-app "How did we do?" feedback
// (src/merge/components/feedback/*, page #/feedback). Stores a 1-5 rating, a
// required short summary, optional details and an optional snapshot in the team's Google Sheet: the
// row and the image are written by a Google Apps Script web app that runs as
// the sheet's owner (tools/feedback-sheet/Code.gs), so no Google credential
// lives in this project. Env: FEEDBACK_SHEET_WEBHOOK_URL (the script's /exec
// URL) and FEEDBACK_SHEET_SECRET (shared with the script's Script Properties).
//
// Unlike api/feedback/submit.ts this path is NOT in the middleware's public
// list, so only visitors with a redeemed beta key reach it; the same burst +
// durable rate limits as the public form bound a noisy session.
import { checkBurstWindow, checkDurableWindow, rateLimitVerdict } from '../../lib/agent-feedback/rateLimit.js'
import { parseExperience, sheetSafe } from '../../lib/agent-feedback/experiencePure.js'

interface Req { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> }
interface Res {
  status: (n: number) => Res
  json: (b: unknown) => void
  setHeader: (k: string, v: string) => void
  end: () => void
}

const BURST_WINDOW_MS = 10 * 60_000
const BURST_MAX = 5
const IP_WINDOW_MS = 60 * 60_000
const IP_MAX = 10
const GLOBAL_WINDOW_MS = 60 * 60_000
const GLOBAL_MAX = 200

function parseBody(req: Req): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return {} } }
  return {}
}
function header(req: Req, name: string): string {
  const v = req.headers?.[name]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }

  const webhook = process.env.FEEDBACK_SHEET_WEBHOOK_URL
  const secret = process.env.FEEDBACK_SHEET_SECRET
  if (!webhook || !secret) {
    console.error('[feedback/experience] FEEDBACK_SHEET_WEBHOOK_URL or FEEDBACK_SHEET_SECRET is not set')
    res.status(503).json({ error: 'Feedback is temporarily unavailable. Please try again later.' })
    return
  }

  const parsed = parseExperience(parseBody(req))
  // Explicit `=== false`: Vercel's build typecheck does not narrow on `!parsed.ok`.
  if (parsed.ok === false) { res.status(400).json({ error: parsed.error }); return }
  const fb = parsed.value

  const ip = header(req, 'x-forwarded-for').split(',')[0].trim() || 'unknown'
  const burstOk = checkBurstWindow(`feedback-experience:${ip}`, BURST_WINDOW_MS, BURST_MAX)
  let ipOk = true
  let globalOk = true
  if (burstOk) {
    const [ipWin, globalWin] = await Promise.all([
      checkDurableWindow(`feedback-experience:ip:${ip}`, IP_WINDOW_MS, IP_MAX),
      checkDurableWindow('feedback-experience:global', GLOBAL_WINDOW_MS, GLOBAL_MAX),
    ])
    ipOk = ipWin.allowed
    globalOk = globalWin.allowed
  }
  if (rateLimitVerdict(burstOk, ipOk, globalOk) !== 'ok') {
    res.setHeader('Retry-After', '600')
    res.status(429).json({ error: 'You have sent a lot of feedback in a short time. Please try again in a few minutes.' })
    return
  }

  const id = crypto.randomUUID()
  const payload = {
    secret,
    id,
    receivedAt: new Date().toISOString(),
    rating: fb.rating,
    trigger: fb.trigger,
    action: fb.action ?? '',
    subject: sheetSafe(fb.subject),
    details: sheetSafe(fb.details),
    pageUrl: sheetSafe(fb.pageUrl ?? ''),
    site: header(req, 'host'),
    wallet: fb.wallet ?? '',
    userAgent: sheetSafe(header(req, 'user-agent').slice(0, 300)),
    screenshot: fb.screenshot,
  }

  try {
    // Apps Script answers a POST with a 302 to a one-time result URL; fetch
    // follows it with a GET, which is how the script's JSON reply is read.
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
    const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!r.ok || !j?.ok) {
      console.error('[feedback/experience] sheet write failed:', r.status, j?.error ?? '(no JSON reply)')
      res.status(502).json({ error: 'We could not save your feedback just now. Please try again.' })
      return
    }
    res.status(201).json({ ok: true, id })
  } catch (e) {
    console.error('[feedback/experience] sheet request failed:', e instanceof Error ? e.message : e)
    res.status(502).json({ error: 'We could not save your feedback just now. Please try again.' })
  }
}
