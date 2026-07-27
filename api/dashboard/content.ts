// GET /api/dashboard/content -- the dashboard's only data source. Reads the
// two source-of-truth Markdown files fresh on every request (no caching, no
// duplicated data in the frontend) and returns them parsed as JSON.
//
// Independently re-verifies the session cookie (middleware.ts already blocks
// unauthenticated requests to this exact path, but this function must never
// depend solely on that -- see task requirement: enforce access server-side,
// not just at one layer).

import fs from 'node:fs'
import path from 'node:path'
import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { parseCookie, SESSION_COOKIE_NAME, verifySessionCookie } from '../../lib/dashboard/session.js'
import { parseDecisionLog, parseProjectStatus } from '../../lib/dashboard/parseMarkdown.js'

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  const configuredPassword = process.env.SSR_DASHBOARD_PASSWORD ?? ''
  const cookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie
  const sessionValue = parseCookie(cookieHeader, SESSION_COOKIE_NAME)
  const authenticated = await verifySessionCookie(sessionValue, configuredPassword)

  if (!authenticated) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const statusMarkdown = fs.readFileSync(path.join(process.cwd(), 'docs/project/PROJECT_STATUS.md'), 'utf8')
  const decisionMarkdown = fs.readFileSync(path.join(process.cwd(), 'docs/project/DECISION_LOG.md'), 'utf8')

  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    status: parseProjectStatus(statusMarkdown),
    decisions: parseDecisionLog(decisionMarkdown),
  })
}
