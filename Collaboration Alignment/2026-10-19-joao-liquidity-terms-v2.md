# Liquidity terms v2: SSR 20% of creator pool earnings + optional holder share fed into the basket

- **Date:** 2026-10-19
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/lp-fee-basket` @ `e59885f`, `4c8dcc5` (fast-forwarded into `main`)
- **Deployed to:** in progress -- frontend first (it keeps using v1 pool creation until the program has v2), then the Mainnet program upgrade (see the follow-up lines below)
- **Decision log:** DEC-0251

## What shipped
New pools (after the upgrade): SSR takes 20% of everything the creator earns from an SSR pool -- the Raydium creator fee (after Raydium's cut) and the Buy/Sell tax. The tax sliders (0-2%) are back in Manage Reserve -> Liquidity launch. The creator may optionally share part of the remaining 80% with holders, chosen once at launch and never changeable. That share is released over 24 hours and the keeper swaps it into the Reserve's assets and deposits it in the vaults (MAG7-style "fees back into the basket"; nothing is minted, backing per token grows). Existing pools keep their old terms. Prod liquidity stays off (DEC-0245).

## Code touched
- `programs/ssr_protocol/src/instructions/liquidity_terms.rs` -- new: configure/distribute/taxed swap v2, `basket_feed_begin`, `LiquidityTerms` (24h release). v1 `configure_liquidity_revenue` now refuses; errors 6080-6082.
- `packages/sdk` -- regenerated IDL (additive), v2 builders and math mirrors in `liquidityRevenue.ts`.
- `src/merge/components/LiquidityFeeTerms.tsx` (new), `LiveLiquidityActions.tsx`, `LiveLiquiditySection.tsx`, `src/merge/lib/liquidity/feeTerms.ts` (new), `raydiumCpmm.ts`, `liveLiquidityClient.ts` -- launch UI and pool view.
- `lib/mainnet/basketFeed.ts` (new), `createLiquidity.ts` (chain probe), `atomicPool.ts`, `liquidityLifecycle.ts`, `prepareCompound.ts`, `api/mainnet/liquidity.ts`, `api/mainnet/fee-settlement-cron.ts` (job D).
- `tools/rebalance-litesvm/src/feed.rs`, `tests/phase_liquidity_terms_v2.ts` (new) + three updated tests; CLAUDE.md, AGENTS.md, FEE_MODEL.md, TERMINOLOGY.md.

## Repositories / environments adjusted
- SSR.FUN: main fast-forwarded; prod + staging frontend deploys and the Squads upgrade follow (recorded below).
- Squads: one upgrade proposal (extend runs top level, paid by the deployer).

## Effect on others -- READ THIS
- Pool creation checks the deployed program (custom-101 probe, like DEC-0250's rebalance probe): v1 terms and no holder option until the upgrade lands, v2 after. No env flag.
- `fee-settlement-cron.ts` has a new job D after job C (basket feed). It needs the on-chain keeper role, like job A.
- `basket_feed_begin` reuses `rebalance_swap_end` and the per-Reserve `RebalanceTicket`: a keeper feed and a Manager rebalance on the same Reserve serialize, never interleave.
- Not yet exercised against a real Raydium pool: `swap_with_project_tax_v2`. The first v2 pool on staging is its first real test.

## Verification
LiteSVM against the compiled binary (14 new checks + DEC-0250's 11), cargo test 39, offline suite 1592 passing / 4 known failing, tsc -b, api tsc, oxlint, vite build. Read-only Mainnet probe: v2 not live yet, rebalance control live. Live program verified = 7919dacd (DEC-0250) before building on it.
