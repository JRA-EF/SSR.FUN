# Liquidity amount: "Recommended" label removed from the $10K option

- **Date:** 2026-10-28
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** production with the no-background-RPC deploy (same day)
- **Decision log:** none (Creator copy request)

## What shipped
- On Manage Reserve's liquidity section, the $10K quick-amount button no longer carries a "Recommended" label, and the custom-amount box no longer says "(recommended $10K)". $10K is still the default selection, and the warning under $1K (minimum) still suggests at least $10K.

## Code touched
- `src/merge/components/LiveLiquidityActions.tsx`, `src/merge/components/LiquidityModule.tsx`: label and placeholder removed.

## Verification
- `tsc -p tsconfig.app.json` clean; liquidity and terminology tests 135 passing.
