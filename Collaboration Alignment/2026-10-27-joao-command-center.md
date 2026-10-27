# Command center: live map of every ssr.fun integration

- **Date:** 2026-10-27
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/command-center`, merged into `main`
- **Deployed to:** production and staging (deploy ids in the commit that follows)
- **Decision log:** DEC-0264

## What shipped
`/internal/commandcenter`, on both ssr.fun and strategic-super-reserve.fun, sits behind the internal dashboard password. It draws every integration ssr.fun depends on as a floating, draggable bubble, coloured by a live check and linked by animated dependency lines:
- Vercel, both domains, GitHub, Neon, Helius, Jupiter, the Telegram alert bot and the feedback Sheet.
- The SSR program, Squads, Raydium, the fee keeper and the pool payer.

Each bubble's keys orbit it as dots, showing name and age only, never values. Clicking a bubble opens a drawer with:
- what breaks if that integration fails;
- live readings;
- key ages against a rotation age;
- links;
- an editor for plan, cost, renewal date, owning login and notes.

A timeline along the bottom shows renewals and expiries. Deep links work: `/internal/commandcenter#helius` opens Helius.

## Code touched
- `public/internal-commandcenter.html`: the page, self-contained with no build step.
- `api/dashboard/commandcenter.ts`: data endpoint. Only ssr.fun production probes; every other deployment forwards to https://ssr.fun with a bearer token.
- `lib/command-center/model.ts`, `lib/command-center/probes.ts`: status rules and probes. Probes never return a secret value.
- `middleware.ts`: endpoint added to CRON_PATHS (it checks the session or bearer itself); page added to INTERNAL_PAGE_PATHS.
- `vercel.json`: rewrite, plus a 60 s maxDuration for the endpoint.
- `tests/phase_command_center.ts`: pins the gating and the production-only rule.

## Repositories / environments adjusted
- Vercel env: `COMMAND_CENTER_TOKEN` (Sensitive, Production), with the same value on ssr-fun and ssr-fun-staging.
- Vercel env, still to do: `VERCEL_API_TOKEN` on ssr-fun Production, created by the Creator in the dashboard.
- Neon: new table `command_center_facts` (node, facts jsonb, updated_at).

## Effect on others: READ THIS
- **Production only.** Only the ssr-fun production deployment probes. Staging must never get probe credentials for this page; it forwards to ssr.fun.
- **Adding a new integration or secret:** add it to `SECRETS` / `NODE_IDS` in `lib/command-center/probes.ts` so it shows up.
- **Never put keys or passwords in the plan/notes editor.** It is plain text in Neon.
- **Load:** each probe run makes one Jupiter quote, one Telegram getMe and one Apps Script GET. Runs are cached for 60 s.
