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

- Follow-up 2026-10-19: LIVE. Program upgraded via Squads #15 (slot 458879753, sha 745dcaa0...48a6, extend tx 49s97FKg...gdHQ3, buffer refunded). Production dpl_Go4aE8N5m6Yw9EWcYs8gyArM3xAy (main 0051b75; liquidity off). Staging dpl_DqTwBTCN6eDZn4cY9J4BFUkr3gJT = feat/create-preflight merged with main (bfabca8, not pushed to main per the DEC-0249 owner). Chain probe now reports v2 live; new pools get the v2 terms and the holder option.

- Follow-up 2026-10-19 (later): fixed a stuck pool launch on staging. A setup step saved its new lookup-table address before signing; the 25 s review expired after signing, the table was never created, and every later review failed with "Liquidity lookup table unavailable". The server now skips saved tables that do not exist (a fresh setup step is offered if still needed), and setup reviews last 50 s. Staging JUPITER_API_KEY was also replaced (the old key was rejected with 401).
