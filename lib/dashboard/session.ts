// Shared, runtime-agnostic session helpers for the /internal/status dashboard.
// Uses only Web Crypto (crypto.subtle) so the exact same code runs in both
// middleware.ts (Edge runtime) and the api/dashboard/*.ts functions (Node
// runtime) -- Node 18+ exposes the same Web Crypto global.
//
// The session is a stateless, signed cookie: no database or session store.
// Its HMAC key is the dashboard password itself (SSR_DASHBOARD_PASSWORD),
// which is already the trusted secret -- a valid signature is only producible
// by someone who already knows that password.

export const SESSION_COOKIE_NAME = 'ssr_dash_session'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
  return Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function createSessionCookieValue(password: string, ttlMs: number = SESSION_TTL_MS): Promise<string> {
  const expiresAt = Date.now() + ttlMs
  const sig = await hmacHex(password, `dash-session:${expiresAt}`)
  return `${expiresAt}.${sig}`
}

export async function verifySessionCookie(value: string | undefined, password: string): Promise<boolean> {
  if (!value || !password) return false
  const sepIndex = value.indexOf('.')
  if (sepIndex === -1) return false
  const expiresAtStr = value.slice(0, sepIndex)
  const sig = value.slice(sepIndex + 1)
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  const expectedSig = await hmacHex(password, `dash-session:${expiresAtStr}`)
  return timingSafeEqual(sig, expectedSig)
}

export function parseCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function buildSetCookie(name: string, value: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${opts.maxAgeSeconds}`]
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}

// Vercel exposes VERCEL_ENV as 'production' | 'preview' | 'development' on
// every deployment. Local `vercel dev` runs over plain HTTP, where a Secure
// cookie would never be sent back by the browser -- so Secure is opted in
// only for real (HTTPS) deployments.
export function isSecureEnvironment(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview'
}
