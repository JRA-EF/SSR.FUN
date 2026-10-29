# Command center shows the production Jupiter key's real rate limit

- **Date:** 2026-10-29
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** see follow-up line
- **Decision log:** none

## Why
- The watcher review (2026-10-29) found Jupiter `429 Too many requests` errors on user routes (`build-buy`, `jupiter-swap`, `launch-preflight`) as well as the keeper. One user launch at 09:30 UTC expired; the retry at 09:35 worked.
- The server already retries 429s (4 attempts, 2/4/6 s). The limit itself is the problem. The production key is probably not on the paid Developer plan: the portal showed 0 credits used while the app makes thousands of calls a day.
- The command center's Jupiter node read `x-ratelimit-limit`, which Jupiter never sends, so its rate-limit line never showed.

## What shipped
- `lib/command-center/probes.ts`: the limit is `x-ratelimit-remaining + x-ratelimit-current`. With no key at all, Jupiter gives 5 per window (measured). If the production key's limit is 5 or less, the Jupiter node now shows a warning: "free tier, not the paid plan".

## Effect on others
- None in the app. Swapping the key (Creator's call) is a Vercel env change plus redeploy.
