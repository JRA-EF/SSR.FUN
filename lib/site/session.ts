// Closed-beta site session (DEC-0187). Runtime-agnostic (Web Crypto only) so
// the exact same code runs in middleware.ts (Edge) and api/site/login.ts
// (Node) -- same discipline as lib/dashboard/session.ts, which this file
// deliberately does NOT modify: the /internal/* dashboard session keeps its
// own cookie, TTL and format untouched.
//
// Model: a visitor redeems one BETA key from a configured LIST. The keys are
//   SSR_BETA_KEYS   -- comma-separated list of accepted keys (the beta list)
//   SSR_SITE_PASSWORD -- still accepted as a key (so existing holders keep
//                        working) AND is the HMAC signing secret for every
//                        session cookie, whichever key was redeemed.
// The cookie is stateless and signed: `${expiresAt}.${keyTag}.${sig}` where
// keyTag identifies WHICH key was redeemed (first 12 hex chars of its
// SHA-256). Verification requires the tag to still match a currently
// configured key, so removing a key from SSR_BETA_KEYS revokes every session
// that was opened with it -- the one property a shared password could never
// offer a closed beta. Sessions last SITE_SESSION_TTL_MS (30 days, per the
// Creator's 2026-09-07 decision), not the dashboard's 12 hours.

export const SITE_SESSION_COOKIE_NAME = 'ssr_site_session'
export const SITE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const enc = new TextEncoder()

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(message))
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
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

/** Every key that currently opens the site: SSR_BETA_KEYS entries (trimmed, non-empty) plus SSR_SITE_PASSWORD. Order is irrelevant; duplicates are harmless. */
export function configuredBetaKeys(env: { SSR_BETA_KEYS?: string; SSR_SITE_PASSWORD?: string } = process.env): string[] {
  const keys = (env.SSR_BETA_KEYS ?? '')
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0)
  const sitePassword = (env.SSR_SITE_PASSWORD ?? '').trim()
  if (sitePassword) keys.push(sitePassword)
  return keys
}

/** The signing secret for session cookies. SSR_SITE_PASSWORD is already the trusted secret this deployment holds; an empty value disables sign-in entirely (login returns 500, middleware rejects every cookie). */
export function siteSessionSecret(env: { SSR_SITE_PASSWORD?: string } = process.env): string {
  return env.SSR_SITE_PASSWORD ?? ''
}

/** Returns the configured key that `submitted` matches, or null. Constant-time per candidate; the candidate count is not secret. */
export function matchBetaKey(submitted: string, keys: string[]): string | null {
  let matched: string | null = null
  for (const key of keys) {
    if (timingSafeEqual(submitted, key)) matched = key
  }
  return matched
}

export async function betaKeyTag(key: string): Promise<string> {
  return (await sha256Hex(`ssr-beta-key:${key}`)).slice(0, 12)
}

export async function createSiteSessionCookieValue(secret: string, redeemedKey: string, ttlMs: number = SITE_SESSION_TTL_MS): Promise<string> {
  const expiresAt = Date.now() + ttlMs
  const keyTag = await betaKeyTag(redeemedKey)
  const sig = await hmacHex(secret, `site-session:${expiresAt}:${keyTag}`)
  return `${expiresAt}.${keyTag}.${sig}`
}

/**
 * True iff the cookie is well-formed, unexpired, signed by `secret`, AND was
 * opened with a key that is STILL in `keys`. Any older-format cookie (the
 * pre-DEC-0187 `${expiresAt}.${sig}` shape) simply fails and the visitor
 * re-enters a key -- an intentional one-time re-login at cutover.
 */
export async function verifySiteSessionCookie(value: string | undefined, secret: string, keys: string[]): Promise<boolean> {
  if (!value || !secret || keys.length === 0) return false
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [expiresAtStr, keyTag, sig] = parts
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  if (!/^[0-9a-f]{12}$/.test(keyTag)) return false
  const expectedSig = await hmacHex(secret, `site-session:${expiresAtStr}:${keyTag}`)
  if (!timingSafeEqual(sig, expectedSig)) return false
  for (const key of keys) {
    if (timingSafeEqual(keyTag, await betaKeyTag(key))) return true
  }
  return false
}

export function buildSiteSetCookie(value: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  const attrs = [`${SITE_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${opts.maxAgeSeconds}`]
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}
