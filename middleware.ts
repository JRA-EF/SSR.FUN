// Vercel Routing Middleware: the only gate in front of internal-team-only
// pages. Scoped narrowly via config.matcher to /internal/status + its data
// endpoint, /internal/feedback (a simple gated link-through to a
// manually-maintained feedback Sheet -- no backend of its own),
// /road-to-mainnet (the collaborative DevNet-acceptance checklist + its
// state/history APIs), and /internal/kpis (the protocol usage-stats
// dashboard + its kpis/kpis-export/kpis-refresh data endpoints --
// kpis-backfill-cron is deliberately NOT here, since it's a scheduled
// Vercel Cron invocation authenticated by CRON_SECRET, not this password)
// -- every other route on the site is completely untouched, unauthenticated,
// and unaffected by this file. All four pages share the exact same session
// cookie/password (SSR_DASHBOARD_PASSWORD) -- one login covers all of them.
//
// Runs before the cache, so an unauthenticated request never reaches any
// page's static bundle or data endpoint -- the login page below is the only
// thing an unauthenticated visitor to any matched path ever gets.

import { next } from '@vercel/functions'
import { verifySessionCookie, parseCookie, SESSION_COOKIE_NAME } from './lib/dashboard/session.js'

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

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const password = process.env.SSR_DASHBOARD_PASSWORD ?? ''
  const sessionValue = parseCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME)
  const authenticated = await verifySessionCookie(sessionValue, password)

  if (
    url.pathname === '/api/dashboard/content' ||
    url.pathname === '/api/road-to-mainnet/state' ||
    url.pathname === '/api/road-to-mainnet/history' ||
    url.pathname === '/api/dashboard/kpis' ||
    url.pathname === '/api/dashboard/kpis-export' ||
    url.pathname === '/api/dashboard/kpis-refresh'
  ) {
    return authenticated ? next() : unauthorizedJson()
  }

  // /internal/status + /internal/feedback + /road-to-mainnet (their
  // public-facing paths) and /internal-status.html + /internal-feedback.html
  // + /road-to-mainnet.html (the literal built files the rewrites in
  // vercel.json point at -- each must be gated per page, since a rewrite
  // doesn't stop the underlying file from also being reachable directly at
  // its own path).
  return authenticated ? next() : loginPageResponse()
}

export const config = {
  matcher: [
    '/internal/status',
    '/internal-status.html',
    '/api/dashboard/content',
    '/internal/feedback',
    '/internal-feedback.html',
    '/road-to-mainnet',
    '/road-to-mainnet.html',
    '/api/road-to-mainnet/state',
    '/api/road-to-mainnet/history',
    '/internal/kpis',
    '/internal-kpis.html',
    '/api/dashboard/kpis',
    '/api/dashboard/kpis-export',
    '/api/dashboard/kpis-refresh',
  ],
}
