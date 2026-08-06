// Auth + same-origin helpers shared by api/road-to-mainnet/*.ts. Reuses the
// exact SSR_DASHBOARD_PASSWORD session cookie as /internal/status -- a
// single login covers both pages, and there is deliberately no separate
// identity/role system for this page (see docs/project/DECISION_LOG.md
// entry for this feature).

import type { DashboardRequest, DashboardResponse } from '../dashboard/http.js'
import { parseCookie, SESSION_COOKIE_NAME, verifySessionCookie } from '../dashboard/session.js'

export type { DashboardRequest, DashboardResponse }

export async function isAuthenticated(req: DashboardRequest): Promise<boolean> {
  const configuredPassword = process.env.SSR_DASHBOARD_PASSWORD ?? ''
  const cookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie
  const sessionValue = parseCookie(cookieHeader, SESSION_COOKIE_NAME)
  return verifySessionCookie(sessionValue, configuredPassword)
}

// Defense-in-depth CSRF/cross-site check for state-changing requests, on top
// of the SameSite=Strict session cookie (which already stops the cookie
// from being attached to cross-site requests). Rejects only when an Origin
// header is present and clearly cross-site; a same-origin fetch() always
// sends Origin on POST, so this never blocks legitimate use.
export function isSameOriginRequest(req: DashboardRequest): boolean {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  if (!origin) return true
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function unauthorized(res: DashboardResponse) {
  res.status(401).json({ error: 'Unauthorized' })
}
