# Portfolio holdings load in one batch; empty Reserves read $0.00

- **Date:** 2026-10-28
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` @ `b0f3d0f`
- **Deployed to:** production `dpl_CnoVm71A54fQ8e97rPnJ7G2sZSiR` (promoted 2026-10-28 after a `--skip-domain` build: cron dry run 200, command center 401). Rollback: `vercel promote dpl_7XY3dwKLHwm7vxMcYYiZMYaBNRgh`.
- **Decision log:** none (UI behaviour and copy)

## What was wrong
- Creator report: on production the Portfolio showed "No Reserves Yet", then "Syncing holdings...", then "No Reserves Yet" again for a long time, for a wallet that holds Reserves.
- Holdings were read only at the end of the full discovery pass (~250 RPC reads), then one Reserve at a time (mint owner lookup + token account, ~65 Reserves in a row through the rate-limited rpc-proxy).
- The Portfolio treated "discovery finished" as "holdings known", so it showed "No Reserves Yet" while those balance reads were still running.

## What shipped
- `src/merge/lib/walletReserveBalances.ts`: derives each Reserve Token account under both token programs and reads them with `getMultipleAccounts`, 100 per call (~65 Reserves = 2 calls). It throws on failure, so a failed read never shows as "holds nothing". `getTokenAccountsByOwner` would be one call, but the rpc-proxy does not allow it.
- `RealReserveSync`: reads holdings as soon as the Reserves are in the store (the warm-cache snapshot lands in about a second), again when the set of Reserve Token mints changes, and at the end of each discovery pass (which still runs after the user's own transaction).
- Store: `syncRealHoldings` (one update for all Reserves) plus `holdingsReadFor` (never persisted). The Portfolio says "Syncing" until the connected wallet's balances were actually read.
- An empty Reserve, or one with under 1 whole Reserve Token in circulation, shows **$0.00** instead of "Price unavailable" (Creator request) on cards, the Reserve page and Manage Reserve. Reserves with real supply whose pricing fails still say "Price unavailable".

## Effect on others
- `syncRealHolding` (single) still exists for other callers; RealReserveSync no longer uses it.
- `tests/phase_empty_reserve.ts` now expects `$0.00` for an empty Reserve's card.

## Verification
- New `tests/phase_portfolio_holdings_batch.ts`: 70 Reserves = 2 batched calls under both programs; a failed read throws; source guards.
- Offline suite: 1771 passing; the 5 failures are the known baseline. Both tsc projects clean.
