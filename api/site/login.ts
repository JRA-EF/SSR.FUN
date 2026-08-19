// POST /api/site/login -- verifies SSR_SITE_PASSWORD server-side and sets a
// signed, HttpOnly session cookie gating the ENTIRE public site (see
// middleware.ts). Mirrors api/dashboard/login.ts's rate-limit/lockout
// pattern exactly, with its own independent password, cookie, and attempt
// tracker -- entering the site password never grants /internal/* access,
// and vice versa (see docs/project/DECISION_LOG.md's site-gate entry).
import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { buildSetCookie, createSessionCookieValue, isSecureEnvironment, SESSION_TTL_MS, timingSafeEqual } from '../../lib/dashboard/session.js'

export const SITE_SESSION_COOKIE_NAME = 'ssr_site_session'

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

function parseBody(req: DashboardRequest): { password?: unknown } {
  if (req.body && typeof req.body === 'object') return req.body as { password?: unknown }
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

  const configuredPassword = process.env.SSR_SITE_PASSWORD ?? ''
  if (!configuredPassword) {
    res.status(500).json({ error: 'Site password is not configured.' })
    return
  }

  const limitEnabled = rateLimitEnabled()
  const key = clientKey(req)
  const now = Date.now()
  const state = limitEnabled ? attemptsByClient.get(key) : undefined

  if (limitEnabled && state?.lockedUntil && state.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((state.lockedUntil - now) / 1000)
    res.setHeader('Retry-After', String(retryAfterSeconds))
    res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfterSeconds })
    return
  }

  const { password } = parseBody(req)
  const submitted = typeof password === 'string' ? password : ''

  if (!timingSafeEqual(submitted, configuredPassword)) {
    if (limitEnabled) {
      const withinWindow = !!state && now - state.windowStart < ATTEMPT_WINDOW_MS
      const nextCount = (withinWindow ? state!.count : 0) + 1
      const windowStart = withinWindow ? state!.windowStart : now

      if (nextCount >= MAX_ATTEMPTS_PER_WINDOW) {
        attemptsByClient.set(key, { count: 0, windowStart: now, lockedUntil: now + LOCKOUT_MS })
        const retryAfterSeconds = Math.ceil(LOCKOUT_MS / 1000)
        res.setHeader('Retry-After', String(retryAfterSeconds))
        res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfterSeconds })
        return
      }

      attemptsByClient.set(key, { count: nextCount, windowStart })
    }
    res.status(401).json({ error: 'Incorrect password.' })
    return
  }

  attemptsByClient.delete(key)
  const cookieValue = await createSessionCookieValue(configuredPassword, SESSION_TTL_MS)
  res.setHeader(
    'Set-Cookie',
    buildSetCookie(SITE_SESSION_COOKIE_NAME, cookieValue, { maxAgeSeconds: SESSION_TTL_MS / 1000, secure: isSecureEnvironment() }),
  )
  res.status(200).json({ ok: true })
}
