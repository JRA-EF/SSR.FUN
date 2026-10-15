# DEX liquidity flow off in production, on in staging

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `fix/liquidity-off`, cut from `origin/main` @ `bc24862`
- **Deployed to:** see the Follow-up line below
- **Decision log:** DEC-0245

## What shipped
- ssr.fun: Manage Reserve no longer shows the Liquidity tab, the Reserve page no longer prompts the Manager to add liquidity after the first mint, and the liquidity execution endpoints report `executionEnabled: false`.
- Staging keeps the full flow for testing.

## Code touched
- `src/merge/lib/liquidityFeature.ts` (new): `LIQUIDITY_ENABLED`, from `VITE_ENABLE_LIQUIDITY` at build time.
- `src/merge/pages/ManageDTR.tsx`, `src/merge/pages/DTRDetail.tsx`: entry points gated.
- `lib/mainnet/liquidityRelease.ts`: `LIQUIDITY_EXECUTION_ENABLED = process.env.VITE_ENABLE_LIQUIDITY === 'true'`.

## Effect on others — READ THIS
- **To turn liquidity back on in production:** set `VITE_ENABLE_LIQUIDITY=true` on the `ssr-fun` Production env and REDEPLOY (the tab is inlined at build time).
- `ssr-fun-staging` Production env has `VITE_ENABLE_LIQUIDITY=true`.
- The liquidity component files (DEC-0242's territory on `release/2026-10-15`) were not edited.

## Verification
See the DEC-0245 evidence.
