# Liquidity production release: staging branches merged into main, cron gate fix

- **Date:** 2026-10-22
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `release/liquidity-prod` -> `main` (merges `feat/create-preflight`, `fix/liquidity-nav-guard`, `feat/dex-kpis`; plus the middleware fix below)
- **Deployed to:** not yet. Production deploy = set `VITE_ENABLE_LIQUIDITY=true` on the `ssr-fun` project, then deploy from main.
- **Decision log:** DEC-0249, DEC-0251, DEC-0252, DEC-0253, DEC-0254 (no new decision)

## What shipped
- `main` now carries everything staging runs (`087bd89`, dpl_GtULZkiYLJZs3SsjCpStejGanKXH): Create Reserve route check (DEC-0249), liquidity NAV guard and mint hand-off (DEC-0253), homepage DEX volume / pool-priced market cap (DEC-0254). The code tree equals staging's except for this entry, the DEC-0253 hand-off note and the fix below. Doc conflicts (DECISION_LOG, PROJECT_STATUS) were resolved with staging's copies, which are main plus additions only.
- **Fix:** `middleware.ts` CRON_PATHS was missing `/api/kpis/dex-volume-cron` (new in DEC-0254) and `/api/robinhood/catalogue-refresh-cron` (missing since it was added). The site gate answers 401 to any path not on that list, and Vercel's cron runner carries no session cookie, so behind the gate (production) neither handler would ever run. New test `tests/phase_cron_gate_exempt.ts` fails if any `vercel.json` cron is missing from CRON_PATHS.

## Effect on others -- READ THIS
- Adding a cron now means adding it to `middleware.ts` CRON_PATHS too; the test enforces it.
- `VITE_ENABLE_LIQUIDITY` is read twice: inlined into the frontend at build time, and at runtime by `lib/mainnet/liquidityRelease.ts` (pool launch/add/withdraw endpoints). Setting it on the production project and redeploying turns on both.
- Jupiter rate limiting (HTTP 429) is common on both projects (fee keeper, swaps, and on staging the new route check). The route check marks an asset "unchecked" and does not block the launch when that happens. Staging also runs the fee-settlement cron against Mainnet, which competes for Jupiter quota if both projects share a key.

## Verification
`tsc -b` clean; offline suite 1653 passing / 5 pre-existing failures (chart range selector x2, native-control reset x2, IDL pinning) plus the new cron test passing (and failing on the pre-fix middleware). A `VITE_SOLANA_CLUSTER=mainnet-beta VITE_ENABLE_LIQUIDITY=true VITE_ENABLE_EVM=false` build contains the "no pool yet" banner, the Manage Liquidity tab link, the NAV-guard warning, the route check and the DEX KPI field. Mainnet: pool payer `6smL...oqAS` holds 0.05 SOL (it fronts fees; the creator refunds its costs in the same transaction) and its Raydium permission PDA exists.

Follow-up 2026-10-22 (Joao via Claude Code, session 1017d2ad): SHIPPED. VITE_ENABLE_LIQUIDITY=true set on ssr-fun Production and main 23dc25a deployed to prod as dpl_As8NHVWMQPh4jaMUi8qzHT7yHP3i (aliases ssr.fun, www.ssr.fun). It carries the four release items (liquidity flow, DEC-0253 NAV guard + mint step, DEC-0249 Create route check, DEC-0254 DEX KPIs) plus DEC-0255 (backing/locked-liquidity split, program live), 1% slider steps, the "Share earnings?" copy and the 1% add/withdraw tolerance. Checked on prod: landing-stats returns DEX volume $196.87 across 2 pools; the liquidity endpoint reads LIQUID (terms v2, execution enabled). Rollback: `vercel promote dpl_DgV5aD4beB1PkicUfsVBxEyQFcb3 --yes` plus removing VITE_ENABLE_LIQUIDITY.

Follow-up 2026-10-22 (Create fix, Joao via Claude Code): first prod test launch (Reserve DAYhj...Ctihs) registered SOL at 0% next to a 100% asset and stopped at seeding (every asset needs 1000 raw units). Fix: the basket step refuses a 0% asset by name, validateCreateReserveAssets refuses it before anything is spent, and wrapped SOL's seed amount is floored at the protocol minimum so Resume finishes an already-registered 0% SOL (wraps 1000 lamports). Deployed to prod and staging.
