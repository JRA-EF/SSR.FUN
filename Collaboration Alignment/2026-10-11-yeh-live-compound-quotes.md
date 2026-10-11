# Read-only live Compound quote providers

- **Date:** 2026-10-11
- **Author:** Yeh via Codex
- **Branch / commits:** feature/raydium-permissioned-cpmm (after 08d04ab)
- **Deployed to:** none
- **Decision log:** DEC-0234; next free ID 0235 (check shared branches)

## What shipped

Read-only API and browser helper compare primary mint with canonical-pool acquisition for the same creator-controlled Compound budget. Real account reads supply balances, current fee config/retention and epoch-specific token transfer fees. Jupiter ExactOut supplies actual proportional basket-funding quotes. Pool acquisition uses the post-swap liquidity ratio, native fee rounding and LP-retained fees, optional project tax and both Reserve Token transfers. No fixed half-budget allocation, NAV=$1 or constant basket execution cost.

Discovery is followed by one contextual financial account batch. Validate canonical pool, revenue router, fixed treasury, programs, USDC-only fees, protocol pause, balances and supplies. Exclude accrued fees from pool liquidity. Fingerprints include relevant account bytes and epoch; routine Clock slot/time ticks are excluded. Quote expiry starts at discovery, not the end of provider calls. Returned acquisition plans retain the final basket quotes/amounts with their fingerprints. This is not an unsigned transaction builder.

The browser decoder validates bigint amounts, quote policies, destinations, budget and expiry. Shared review labels distinguish basket slippage reservation, all-in primary execution premium (includes venue fees), and SOL planning allowances. Preview still has no live comparison and spending stays disabled.

## Code touched

- lib/mainnet/compoundQuotes.ts — contextual snapshot, integer math and both providers.
- api/mainnet/compound-quotes.ts — no-store, four-per-minute/IP read-only endpoint; bounded request validation; executionReady=false.
- lib/mainnet/jupiter.ts — optional ExactOut; existing ExactIn default unchanged.
- src/merge/lib/liquidity/compoundQuoteClient.ts — browser fetch and strict wire decoding.
- src/merge/components/CompoundRouteReview.tsx — accurate cost qualification, existing layout preserved.
- tests/phase_live_compound_quotes.ts, tests/phase_compound_snapshot.ts — 18 new offline tests, including real account-layout decoding and 1/5/10-asset fixtures.
- Liquidity spec, decision log and project status — implementation and explicit remaining gates.

## Repositories / environments adjusted

SSR.FUN feature branch only. No environment/credential changes, dependency installation, third-party skill applied, deployment, signature, transaction submission or merge to design/staging/main. Unrelated .claude/launch.json and ManageDTR hooks issue untouched.

## Effect on others — READ THIS

This is source-level live-service integration, not an operational launch or a report of real Mainnet quote results. Real registered pool, settled creator treasury funds and representative keyed basket verification still needed. Treasury balance verifies funding, not earnings provenance. Do not treat quote review as authorization to spend a separately controlled treasury.

Unlocked plans only. ExactOut-unsupported routes, stale/missing valuations or fee-on-transfer backing leave primary mint unavailable; pool remains independent. SSR supports eligible backing transfer-fee gross-up, but this provider waits for separately verified Jupiter output-fee semantics. Primary allocation uses at most eight quote batches; no global-optimality claim.

SOL network/setup fields are PLANNING CAPS, not exact simulated costs: 0.002 SOL per planned transaction (legs + two); 0.01 SOL per swap leg setup plus RPC rent for missing creator RT/LP accounts. Actual construction/simulation must determine costs, enforce spending/output/LP/lock constraints and obtain fresh approval for changes. Keep dynamic slippage disabled in the future Compound executor; existing unrelated builders are unchanged. No server custody or automatic route selection/fallback.

Remaining: live UI integration; treasury-authorized exact transaction builder/simulation/signing/recovery; locks; OPEN-14 creation funding/signing/initial LP return; real representative keyed quotes; existing SBF/runtime diagnostics and release verification. Preserve quote provenance slot when checking fresh relevant state; do not replace the original context with a newly quoted one without reapproval.

## Verification

Production npm build, explicit Mainnet API typecheck, new-file oxlint and diff whitespace checks pass. Full offline phase suite: 1390 passing / same four existing chart/reset failures. After final snapshot/plan-validation refinements, 37 focused provider/snapshot/comparison/adapter tests pass. Account fixtures use real Anchor/SPL layouts. No actual Jupiter/Mainnet quote, exact CPI transaction simulation, browser interaction or on-chain execution claimed. No Rust code changed; prior SBF/runtime diagnostics remain release gates.
