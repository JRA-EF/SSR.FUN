# Incomplete-transaction recovery (/recover)

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code, Opus 5.5
- **Branch / commits:** `wip/incomplete-tx-recovery` (0a00f2e + the completion commit), merged to `main`
- **Deployed to:** see PROJECT_STATUS (staging first, production on the Creator's go)
- **Decision log:** DEC-0241

## What shipped
After a mint, redemption or launch the user should hold only USDC or the Reserve Token. When a multi-transaction flow stops half way, or a launch is cancelled after its seed swaps, or a mint's 2% swap buffer leaves dust, a banner on every merge page links to `/recover`. That page shows what landed (with signatures) and converts exactly what that flow left in the wallet to USDC with one approval.

## Code touched
- `src/merge/lib/incompleteTransactions.ts` — discovery, strict attribution, conversion (kinds: redeem, mint, create, mint-dust)
- `src/merge/lib/recoveryRecords.ts` — leaf store for cancelled launches and mint dust
- `src/merge/pages/IncompleteTransactions.tsx`, `src/merge/components/IncompleteTransactionsBanner.tsx`, `src/App.tsx`, `src/merge/MergeLayout.tsx` — page, banner, route
- `src/merge/lib/multiAssetBuyClient.ts` — writes the dust record on every successful mint
- `src/merge/lib/multiAssetSellClient.ts`, `src/merge/pages/DTRDetail.tsx` — failure handlers route to /recover; resumed redemption finishes its saved amount
- `src/merge/pages/CreateDTR.tsx` — Cancel Deploy hands seed-swap outputs to /recover

## Repositories / environments adjusted
- SSR.FUN only. No env vars, no program change, no server change.

## Effect on others — READ THIS
- New localStorage keys: `ssr_recovery_sweeps_v1`, `ssr_abandoned_creates_v1`, `ssr_mint_dust_v1`. Do not reuse them.
- Every successful multi-asset mint now shows a quiet "small unused amount" banner until converted or dismissed ("Keep in wallet").
- Recovery uses the existing `/api/mainnet/jupiter-swap` proxy at 300 bps slippage.
- Gap: a second mint of the same Reserve overwrites the first mint's dust record (that older dust just stays in the wallet).
- Gap: wrapped SOL a Create wrapped from the user's SOL is not unwrapped.

## Verification
`tests/phase_incomplete_transactions.ts` 11 passing; `tsc -b` clean; full offline suite and build in the completion commit message. Not browser-tested with a real wallet.
