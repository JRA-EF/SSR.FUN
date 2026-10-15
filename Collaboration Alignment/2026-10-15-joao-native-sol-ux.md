# Native SOL for users (no more "Wrapped SOL")

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code, Opus 5.5
- **Branch / commits:** `feat/native-sol-ux` (on top of `release/2026-10-15`)
- **Deployed to:** none yet
- **Decision log:** DEC-0244

## What shipped
Users see "SOL" (name "Solana") for the So111… mint everywhere, and never end a flow holding wrapped SOL: mint, seed and single-transaction redeem transactions close the user's wrapped-SOL account as their last instruction. /recover returns leftover wrapped SOL as native SOL instead of swapping it. Vaults still custody wrapped SOL; there's no program change.

## Code touched
- `packages/sdk/src/zapPricing.ts` — `displayAssetIdentity`
- `src/merge/lib/singleTxBuy.ts` — `buildUnwrapSolInstructions`; `assembleSingleBuyInstructions` takes `unwrapInstructions`
- `lib/mainnet/buildBuy.ts`, `buildSell.ts`, `buildSeed.ts` — unwrap appended last
- `api/ledger/asset-catalogue.ts`, `api/mainnet/warm-cache-cron.ts`, `src/merge/hooks/useMainnetAssetCatalogue.ts` — display identity
- `src/merge/lib/incompleteTransactions.ts`, `recoveryRecords.ts`, `pages/IncompleteTransactions.tsx`, `pages/CreateDTR.tsx` — recovery unwraps SOL

## Effect on others — READ THIS
- Never put `buildUnwrapSolInstructions` before the instruction that consumes wrapped SOL, or into a stand-alone Jupiter swap transaction (DEC-0156). Keep `wrapAndUnwrapSol:false`.
- The unwrap returns ALL of the user's wrapped SOL, including any they held before. That's intended.
- Gap: a batch redeem leaves an empty wrapped-SOL account (rent only).

## Verification
`tests/phase_native_sol_ux.ts` 6 passing; full offline suite 1543 / 4 known failures; tsc + build clean. Not yet exercised on Mainnet.
