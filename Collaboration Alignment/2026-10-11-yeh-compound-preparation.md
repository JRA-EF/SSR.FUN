# Compound transaction preparation, simulation and Mainnet evidence

- **Date:** 2026-10-11
- **Author:** Yeh via Codex
- **Branch / commits:** `feature/raydium-permissioned-cpmm`, this commit after `0c22155`
- **Deployed to:** none
- **Decision log:** DEC-0235

## What shipped

The creator can request a real route comparison from the Mainnet liquidity screen, explicitly select a route and request an unsigned atomic acquisition-plus-deposit simulation. Final review checks destinations, both creator/treasury authorities, message digest, lifetime and simulated SOL cost. Spending remains hard-disabled in both the API and browser. Nothing is signed or submitted.

Native CPMM deposit/withdraw/swap account builders are source-ready. Compound revalidates state and the original provider-plan fingerprint, uses ExactOut basket funding or the SSR-taxed canonical-pool path, enforces gross spending and net token/LP minima, and preserves pre-existing Reserve Token inventory. Oversized baskets fail before any acquisition rather than silently creating a staged partial spend. Program treasuries need a separate multisig adapter. No arbitrary Jupiter setup/cleanup instructions are executed.

Corrected internal Raydium LP supply versus actual SPL minted supply (100 initial LP units withheld, plus possible burns). Require the fixed treasury associated LP destination. Fixed the valid creator-as-swap-user treasury alias case with Anchor `dup`, while retaining fixed-owner/mint constraints. Widened optional-tax split multiplication to u128. These do not change instruction/account layouts; generated IDL unchanged.

## Code touched

- `lib/mainnet/prepareCompound.ts`, `/api/mainnet/prepare-compound` — selected-plan construction and whole-message simulation, never signing/submission.
- `lib/mainnet/compoundQuotes.ts`, `lib/mainnet/jupiter.ts` — verified snapshot metadata, LP supply correction, complete ExactOut caps, optional credentials and fixed slippage during construction.
- `packages/sdk/src/raydiumCpmmInstructions.ts` — exact native instruction/account layouts.
- `src/merge/components/LiveLiquiditySection.tsx`, `LiquidityModule.tsx` and liquidity clients — live review separated from local previews; stale requests discarded; no wallet call enabled.
- `programs/ssr_protocol/src/instructions/liquidity_revenue.rs` — account alias and arithmetic corrections.
- `tests/phase_compound_preparation.ts`, snapshot/provider tests — authority/cap/destination/expiry/plan mutation and simulation failure regressions.
- `scripts/liquidity_live_validation.cts`, `docs/project/evidence/2026-10-11-liquidity-readonly.json` — paced read-only evidence and honest gaps.

## Repositories / environments adjusted

- SSR.FUN feature branch only. `origin/design` remains `6b36e0a`; no merge to design/staging/main.
- No other repository, Vercel environment, Neon, Squads, key, dependency, or third-party skill changed.
- Existing unrelated `.claude/launch.json` remains untracked and untouched.

## Effect on others — READ THIS

- Raydium permission/config reverified at slot 455772421. Native fees remain 0.25% trading / 0.75% creator with observed 5% creator retention. DEC-0232 economics remain unchanged.
- Anonymous Jupiter ExactOut works; do not require an API key merely to attempt a read. Anonymous quota/route availability are inadequate for a complete 5/10-asset validation: the probe recorded HTTP 400/429 and incomplete results. The one-asset basket is USDC-only, so no swap was needed. Never claim a complete measured arbitrage band from this evidence.
- Zero deployed Token-2022 Reserves found. Existing basket compositions were used only as execution probe inputs, not as legacy-token integration. Full new-token Compound simulation remains unverified.
- Do not enable spending using a config toggle. Wallet signing, typed final confirmation, reconciliation, complete representative quote coverage, funded new-token pool verification, OPEN-14 creation custody/signing, and lock workflows remain to complete.
- Prior SBF stack/runtime diagnostics persist in mint/redeem/seed/distribution/rebalance and the old test AMM. No new liquidity-revenue frame error was reported, but the artifact is not declared deployable.
- ManageDTR hooks-order issue and chart styling failures are separate and untouched.

## Verification

- Production build and explicit Mainnet API typecheck passed.
- 32 focused quote/snapshot/preparation tests passed, including original provider tests.
- 31 Rust unit tests passed, including maximum-u64 tax arithmetic.
- Full offline phase suite: 1404 passing, four pre-existing chart/reset failures; see `tests/phase_chart_range_selector.ts`.
- Changed-file lint and whitespace checks passed.
- Anchor build exits zero but still emits stack-frame and undefined-syscall diagnostics; treated as a failed release gate. No live program simulation, funded end-to-end transaction, interactive wallet approval or deployment claimed.
- Weighted roadmap recalculated: 83.85%, unchanged. This source preparation does not establish operational readiness.
