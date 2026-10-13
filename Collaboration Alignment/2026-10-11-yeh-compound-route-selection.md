# OPEN-13 decision resolved; Compound comparison/review foundation

- **Date:** 2026-10-11
- **Author:** Yeh via Codex
- **Branch / commits:** feature/raydium-permissioned-cpmm (after 5a69ecf)
- **Deployed to:** none
- **Decision log:** DEC-0233; next free ID 0234 (check shared branches first)

## What shipped

Yeh selected dynamic primary-mint versus canonical-pool acquisition for Compound: fresh quotes, show net liquidity and all costs, creator explicitly selects and approves one route. OPEN-13 is resolved as a product decision. Live Compound is still not enabled.

SDK comparison module requests both injected quote providers for the same net earnings budget/state/destinations/lock terms, validates conservation, transfer-fee accounting, cost coverage, minima and <=30-second freshness, suggests the greatest protected LP output without preselecting a route, and binds review approval to the exact plan. Provider failures remain unavailable, never invented fallback quotes. Immutable copies prevent late provider mutation. Changed quote/state/cost/lock/custody and wrong creator require fresh approval.

Reusable review panel displays deposit amounts, expected/minimum LP, leftovers, currency-specific cost lines and extra SOL budget; selection expires and is invalidated on plan changes. Preview mounts it without fabricated live quotes and disables the old one-click NAV-based Compound simulation. Collect preview and the existing preview-store regression helpers remain available. Readiness now says LIVE_COMPOUND_EXECUTOR rather than incorrectly claiming OPEN-13's product choice remains unresolved.

## Code touched

- packages/sdk/src/compoundRoutes.ts + SDK export — quote/review contract, orchestration and approval validation.
- src/merge/components/CompoundRouteReview.tsx, LiquidityModule.tsx — review UI and honest unavailable preview.
- src/merge/lib/liquidity/raydiumCpmm.ts, SDK liquidityRevenue comment — correct execution readiness.
- tests/phase_compound_routes.ts — ten quote/approval regression tests.
- tests/phase_raydium_cpmm.ts — updated blocker expectation after the product decision.
- tests/phase_reserve_deploy_resumability.ts — DEC-0232 appended errors now extend the IDL range through 6070; keep unknown-6400 rejection and verify newly appended error names.
- Decision log, liquidity/fee specs, project status, dated alignment follow-up — decision and accurate remaining gates.

## Environments adjusted

None. No quote API credentials accessed, dependency installed, third-party skill applied, mainnet quote claimed, signing/submission, program changes or deployment. Unrelated .claude/launch.json and ManageDTR issue untouched.

## Effect on others — READ THIS

Live mint/Jupiter and canonical-pool quote providers, treasury-authorized spending, exact transaction construction/simulation, locks and release verification remain engineering work. This module is a provider contract and review foundation, not a live quote service or transaction executor. The SDK approval object is not a signature. Root-manager selection cannot spend a separate treasury's USDC without that treasury's authorization. No server custody is assumed.

Providers must solve allocation against actual pool ratios (post-acquisition reserves for the pool route), effective mint fees, project tax when applicable, transfer fees/epoch and real basket execution. Never use half-budget assumptions or NAV=$1. Before signing, fresh account/pricing reads and on-chain spend/output/LP/lock limits must enforce the approved exact plan; any changed plan requires explicit reapproval. No silent route switching or creator-inventory fallback.

OPEN-14 funding/signing/final LP ownership remains pending. Previously reproduced SBF stack/runtime diagnostics remain release gates; no program code changed this unit, no fresh SBF/runtime success claimed. No merge to design/staging/main.

## Verification

SDK + app typecheck + Vite production build pass. Full offline phase suite: 1372 passing / four existing chart/native-control-reset failures. Ten new tests cover parallel provider context, ranking, unavailable/expired routes, complete cost and budget validation, creator-only selection, content/state/custody/lock binding and mutation isolation. New files pass oxlint; diff whitespace checks pass. No browser interaction, end-to-end quote-provider/CPI simulation or actual execution claimed.
