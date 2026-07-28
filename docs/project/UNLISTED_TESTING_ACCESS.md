# Unlisted Testing Access

`https://strategic-super-reserve.fun` is run as an **unlisted testing deployment**: anyone who has the exact URL can open it, but nothing points at it publicly and it asks not to be indexed. This is intentionally *not* an access-control mechanism — see Limitations.

## What "unlisted" means here

- No authentication, password, or allowlist of any kind gates the site.
- The URL is not linked from any other public page, nav item, footer, or sitemap in this app or elsewhere.
- Search engines are asked not to index or follow links from it.
- A visible "Testing Environment" badge marks every page as non-production so anyone who lands on it (e.g. via a shared link) knows what they're looking at.

Anyone who obtains the URL — by being told it directly, by guessing it, or by any other means — has full, unauthenticated access identical to a normal visitor.

## What was changed

1. **`<meta name="robots" content="noindex, nofollow">`** added to `index.html`'s `<head>`, requesting that compliant crawlers neither index this page nor follow its links.
2. **`public/robots.txt`** added with `Disallow: /` for all user agents, as a second, standard signal to crawlers not to index the site.
3. **"Testing Environment" badge** added to the site header (`src/components/Shell.tsx`, styled in `src/index.css` as `.testing-badge`), next to the existing "Simulation Mode" badge. Same pill shape and design tokens as the existing badge, in a more muted/neutral tone so it reads as secondary information, not a call to action.
4. **No new links to the domain were added anywhere** — the app already only ever generates relative, in-app paths (via the hash router in `src/lib/router.tsx`); it never references its own absolute domain. Confirmed by search: no other file in the repo mentions `strategic-super-reserve.fun`.

## Limitations

- **`noindex`/`robots.txt` are requests, not enforcement.** Well-behaved crawlers (Google, Bing, etc.) honor them; nothing prevents a browser, script, or a less-cooperative crawler from fetching the page anyway. They reduce the odds of the URL surfacing in search results or being auto-discovered — they do not restrict who can load it.
- **"Not linked anywhere" only covers this repository and this app.** If the URL is pasted into a chat, doc, social post, or another site that gets crawled, it can still become discoverable that way — that's outside this app's control.
- **No real access control exists.** Anyone with the URL — via search, a shared link, browser history, a referrer header, a proxy log, etc. — has the same access as an intended tester. This setup is meant to keep the deployment out of casual/organic discovery, not to protect sensitive data. Don't treat data on this deployment as private, and don't rely on this setup if you need to restrict who can view the app.
- The badge is a visual cue for humans who land on the page; it has no effect on access.

## If real access control is needed later

If this deployment ever needs to actually restrict who can view it (not just stay unlisted), that's a separate, larger change — e.g. Vercel's native deployment protection (password or Vercel Authentication) or an application-level check — and was intentionally **not** implemented here per this task's scope.
