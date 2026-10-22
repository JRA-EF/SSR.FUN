# Holder share split between Reserve backing and locked pool liquidity (DEC-0255)

- **Date:** 2026-10-22
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `feat/holder-pool-split` @ `f07073d` (f9c1c6b program, 4cccade app + keeper, 94efbd3 docs, f07073d probe fix), on top of origin/main 6214b7b. Not pushed, not merged.
- **Deployed to:** staging (`dpl_AvmpUfwypSCZByW7qX6rh7oXKcD9`, from a detached worktree `../SSR.FUN-stg0255`). Mainnet program NOT upgraded.
- **Decision log:** DEC-0255

## What shipped
- Program (not yet on Mainnet): `configure_liquidity_split` (only in the same transaction as `configure_liquidity_revenue_v2`), `pool_feed_begin` / `pool_feed_end` (keeper flash leg: swap + deposit on the pool, LP locked in the split's own account forever), errors 6083-6087. Binary 1,684,776 B.
- Launch form: Backing / Pool slider under the holder share. It stays disabled with a plain note until the program has the split (server probe, custom 101); the review and pool status show the split.
- Keeper (fee-settlement-cron job D): for a pool with a split, the pool leg runs before backing, only within 1% of NAV, at most 2% of the pool's USDC per leg; off NAV that run's pool part goes to backing.

## Code touched
`programs/ssr_protocol/src/instructions/liquidity_split.rs` (new), `lib.rs`, `errors.rs`, `instructions/mod.rs`; `tools/rebalance-litesvm/src/split.rs` (new); `packages/sdk/src/liquidityRevenue.ts`, `raydiumCpmmInstructions.ts`, `idl/`; `lib/mainnet/poolFeed.ts` (new), `basketFeed.ts`, `createLiquidity.ts`, `atomicPool.ts`, `liquidityLifecycle.ts`; `api/mainnet/liquidity.ts`, `fee-settlement-cron.ts`; `src/merge/lib/liquidity/feeTerms.ts`, `raydiumCpmm.ts`, `liveLiquidityClient.ts`; `src/merge/components/LiquidityFeeTerms.tsx`, `LiveLiquidityActions.tsx`, `LiveLiquiditySection.tsx`; tests `phase_liquidity_split.ts` (new), `phase_liquidity_terms_v2.ts`, `phase_reserve_deploy_resumability.ts` (error range now 6000-6087); `scripts/verify_pool_feed_raydium.ts` (new).

## Repositories / environments adjusted
- Staging frontend only. No env, Neon or Mainnet change.

## Effect on others — READ THIS
- **Program error range is now 6000-6087 in this branch.** Any other program work must append after 6087 and start from this branch, or the two upgrades collide.
- `readLiquidityState` reads one more account (the split PDA); its fingerprint changes accordingly.
- The upgrade needs about 9.1 SOL on the deployer `CgHF...qVDN` (it has 6.45): buffer rent about 8.56 SOL (refunded to the spill at upgrade) + ExtendProgram +99,376 B about 0.51 SOL (top-level, plain ExtendProgram as for DEC-0251).
- The Creator asked to approve before the Squads upgrade executes.
- Merging this branch to main before the upgrade is safe: the probe keeps the slider off and the server refuses a pool share until the program has it.

## Verification
Program unit tests 40/40; LiteSVM ALL PASS (new split scenario + every earlier rebalance/basket-feed check); regenerated IDL equals the committed one except the new items; Mainnet simulation of the keeper's Raydium swap + deposit on the LIQUID pool minted exactly the planned LP; offline suite 1666 passing / 4 known failing (chart selector x2, native-control reset x2); `tsc -b` clean; Mainnet probe reports terms v2 live, split not live.
