// Vercel Routing Middleware -- TWO independent, stacked gates:
//
// 1. SITE-WIDE closed-beta gate (2026-08-19 DEC-0129/0184; reshaped
//    2026-09-07 DEC-0187): the entire public site requires a redeemed BETA
//    key (SSR_BETA_KEYS list, or SSR_SITE_PASSWORD; session cookie
//    ssr_site_session, api/site/login.ts, lib/site/session.ts) -- real funds
//    are involved. A visitor WITHOUT a session is not shown a password form:
//    every page URL is rewritten to the public Coming Soon page
//    (public/coming-soon.html), which carries the "I have a BETA key" entry;
//    redeeming a key sets the cookie and reloads the ORIGINAL URL, so deep
//    links shared with beta users land where they pointed. /api/* paths get a
//    JSON 401 instead. Applies to every route EXCEPT the login endpoint
//    itself, the Coming Soon page's own static files (PUBLIC_PATHS), and the
//    CRON_SECRET-authenticated cron paths below
//    (those are invoked by Vercel's own cron trigger, never a browser, and
//    carry no session cookie at all -- gating them would break every
//    scheduled job).
// 2. INTERNAL-team gate (pre-existing, unchanged): /internal/status,
//    /internal/feedback, /internal/kpis, and /road-to-mainnet (+ their data
//    endpoints) additionally require SSR_DASHBOARD_PASSWORD (session cookie
//    ssr_dash_session, api/dashboard/login.ts) on top of the site-wide gate
//    -- a smaller internal team, not just "anyone with the site password."
//    The two passwords/cookies are completely independent; entering one
//    never grants the other.
//
// Runs before the cache, so an unauthenticated request never reaches any
// page's static bundle or data endpoint -- a login page (or JSON 401 for
// /api/* paths) is the only thing an unauthenticated visitor ever gets.

import { next, rewrite } from '@vercel/functions'
import { verifySessionCookie, parseCookie, SESSION_COOKIE_NAME } from './lib/dashboard/session.js'
import { configuredBetaKeys, siteSessionSecret, SITE_SESSION_COOKIE_NAME, verifySiteSessionCookie } from './lib/site/session.js'

// SITE_SESSION_COOKIE_NAME is imported from lib/site/session.ts (runtime-
// agnostic, Web Crypto only), which api/site/login.ts imports too -- one
// definition, no hand-synced literal.

// Cron paths (see vercel.json's "crons" list) -- authenticated by
// CRON_SECRET inside each handler, never by a browser session. Must never
// be gated by either password gate above.
const CRON_PATHS = new Set([
  '/api/devnet/accrue-fees-cron',
  '/api/kpis/kpis-backfill-cron',
  '/api/ledger/ingest-cron',
  '/api/ledger/reclassify-actors-cron',
  '/api/ledger/jupiter-snapshot-cron',
  '/api/mainnet/warm-cache-cron',
])

const SITE_LOGIN_PATH = '/api/site/login'

// The Coming Soon page (public/coming-soon.html, copied verbatim into the
// build output by Vite) is the ONLY thing an unauthenticated visitor sees at
// any page URL. It is served by REWRITE, not redirect: the address bar keeps
// the URL the visitor asked for, and after a successful key redemption the
// page simply reloads that same URL -- now authenticated -- into the real app.
const COMING_SOON_PATH = '/coming-soon.html'

// Files the Coming Soon page needs that live at the public/ root (not under
// /assets/, which the matcher already excludes). Exact paths only; nothing
// here reveals anything about the gated app.
const PUBLIC_PATHS = new Set([
  COMING_SOON_PATH,
  '/coming-soon-eagle.jpg',
  '/ssr-seal.png',
  '/favicon-seal.png',
  '/apple-touch-seal.png',
  '/favicon.svg',
  '/robots.txt',
])

