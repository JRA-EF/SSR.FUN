// POST /api/site/login -- redeems a closed-beta key (DEC-0187) and sets the
// signed, HttpOnly session cookie that gates the ENTIRE public site (see
// middleware.ts). Accepted keys are the SSR_BETA_KEYS list (30-day sessions),
// the SSR_TEAM_KEYS list (400-day sessions) and SSR_SITE_PASSWORD (see
// lib/site/session.ts for the model and why the cookie records which key was
// redeemed). Mirrors
// api/dashboard/login.ts's rate-limit/lockout pattern exactly, with its own
// independent cookie and attempt tracker -- redeeming a beta key never grants
// /internal/* access, and vice versa.
import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { isSecureEnvironment } from '../../lib/dashboard/session.js'
import {
  betaKeyTag,
  buildSiteSetCookie,
  configuredAccessKeys,
  configuredTeamKeys,
  createSiteSessionCookieValue,
  issuedKeySecret,
  issuedSessionAnchor,
  matchBetaKey,
  verifyIssuedKey,
  sessionTtlForKey,
  SITE_SESSION_COOKIE_NAME,
  siteSessionSecret,
  timingSafeEqual,
} from '../../lib/site/session.js'
import { markUsedInSheet, recordListedKeyRedemption, recordRedemption, type ListedKeyKind } from '../../lib/site/betaClaims.js'

export { SITE_SESSION_COOKIE_NAME }

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function rateLimitEnabled(): boolean {
  const override = process.env.SSR_SITE_RATE_LIMIT_ENABLED
  if (override === 'true') return true
  if (override === 'false') return false
  return process.env.VERCEL_ENV === 'production'
}

const ATTEMPT_WINDOW_MS = envInt('SSR_SITE_ATTEMPT_WINDOW_MINUTES', 10) * 60 * 1000
const MAX_ATTEMPTS_PER_WINDOW = envInt('SSR_SITE_MAX_ATTEMPTS', 10)
const LOCKOUT_MS = envInt('SSR_SITE_LOCKOUT_MINUTES', 15) * 60 * 1000

interface AttemptState {
  count: number
  windowStart: number
  lockedUntil?: number
}

const attemptsByClient = new Map<string, AttemptState>()

function clientKey(req: DashboardRequest): string {
  const forwardedFor = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
  return raw?.split(',')[0]?.trim() || 'unknown'
}

// The Coming Soon page posts `{ key }`; the pre-DEC-0187 sign-in form (and
// any bookmarked tooling) posted `{ password }`. Both name the same thing.
function parseBody(req: DashboardRequest): { key?: unknown; password?: unknown } {
  if (req.body && typeof req.body === 'object') return req.body as { key?: unknown; password?: unknown }
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return {}
    }
  }
  return {}
}

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const secret = siteSessionSecret()
  const keys = configuredAccessKeys()
  const issueSecret = issuedKeySecret()
  if (!secret || (keys.length === 0 && !issueSecret)) {
    res.status(500).json({ error: 'Beta access is not configured.' })
    return
  }

  const limitEnabled = rateLimitEnabled()
  const client = clientKey(req)
  const now = Date.now()
  const state = limitEnabled ? attemptsByClient.get(client) : undefined

  if (limitEnabled && state?.lockedUntil && state.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((state.lockedUntil - now) / 1000)
    res.setHeader('Retry-After', String(retryAfterSeconds))
    res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfterSeconds })
    return
  }

  const body = parseBody(req)
  const raw = typeof body.key === 'string' ? body.key : typeof body.password === 'string' ? body.password : ''
  const submitted = raw.trim()
  // DEC-0276: a key from the public claim page (/beta) is not in any env list;
  // it proves itself by its MAC, and its session is tagged with the shared
  // issued-key anchor so the middleware can verify it without a database.
  let redeemed = submitted ? matchBetaKey(submitted, keys) : null
  let issuedKey: string | null = null
  if (!redeemed && submitted && issueSecret) {
    issuedKey = await verifyIssuedKey(submitted)
    if (issuedKey) redeemed = issuedSessionAnchor(issueSecret)
  }

  if (!redeemed) {
    if (limitEnabled) {
      const withinWindow = !!state && now - state.windowStart < ATTEMPT_WINDOW_MS
      const nextCount = (withinWindow ? state!.count : 0) + 1
      const windowStart = withinWindow ? state!.windowStart : now

      if (nextCount >= MAX_ATTEMPTS_PER_WINDOW) {
        attemptsByClient.set(client, { count: 0, windowStart: now, lockedUntil: now + LOCKOUT_MS })
        const retryAfterSeconds = Math.ceil(LOCKOUT_MS / 1000)
        res.setHeader('Retry-After', String(retryAfterSeconds))
        res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfterSeconds })
        return
      }

      attemptsByClient.set(client, { count: nextCount, windowStart })
    }
    res.status(401).json({ error: "That BETA key isn't valid." })
    return
  }

  attemptsByClient.delete(client)
  const ttlMs = sessionTtlForKey(redeemed)
  const cookieValue = await createSiteSessionCookieValue(secret, redeemed, ttlMs)
  res.setHeader('Set-Cookie', buildSiteSetCookie(cookieValue, { maxAgeSeconds: ttlMs / 1000, secure: isSecureEnvironment() }))
  // Bookkeeping only (first/last redemption on the claim row); never blocks entry.
  if (issuedKey) {
    const key = issuedKey
    await recordRedemption(key)
      .then(first => (first ? markUsedInSheet(key) : undefined))
      .catch(e => console.error('[site/login] redemption not recorded:', e instanceof Error ? e.message : e))
  } else {
    // Env-list key (wave 1 BETA, TEAM or the site password): count its sign-ins
    // by tag, and mark a BETA key Used in the key Sheet on its first sign-in.
    const key = redeemed
    const sitePassword = (process.env.SSR_SITE_PASSWORD ?? '').trim()
    const kind: ListedKeyKind = sitePassword && timingSafeEqual(key, sitePassword)
      ? 'password'
      : configuredTeamKeys().some(k => timingSafeEqual(key, k)) ? 'team' : 'beta'
    await betaKeyTag(key)
      .then(tag => recordListedKeyRedemption(tag, kind))
      .then(first => (first && kind === 'beta' ? markUsedInSheet(key) : undefined))
      .catch(e => console.error('[site/login] key use not recorded:', e instanceof Error ? e.message : e))
  }
  res.status(200).json({ ok: true })
}
