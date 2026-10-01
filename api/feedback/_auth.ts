// Shared helpers for the daemon-facing feedback endpoints (pending, ack, item,
// list, resolve): Bearer-secret check + body parsing. Underscore-prefixed so
// Vercel does not expose it as a route.
export interface Req { method?: string; body?: unknown; query?: Record<string, string | string[] | undefined>; headers?: Record<string, string | string[] | undefined> }
export interface Res { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void }

function header(req: Req, name: string): string {
  const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

/** Returns true if the request carries the daemon secret; otherwise writes the error response. */
export function requireDaemonSecret(req: Req, res: Res): boolean {
  res.setHeader('Cache-Control', 'no-store')
  const expected = process.env.FEEDBACK_DAEMON_SECRET
  if (!expected) { res.status(500).json({ error: 'FEEDBACK_DAEMON_SECRET is not configured.' }); return false }
  if (header(req, 'authorization') !== `Bearer ${expected}`) { res.status(401).json({ error: 'Unauthorized.' }); return false }
  return true
}

export function parseBody(req: Req): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return {} } }
  return {}
}

export function queryParam(req: Req, name: string): string {
  const v = req.query?.[name]
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}
