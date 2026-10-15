# Launch never fails on a 100.0x% allocation total

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `fix/allocation-rounding`, cut from `origin/main` @ `65796de`
- **Deployed to:** see the Follow-up line below
- **Decision log:** DEC-0247

## What shipped
- Launch a Reserve no longer fails with "Invalid allocation total (100.03%)" (or 100.02%). Weights become basis points by largest remainder, so a full basket is always exactly 100.00%.
- Same fix in the Robinhood launch plan.

## Code touched
- `src/merge/lib/basketAllocation.ts`: new `apportionBps(weights)`.
- `src/merge/pages/CreateDTR.tsx`: both `weightBps` conversions (launch + cost estimate).
- `src/merge/lib/evmLaunchPlan.ts`: `planLaunch` uses `apportionBps`; refuses only a raw total above 100.01%.

## Effect on others — READ THIS
- Converting weights to on-chain bps? Use `apportionBps`, never `Math.round` per row.
- `validateCreateReserveAssets` is unchanged and still refuses anything over 100%.

## Verification
See the DEC-0247 evidence.
