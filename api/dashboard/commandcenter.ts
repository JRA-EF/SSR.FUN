// GET/POST /api/dashboard/commandcenter -- data for /internal/commandcenter
// (DEC-0264): every integration ssr.fun depends on, its status, keys (names
// and ages only), renewals and failure points.
//
// ssr.fun data ONLY. The production deployment of the ssr-fun project runs
// the probes with its own env. Every other deployment (the test site
// strategic-super-reserve.fun, previews, local) never probes itself: it
// forwards the request server-to-server to https://ssr.fun with the shared
// COMMAND_CENTER_TOKEN. So the page shows production wherever it is opened.
//
// Auth: the internal dashboard session (SSR_DASHBOARD_PASSWORD), or the
// COMMAND_CENTER_TOKEN bearer for that forward. middleware.ts lets this path
// past the beta gate (a forwarded request carries no cookie), so the handler
// checks both itself and answers 401 to anything else.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { parseCookie, SESSION_COOKIE_NAME, verifySessionCookie } from '../../lib/dashboard/session.js'
import { parseAction } from '../../lib/command-center/model.js'
import { addWatch, collectCommandCenter, dismissWatch, NODE_IDS, reviewAlert, saveFacts, setFeedbackStatus } from '../../lib/command-center/probes.js'

const PRODUCTION_ORIGIN = 'https://ssr.fun'
const CACHE_MS = 60_000
const MIN_REFRESH_MS = 15_000

let cache: { at: number; body: unknown } | null = null
let inflight: Promise<unknown> | null = null

function header(req: DashboardRequest, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

function sameSecret(given: string, secret: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(h(given), h(secret))
}

/** True only on the ssr-fun project's production deployment (ssr.fun). */
function isProductionSsrFun(): boolean {
  return process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL === 'ssr.fun'
}

async function authorized(req: DashboardRequest): Promise<{ ok: boolean; viaToken: boolean }> {
  const token = process.env.COMMAND_CENTER_TOKEN
  const auth = header(req, 'authorization') ?? ''
  if (token && auth.startsWith('Bearer ') && sameSecret(auth.slice(7), token)) return { ok: true, viaToken: true }
  const password = process.env.SSR_DASHBOARD_PASSWORD ?? ''
  const session = parseCookie(header(req, 'cookie'), SESSION_COOKIE_NAME)
  return { ok: !!password && (await verifySessionCookie(session, password)), viaToken: false }
}

async function forward(req: DashboardRequest, res: DashboardResponse, query: string): Promise<void> {
  const token = process.env.COMMAND_CENTER_TOKEN
  if (!token) {
    res.status(503).json({ error: 'COMMAND_CENTER_TOKEN is not set on this deployment, so it cannot read ssr.fun.' })
    return
  }
  try {
    const r = await fetch(`${PRODUCTION_ORIGIN}/api/dashboard/commandcenter${query}`, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-command-center-forwarded': '1' },
      body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(45_000),
    })
    const text = await r.text()
    res.setHeader('Cache-Control', 'no-store')
    let body: unknown
    try { body = JSON.parse(text) } catch { body = { error: `ssr.fun answered HTTP ${r.status}` } }
    res.status(r.status).json(body)
  } catch (e) {
    res.status(502).json({ error: `Could not reach ssr.fun: ${e instanceof Error ? e.message : String(e)}` })
  }
}

export default async function handler(req: DashboardRequest & { url?: string }, res: DashboardResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }
  const auth = await authorized(req)
  if (!auth.ok) { res.status(401).json({ error: 'Unauthorized' }); return }
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''

  // Local runs can opt in to probing with their own env (tools only, never deployed).
  if (!isProductionSsrFun() && process.env.COMMAND_CENTER_LOCAL !== '1') {
    // A forwarded request that lands on a non-production deployment again would loop.
    if (header(req, 'x-command-center-forwarded')) { res.status(508).json({ error: 'ssr.fun did not recognise itself as production (VERCEL_PROJECT_PRODUCTION_URL).' }); return }
    await forward(req, res, query)
    return
  }

  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body as string) } catch { return null } })() : req.body
    const parsed = parseAction(body, NODE_IDS)
    if (parsed.ok === false) { res.status(400).json({ error: parsed.error }); return }
    const a = parsed.action
    try {
      if (a.kind === 'facts') await saveFacts(a.node, a.facts)
      else if (a.kind === 'watch-add') await addWatch(a.text)
      else if (a.kind === 'feedback-status') await setFeedbackStatus(a.row, a.at, a.status)
      else if (a.kind === 'alert-review') await reviewAlert(a.key, a.outcome)
      else await dismissWatch(a.key)
    } catch (e) {
      res.status(502).json({ error: `Could not save: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    cache = null
  }

  const wantsRefresh = /[?&]refresh=1\b/.test(query)
  const age = cache ? Date.now() - cache.at : Infinity
  if (!cache || age > CACHE_MS || (wantsRefresh && age > MIN_REFRESH_MS) || req.method === 'POST') {
    inflight ??= collectCommandCenter().then((body) => { cache = { at: Date.now(), body }; return body }).finally(() => { inflight = null })
    try {
      await inflight
    } catch (e) {
      res.status(500).json({ error: `Probe run failed: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
  }
  res.status(200).json(cache!.body)
}
