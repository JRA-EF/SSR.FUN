# All-Time Volume now counts the creation seed (and every unvalued mint/redeem)

- **Date:** 2026-10-23
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `feat/holder-pool-split` -> `main` (and `design`)
- **Deployed to:** prod (ssr-fun) and staging (ssr-fun-staging)
- **Decision log:** DEC-0256

## What shipped
- `lib/reserve-activity/volumeUsd.ts`: values mint/redeem/seed rows that were indexed with no USD value (re-decodes the row's transaction, prices the asset legs with Jupiter). Runs on the Mainnet Manage activity read and in the nightly KPI sweep. Only fills a null.
- One-off run on 2026-10-23 valued all 28 unvalued Mainnet rows; seed volume $467 -> $1,096.

## Effect on others -- READ THIS
- Activity rows indexed without a valuation used to stay at $0 forever (the sweep's top-up never revisits them). They now get valued; if you add a new volume event kind, add it to VOLUME_EVENT_KINDS too.
- The Mainnet activity read now makes one Jupiter call (and one getTransaction per unvalued row, at most 4) only when such rows exist.

## Verification
New tests/phase_seed_volume_valuation.ts; offline suite 1674 passing / 4 known failing; tsc clean. DB after the run: 0 unvalued mint/redeem/seed rows on Mainnet.
