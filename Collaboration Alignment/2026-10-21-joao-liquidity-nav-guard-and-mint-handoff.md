# Add liquidity: off-NAV warning, and the review after a mint is flagged as the last step

- **Date:** 2026-10-21
- **Author:** Joao via Claude Code, Opus 5.5
- **Branch / commits:** `fix/liquidity-nav-guard` @ `35d4345`, `3310cbe` (cut from origin/main 349ca2f; not yet merged to main)
- **Deployed to:** staging (`dpl_5Bk8jUAayxfLtMRnbXysMFUtsF91`, strategic-super-reserve.fun) from the staging tree 1252ba1 (main + feat/create-preflight) merged with this branch as 798da2d. Production untouched (liquidity is off there, DEC-0245).
- **Decision log:** DEC-0253

## What shipped
- **Add liquidity warns when the pool is off backing value.** Beyond 1% either way, the form says the pool price, the backing value, the gap and who loses it. The review button and the "mint missing tokens" step stay disabled until the creator ticks "I understand the pool is not at backing value and I may lose the difference." Within 1% nothing changes. Pool launch is unchanged (it already opens at NAV).
- **After minting the missing tokens, the review is announced as the one step left.** A pop-up ("Mint confirmed. One step left") and a notice above the review naming the word to type (e.g. ADD) and linking the mint. If preparing the review fails, the message says the minted tokens are safe in the treasury.

Why: live test on Reserve LIQUID today. The pool sat at ~$8.89 per token against ~$1.06 backing with no warning on the add form; and after a DEC-0252 mint the add review was prepared but never approved, because the mint box disappears once the treasury holds enough and nothing pointed at the review.

## Code touched
- `src/merge/lib/liquidity/liveLiquidityClient.ts` — `NAV_DEVIATION_LIMIT_PCT`, `navDeviation()` on the existing `premiumPct`
- `src/merge/components/LiveLiquidityActions.tsx` — warning + acknowledgement in `AddLiquidityForm`; `MintedHandoff` passed from the mint step to `onPrepare`; buttons call `submit()` explicitly
- `src/merge/components/LiveLiquiditySection.tsx` — `prepare(..., minted)` sets the hand-off notice and pop-up; Close review clears it
- `src/merge/components/LiquidityMintStep.tsx` — `onMinted({amount, signature})`
- `tests/phase_liquidity_nav_guard.ts`, `tests/phase_liquidity_mint_handoff.ts` (new)

## Repositories / environments adjusted
- SSR.FUN: staging redeployed (also picks up main's MetaMask fix fe77c97, which the 1252ba1 tree already contained).
- Vercel env / Neon / Squads / keys: none.

## Effect on others — READ THIS
- `PrepareFn` has an optional third argument (`minted`). Forms whose submit takes it must not use `onClick={submit}` (the click event would be passed as a mint); the test guards this.
- Offline suite: 1623 passing / 5 known failing (chart range selector x2, native-control reset x2, deployed-binary IDL pinning).
- The LIQUID pool is still ~8x above NAV; anyone adding there now sees the warning.
- Known gap: no server-side NAV check in the prepare endpoint (deliberately deferred, see DEC-0253).
