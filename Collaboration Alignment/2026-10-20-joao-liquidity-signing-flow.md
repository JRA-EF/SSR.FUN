# Liquidity signing flow: Phantom rewrites, explicit rejections, review clock, setup auto-advance

- **Date:** 2026-10-20
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` @ `afaff34` (Phantom rewrite) and the follow-up commit that adds this entry
- **Deployed to:** staging (ssr-fun-staging) and prod (ssr-fun; liquidity is still off there, DEC-0245)
- **Decision log:** none (bug fixes inside DEC-0251's flow)

## What shipped
- **Phantom rewrite (afaff34):** Phantom rewrites single-signer transactions before signing. It replaces the compute budget and adds Lighthouse guard instructions (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`). The exact-hash check threw away the signed transaction, so liquidity setup never sent and Submit stayed greyed out. A rewrite is now accepted only when every reviewed instruction survives byte for byte, in order, with the same accounts, lookups, fee payer and blockhash. Additions are limited to Lighthouse and compute-budget instructions, and the wallet's priority fee is capped at 0.002 SOL. A rewrite of a launch SSR already co-signed is still refused, with a plain message.
- **Explicit rejections:** a JSON-RPC error on send (preflight failure, rate limit) is now recorded as `rejected`, with the RPC message and the last simulation logs shown to the user. It no longer becomes "outcome unknown". Transport failures stay `pending` exactly as before. Before the next spend, a rejected signature is checked on chain once.
- **Review clock:** setup and pool launch have a 30 s preparation deadline. The signing window (45 s launch, up to 75 s setup) starts after simulation and is capped 55 s after the blockhash fetch. The browser re-measures it on its own clock (`serverNowMs`) and shows a countdown. Locally measured, preparation takes about 1 s; clock skew and the setup window outliving the blockhash were the real risks.
- **Auto-advance:** after a submission the review follows it to confirmed, failed or expired. A confirmed setup step prepares the next one, and a completed setup re-prepares the pool launch. Every step still needs the typed word and its own wallet signature.

## Code touched
`src/merge/lib/liquidity/liquidityExecution.ts`, `liveLiquidityClient.ts`, `src/merge/components/LiquidityTransactionReview.tsx`, `LiquidityLookupSetup.tsx`, `LiveLiquiditySection.tsx`, `lib/mainnet/prepareCompound.ts`, `createLiquidity.ts`, `liquiditySetup.ts`. Tests: `tests/phase_liquidity_execution.ts`, `tests/phase_compound_preparation.ts`.

## Effect on others -- READ THIS
- `simulateLiquidityTransaction` takes an optional `reviewWindowMs`. Without it, behavior is unchanged (Compound keeps its quote-bound expiry).
- `PendingLiquidity.state` gains `'rejected'`.
- Reserve LIQUIDITY (`HNkMLZJW27HTf3uc67Ak7GwzDQB7pETu8QU3GhWgpyLP`): the creator holds all 10 LIQUID, which covers at most about 9.6-9.8 USDC at NAV. A 10 USDC launch fails at preparation with "insufficient Reserve Tokens".

## Verification
Offline suite: 1604 passing, 4 known failing (chart selector, native-control reset). tsc, oxlint on the changed files, a vite build with `VITE_ENABLE_LIQUIDITY=true VITE_SOLANA_CLUSTER=mainnet-beta` (all four changes present in the bundle). A read-only Mainnet preparation of the LIQUIDITY launch reaches lookup setup (29 addresses) in about 1 s. NOT yet verified: a real Phantom setup plus pool launch end to end.
