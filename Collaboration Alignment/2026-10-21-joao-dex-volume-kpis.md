# Homepage KPIs include DEX pools (volume + market cap), kept separate in the backend

- **Date:** 2026-10-21
- **Author:** Joao via Claude Code, Opus 5.5
- **Branch / commits:** `main` (rebased on 4befc2f)
- **Deployed to:** none yet (prod deploy coordinated with the in-flight liquidity prod deploy). Neon: tables `dex_pools`, `dex_pool_swaps` created and filled.
- **Decision log:** DEC-0254

## What shipped
- Homepage **All-Time Volume** = mint/redeem + swaps in SSR-created Raydium pools.
- Homepage **Total Reserve Market Cap** = per Reserve, tokens outside its SSR pool at NAV + tokens inside the pool at the pool price.
- Backend keeps them apart: landing-stats returns `volumeAllTimeUsd` (mint/redeem, unchanged) and `dexVolumeAllTimeUsd` separately, plus `pools`; `/internal/kpis` has its own "DEX volume" tile.

## Code touched
- `lib/dex-volume/*` (new) — pool discovery from LiquidityRevenue accounts, swap classifier, daily sweep, reads
- `api/kpis/dex-volume-cron.ts` (new), `vercel.json` — daily 03:30 UTC
- `api/mainnet/landing-stats.ts`, `lib/reserve-activity/kpis.ts`, `src/internal-kpis/Dashboard.tsx`, `src/pages/Home.tsx`, `src/merge/lib/protocolKpis.ts`, `src/merge/hooks/useLandingStats.ts`
- `tsconfig.node.json` — excludes `lib/dex-volume` like the other CommonJS lib folders

## Repositories / environments adjusted
- Neon (project DB): `scripts/migrate-dex-volume.mjs` applied; first sweep run (2 pools, $196.87).
- Vercel: new cron path; no env vars.

## Effect on others — READ THIS
- **Mainnet now has version-1 transactions; web3.js 1.98 cannot parse them** (`getParsedTransactions` fails the whole batch; `getTransaction` with `maxSupportedTransactionVersion: 0` errors). The DEX index uses raw JSON-RPC. `packages/sdk/src/activityLog.ts`, `readOnly.ts` (24h volume), `lib/ledger/ingest.ts` and `lib/reserve-activity/feePayouts.ts` still use version 0 and may error on one — worth a follow-up.
- Per-Reserve cards and detail pages still show NAV-based market cap and mint/redeem volume (unchanged).
- DEX volume refreshes daily; run `scripts/run_dex_volume_sweep.ts` for an immediate refresh.
