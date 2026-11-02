// Input rules for the public BETA key claim (DEC-0276, api/site/claim.ts).
// Pure and dependency-free so tests/phase_beta_gate.mjs can import it directly.

export interface BetaClaimInput {
  /** X handle without the @, as typed (case kept for display). */
  handle: string
  /** Lower-cased handle: X handles are case-insensitive, so this is the one-key-per-handle identity. */
  handleLower: string
  email: string | null
}

export type ParseResult = { ok: true; value: BetaClaimInput } | { ok: false; error: string }

// X's own rule: 1-15 letters, digits or underscores.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/
// Deliberately loose: one @, a dot in the domain, no spaces. Optional field.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Accepts "@name", "name", or a pasted profile link (x.com/name, twitter.com/name). */
export function normalizeHandle(raw: string): string {
  let h = raw.trim()
  const link = h.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i)
  if (link) h = link[1]
  return h.replace(/^@+/, '')
}

export function parseBetaClaim(body: Record<string, unknown>): ParseResult {
  const rawHandle = typeof body.handle === 'string' ? body.handle : ''
  const handle = normalizeHandle(rawHandle)
  if (!handle) return { ok: false, error: 'Enter your X handle.' }
  if (!HANDLE_RE.test(handle)) return { ok: false, error: 'That doesn’t look like an X handle. Use letters, numbers and underscores, up to 15 characters.' }

  const rawEmail = typeof body.email === 'string' ? body.email.trim() : ''
  if (rawEmail && (rawEmail.length > 254 || !EMAIL_RE.test(rawEmail))) return { ok: false, error: 'That email address doesn’t look right. You can also leave it empty.' }

  return { ok: true, value: { handle, handleLower: handle.toLowerCase(), email: rawEmail ? rawEmail.toLowerCase() : null } }
}

/** Keeps user text as text in Google Sheets: a cell starting with = + - @ would run as a formula. */
export function sheetSafe(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v
}
