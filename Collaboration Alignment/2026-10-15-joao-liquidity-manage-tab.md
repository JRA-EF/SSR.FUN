# Manage Reserve > Liquidity: designed dashboard + release-check fix

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code, Opus 5.5
- **Branch / commits:** `fix/liquidity-manage-tab` @ `63b42c4`, merged to `main`
- **Deployed to:** staging 2026-10-14 (`dpl_DrWs6z455f…`); production see PROJECT_STATUS
- **Decision log:** DEC-0242

## What shipped
Mainnet Reserves now get the designed Liquidity tab (pool launch empty state, pool dashboard, earnings + Collect, locks) on live data. Fixed the stale `executionEnabled===false` check that made every live liquidity action fail after DEC-0240.

## Code touched
- `src/merge/components/LiveLiquiditySection.tsx`, `LiveLiquidityActions.tsx`, `LiquidityLookupSetup.tsx`
- `src/merge/lib/liquidity/liveLiquidityClient.ts` (new)
- `api/mainnet/liquidity.ts` — adds pool reserves, LP supply, per-lock LP

## Effect on others — READ THIS
- Compound route-compare card removed from the tab; Compound button stays disabled.
- Staging has no `SSR_RAYDIUM_POOL_PAYER_SECRET`, so pool launch returns 503 there.
- Deferred: Reserve-page liquidity intro and badges.

## Verification
`tests/phase_liquidity_manage_tab.ts`; tsc clean; staging on live data.
