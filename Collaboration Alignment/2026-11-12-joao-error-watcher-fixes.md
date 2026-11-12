# Error watcher review: four fixes

- **Date:** 2026-11-12
- **Author:** Joao via Claude Code (Claude Opus 5.5)
- **Branch / commits:** `fix/share-link-dtr-id` rebased on `main` 07e9feb, pushed to `main` (and `design` fast-forwarded)
- **Deployed to:** production (dpl id in PROJECT_STATUS.md); rollback target dpl_8xzTp7FD
- **Decision log:** DEC-0290

## What shipped
All 7 unreviewed watcher alerts were investigated and marked reviewed. Fixes:
- Launch SOL check now counts the Reserve Token's Metaplex metadata (~0.0145 SOL), the step #93 KING failed at.
- A USDC redemption no longer reports "balance has not increased" when its own transactions show the payout.
- A closed Jupiter lookup table no longer blocks a redemption with an endless "try again".
- A Jupiter swap failing simulation reads as a swap failure (slippage for 6001), not "SsrError::ZeroValue".

## Code touched
- `src/merge/lib/createReserveClient.ts` — `TOKEN_METADATA_ACCOUNT_LAMPORTS` in the estimate
- `src/merge/lib/multiAssetSellClient.ts` — `usdcDeltaFromSignatures` fallback in `verifyDelivery`
- `src/merge/lib/singleTxBuy.ts` — `fetchLookupTables` skips tables that do not exist
- `lib/mainnet/simulationError.ts` (new), `buildSell.ts`, `buildBuy.ts` — program-aware simulation messages
- `src/merge/pages/CreateDTR.tsx` — Resume copy ("bought" broke the DEC-0228 test)
- `lib/command-center/model.ts`, `api/feedback/board.ts` — Vercel build type errors

## Effect on others — READ THIS
- `describeOnChainError` alone still decodes against SSR's table; for a whole simulated transaction use `describeSimulationFailure(tx, err)`.
- Offline suite baseline is now 5 failing (chart selector x2, native-control reset x2, IDL pinning).

## Verification
New test file 6 passing; full suite 1825/5; tsc -b and vite build clean; prod checks listed in PROJECT_STATUS.md.
