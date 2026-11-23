// Where a visitor was headed when the closed-beta gate stopped them, and the
// path redirects the gate applies before it checks a session. Pure and
// dependency-free: middleware.ts, src/beta/main.ts and
// tests/phase_beta_gate.mjs import it directly. public/coming-soon.html is a
// static page with an inline script, so it carries a small copy of
// safeNextPath / isCampaignDestination (keep the two in step).
//
// A hash route (#/campaign, #/dtr/mainnet-beta-93, #/legal/terms) is never
// sent to the server, so the gate page captures location.hash client-side,
// keeps it in sessionStorage (GATE_NEXT_STORAGE_KEY) and passes it to /beta as
// ?next=, and the claim page sends the visitor there after signing in.

/** sessionStorage key the gate page writes and the /beta page reads. */
export const GATE_NEXT_STORAGE_KEY = 'ssr_gate_next'

const MAX_NEXT_LENGTH = 512

/**
 * A same-site destination (path + optional query + hash) that is safe to
 * navigate to, or null. Rejects anything that could leave the site
 * (absolute URLs, protocol-relative "//host", "/\host"), control characters,
 * over-long values, and the gate's own pages (/beta, the Coming Soon file).
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const next = raw.trim()
  if (!next || next.length > MAX_NEXT_LENGTH) return null
  if (next[0] !== '/' || next[1] === '/' || next[1] === '\\') return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null
  const path = next.split(/[?#]/, 1)[0].replace(/\/+$/, '')
  if (path === '/beta' || path === '/beta.html' || path === '/coming-soon.html') return null
  return next
}

/** True when the destination is the Beta Campaign sign-up (#/campaign or /campaign). */
export function isCampaignDestination(next: string | null | undefined): boolean {
  if (!next) return false
  const hashAt = next.indexOf('#')
  const hash = hashAt >= 0 ? next.slice(hashAt) : ''
  const path = next.split(/[?#]/, 1)[0].replace(/\/+$/, '')
  return path === '/campaign' || /^#\/campaign(?:[/?]|$)/.test(hash)
}

/**
 * Path-only redirects applied before the gate, for signed-in and signed-out
 * visitors alike:
 *   /beta/, /leaderboard/  -> without the trailing slash (the vercel.json
 *                             rewrites and PUBLIC_PATHS match the bare path,
 *                             so the slash form fell through to Coming Soon)
 *   /campaign, /campaign/  -> /#/campaign (the app routes by hash; the bare
 *                             path rendered the home page)
 * Returns the redirect target (query string kept), or null.
 */
export function gatePathRedirect(pathname: string, search = ''): string | null {
  if (pathname === '/beta/' || pathname === '/leaderboard/') return pathname.slice(0, -1) + search
  if (pathname === '/campaign' || pathname === '/campaign/') return '/' + search + '#/campaign'
  return null
}
