# Pool launch: low-volume reserve assets no longer need a 10-minute-fresh price

- **Date:** 2026-10-22
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `fix/launch-stale-price` -> `main`
- **Deployed to:** production (ssr-i66ep0grc-ssr14.vercel.app, aliased ssr.fun + www.ssr.fun, built from main e169d03); staging not yet
- **Decision log:** none (Creator rule 2026-10-22, recorded here and in `lib/mainnet/launchPrices.ts`)

## What shipped
- Launching a pool failed with "No recent market price is available for the reserve asset BpdH…pump (none in the last 10 minutes)" for Reserve `F5FS9Bpo...b5o8` (Reserve Token `6mxx...KVUi`). Jupiter Price V3 stamps a price with the block of the token's last trade; that pump.fun token had not traded for ~4,300 slots (~29 minutes), and the launch refused any price older than 1,500 slots.
- Creator rule: a low-volume token does not need a price that fresh. `lib/mainnet/launchPrices.ts` now feeds the launch: a price from the last ~10 minutes is used as-is; an older one is replaced by a live two-way Jupiter quote ($10 USDC in, the tokens back out; geometric mean, refused when the two sides differ by more than 5%), which follows the pools' current state (including SOL moves) without a trade; if Jupiter cannot quote it, the last traded price is accepted up to ~24 hours (216,000 slots). Older than that still refuses.

## Code touched
- `lib/mainnet/launchPrices.ts` (new), `api/mainnet/liquidity.ts` (create action uses it), `lib/mainnet/createLiquidity.ts` (error text), `tests/phase_launch_prices.ts` (new).

## Effect on others -- READ THIS
- `initialReserveAtNav`'s own 1,500-slot check is unchanged; launchPrices restamps an accepted price at the quote's slot (or the current slot for the 24-hour last-trade case). `basketFeed.ts` and `compoundQuotes.ts` still use their own, stricter freshness rules.

## Verification
`tsc -b` clean; offline suite 1674 passing / 5 pre-existing failures; new tests cover fresh price, live re-quote, wide spread, quote unavailable within 24 hours, and older than 24 hours. Live check: a $10 USDC quote for BpdH…pump implied $0.0005164 against Jupiter's stale $0.0005159.

Follow-up 2026-10-22 (Joao via Claude Code): liquidity added on production for the Creator's Reserve ALPHA (ILOVESOLANA) after one retry. The first "Check next setup step" (one-time lookup-table setup, `lib/mainnet/liquiditySetup.ts`) failed with "Liquidity simulation failed (a program rejected it); nothing was submitted"; the same step passed when clicked again and the add went through. No server error was logged (the setup endpoint returned normally). Cause not confirmed; the setup code already treats a remembered-but-missing table as new, so the likeliest explanation is a transient RPC/simulation state (the table's `recentSlot` comes from a `finalized` read while simulation runs at `confirmed`). Open follow-ups: (1) `simulationReason` falls back to "a program rejected it" when no Anchor "Error Message:" line exists -- it should name the failing program and its log line so the next occurrence is diagnosable; (2) if it recurs, capture the setup request (reserve, table, address count) and rerun it read-only.

Follow-up 2026-10-23: deployed to staging too (ssr-fun-staging-h3wh918wb from main ae795ca; staging was on 1dea6ea, already in main).