function comingSoonResponse(request: Request): Response {
  const target = new URL(COMING_SOON_PATH, request.url)
  return rewrite(target, { headers: { 'cache-control': 'no-store' } })
}

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>SSR.fun - Sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0d0b12; color: #eeeaf6;
    font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  form {
    width: 320px; padding: 32px; border-radius: 14px;
    background: #16131d; border: 1px solid rgba(255,255,255,0.07);
    box-shadow: 0 12px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4);
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; color: #eeeaf6; }
  p.sub { font-size: 13px; color: #a89fbb; margin: 0 0 20px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px;
    background: #1b1724; border: 1px solid rgba(255,255,255,0.13); color: #eeeaf6; font-size: 14px;
  }
  input:focus { outline: 2px solid #8b45ff; outline-offset: 1px; }
  button {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: none; cursor: pointer;
    background: #8b45ff; color: #fff; font-size: 14px; font-weight: 600;
  }
  button:hover { background: #9c60ff; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .error { color: #e5586a; font-size: 13px; margin: 12px 0 0; min-height: 16px; }
</style>
</head>
<body>
  <form id="login-form">
    <h1>Internal access</h1>
    <p class="sub">Password required.</p>
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required />
    <button type="submit">Sign in</button>
    <p class="error" id="error"></p>
  </form>
  <script>
    var form = document.getElementById('login-form');
    var errorEl = document.getElementById('error');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var password = form.password.value;
      var button = form.querySelector('button');
      button.disabled = true;
      errorEl.textContent = '';
      fetch('/api/dashboard/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: password }),
      })
        .then(function (res) {
          if (res.ok) { window.location.reload(); return; }
          return res.json().then(function (body) {
            errorEl.textContent = body && body.error ? body.error : 'Sign in failed.';
            button.disabled = false;
          });
        })
        .catch(function () {
          errorEl.textContent = 'Network error. Try again.';
          button.disabled = false;
        });
    });
  </script>
</body>
</html>`

function loginPageResponse(): Response {
  return new Response(LOGIN_PAGE_HTML, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function unauthorizedJson(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

const INTERNAL_API_PATHS = new Set([
  '/api/dashboard/content',
  '/api/road-to-mainnet/state',
  '/api/road-to-mainnet/history',
  '/api/kpis/kpis',
  '/api/kpis/kpis-export',
  '/api/kpis/kpis-refresh',
  '/api/ledger/export',
  '/api/ledger/reconciliation',
])

const INTERNAL_PAGE_PATHS = new Set([
  '/internal/status',
  '/internal-status.html',
  '/internal/feedback',
  '/internal-feedback.html',
  '/road-to-mainnet',
  '/road-to-mainnet.html',
  '/internal/kpis',
  '/internal-kpis.html',
])

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const isApiPath = url.pathname.startsWith('/api/')

  // Cron trigger requests, the site-login endpoint itself, and the Coming
  // Soon page's own files are never gated -- see the header comment above.
  if (CRON_PATHS.has(url.pathname) || url.pathname === SITE_LOGIN_PATH || PUBLIC_PATHS.has(url.pathname)) return next()

  const cookieHeader = request.headers.get('cookie')

  // Gate 1: site-wide. Applies to every remaining route. Temporarily
  // disableable via SSR_SITE_GATE_ENABLED=false (explicit request, 2026-08-20
  // -- see docs/project/DECISION_LOG.md) without touching Gate 2 below, which
  // stays exactly as strict as before. Defaults to enabled (unset/anything
  // other than the literal string 'false' behaves exactly as before this
  // toggle existed) so this is a no-op change until the env var is actually
  // set. Re-enable by removing the env var or setting it back to 'true'.
  if (process.env.SSR_SITE_GATE_ENABLED !== 'false') {
    const siteSessionValue = parseCookie(cookieHeader, SITE_SESSION_COOKIE_NAME)
    const siteAuthenticated = await verifySiteSessionCookie(siteSessionValue, siteSessionSecret(), configuredBetaKeys())

    if (!siteAuthenticated) {
      return isApiPath ? unauthorizedJson() : comingSoonResponse(request)
    }
  }

  // Gate 2: internal-team, additional, only for the specific pre-existing
  // internal paths -- unchanged from before this pass.
  if (INTERNAL_API_PATHS.has(url.pathname) || INTERNAL_PAGE_PATHS.has(url.pathname)) {
    const dashPassword = process.env.SSR_DASHBOARD_PASSWORD ?? ''
    const dashSessionValue = parseCookie(cookieHeader, SESSION_COOKIE_NAME)
    const dashAuthenticated = await verifySessionCookie(dashSessionValue, dashPassword)

    if (!dashAuthenticated) {
      return INTERNAL_API_PATHS.has(url.pathname) ? unauthorizedJson() : loginPageResponse()
    }
  }

  return next()
}

export const config = {
  matcher: [
    // Every route is gated by the site-wide password now (see header
    // comment) -- this negative-lookahead excludes only genuinely static,
    // content-addressed build assets (safe to leave unauthenticated: a
    // fingerprinted JS/CSS/image URL reveals nothing on its own without
    // already having an authenticated page that references it) plus the
    // cron/login paths the middleware function itself also exempts above
    // (listed there too since Response objects can't be constructed for a
    // route this matcher never invokes middleware for anyway).
    '/((?!assets/).*)',
  ],
}
