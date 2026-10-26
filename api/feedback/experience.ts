// POST /api/feedback/experience -- the in-app "How did we do?" feedback
// (src/merge/components/feedback/*, page #/feedback). Stores a 1-5 rating, a
// required short summary, optional details and an optional snapshot in the team's Google Sheet: the
// row and the image are written by a Google Apps Script web app that runs as
// the sheet's owner (tools/feedback-sheet/Code.gs), so no Google credential
// lives in this project. Env: FEEDBACK_SHEET_WEBHOOK_URL (the script's /exec
// URL) and FEEDBACK_SHEET_SECRET (shared with the script's Script Properties).
//
// Unlike api/feedback/submit.ts this path is NOT in the middleware's public
// list, so only visitors with a redeemed beta key reach it. Each IP may send
// one submission per 5 minutes and three per 24 hours (DEC-0260), under a
// site-wide hourly ceiling.
import { checkBurstWindow, checkDurableWindow } from '../../lib/agent-feedback/rateLimit.js'
import { parseExperience, sheetSafe } from '../../lib/agent-feedback/experiencePure.js'

interface Req { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> }
interface Res {
  status: (n: number) => Res
  json: (b: unknown) => void
  setHeader: (k: string, v: string) => void
  end: () => void
}

const IP_SHORT_WINDOW_MS = 5 * 60_000
const IP_SHORT_MAX = 1
const IP_DAY_WINDOW_MS = 24 * 60 * 60_000
const IP_DAY_MAX = 3
const GLOBAL_WINDOW_MS = 60 * 60_000
const GLOBAL_MAX = 200
const TOO_SOON = 'You can send feedback once every 5 minutes. Please try again shortly.'
const DAY_CAP = 'You can send up to 3 pieces of feedback a day. Please try again tomorrow.'

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
  const refuse = (retryAfterS: number, error: string) => {
    res.setHeader('Retry-After', String(retryAfterS))
    res.status(429).json({ error })
  }
  // Checked one after another, shortest window first, so a refused attempt
  // never spends one of the day's three slots. The in-memory check catches a
  // rapid repeat on a warm instance without a database round trip; the Neon
  // windows hold across instances (and fail open if Neon is unreachable).
  if (!checkBurstWindow(`feedback-experience:${ip}`, IP_SHORT_WINDOW_MS, IP_SHORT_MAX)) return refuse(300, TOO_SOON)
  if (!(await checkDurableWindow(`feedback-experience:ip5m:${ip}`, IP_SHORT_WINDOW_MS, IP_SHORT_MAX)).allowed) return refuse(300, TOO_SOON)
  if (!(await checkDurableWindow(`feedback-experience:ipday:${ip}`, IP_DAY_WINDOW_MS, IP_DAY_MAX)).allowed) return refuse(86_400, DAY_CAP)
  if (!(await checkDurableWindow('feedback-experience:global', GLOBAL_WINDOW_MS, GLOBAL_MAX)).allowed) {
    return refuse(3600, 'Feedback is receiving a lot of submissions right now. Please try again later.')
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
