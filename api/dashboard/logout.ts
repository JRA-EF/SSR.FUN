// POST /api/dashboard/logout -- clears the session cookie, immediately
// invalidating access (the next request has no valid cookie for middleware
// or content.ts to verify).

import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { buildSetCookie, isSecureEnvironment, SESSION_COOKIE_NAME } from '../../lib/dashboard/session.js'

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  res.setHeader('Set-Cookie', buildSetCookie(SESSION_COOKIE_NAME, '', { maxAgeSeconds: 0, secure: isSecureEnvironment() }))
  res.status(200).json({ ok: true })
}
