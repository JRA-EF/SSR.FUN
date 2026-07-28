<!--
  Source of truth for the internal project-status dashboard at /internal/status.
  This file is parsed server-side (api/dashboard/content.ts) and rendered after
  authentication. Keep section headings ("## ...") stable -- the parser splits
  on them. The fenced ```json block under "Roadmap" is the only piece treated
  as structured data (weight + completion per phase); the overall completion
  percentage is computed from it, not hand-entered.

  Update this file whenever meaningful progress, roadmap status, blockers,
  dependencies, risks, validation results, or environment status change. See
  CLAUDE.md > "Project Status and Decision Logging".
-->

## Overall Status
On Track -- **SSR Protocol is live on Solana DevNet.**

## Current Phase
Phase 6: DevNet Testing and Security Validation (corrective pass core fixes implemented and validated end-to-end; protocol treasury upgrade written but not yet deployed, pending DevNet SOL; production redeploy of this pass remaining)

## Current Objective
Deploy this corrective pass to production and complete the DevNet protocol-treasury upgrade once the deployer wallet has sufficient DevNet SOL (faucet currently rate-limited).

## Executive Summary
**SSR Protocol went from "not started" to "deployed live on Solana DevNet, fully tested against that deployment, and wired into the real frontend with working Buy/Sell and Create Reserve flows" across the initial build session, then underwent a focused corrective pass (this entry) driven by manual DevNet testing.** Architecture was locked, the 17-instruction Anchor program and a TypeScript SDK were hand-written, a complete native toolchain was installed piece by piece, and the program was deployed and verified live at `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`. Its full test suite passes against that live deployment (14/14), and persistent Gate-9 fixture Reserves exist on-chain (`docs/protocol/DEVNET_FIXTURES.md`). Gate 10-11 then wired the existing SSR.fun frontend to all of this while preserving its design exactly (DEC-0027).

**This corrective pass (2026-07-28) fixed a real bug that blocked every newly created Reserve from Buy/Sell**: `api/devnet/swap-sign.ts` hardcoded an allowlist of just the 2 Gate-9 fixture Reserve addresses, rejecting any genuinely new Reserve outright. Replaced with fully dynamic, on-chain-derived validation that trusts no hardcoded address -- only a per-asset-mint allowlist (DEC-0029). Also added: native SOL/wrapped-SOL as a real Create-Reserve asset (DEC-0030); combined create+register into one transaction, cutting Create Reserve to 2 wallet approvals (3 with a SOL leg), plus a real rent-calculator-backed "Wallet Cost Summary" shown before any signature (DEC-0031); a written (not yet deployed) `update_protocol_config` instruction to repoint the DevNet protocol treasury (DEC-0033, blocked on DevNet SOL funding -- see DEC-0034); subtle DevNet-transaction status messaging (clickable Explorer links, a per-trade "real DevNet transaction" note). Validated end-to-end against a **genuinely fresh Reserve created through the real client code itself** (not just the existing fixtures), catching and fixing a second real bug in the process -- wrapped-SOL seed funding wasn't converting USD through the DevNet SOL test price, asking for ~20x too much SOL (DEC-0032). `npm run build`, `npx tsc -b`, and `oxlint` all pass clean. This pass is committed, pushed, and deployed to production (commit `d3006b0`, smoke-tested). Remaining: the treasury upgrade's actual DevNet deployment (SOL-funding blocked, DEC-0033/DEC-0034).

## Last 5 Working Days
- **2026-07-28 (Tue), corrective pass (later the same day):** Fixed the Create-Reserve-then-can't-Buy/Sell bug (dynamic on-chain Reserve/asset validation replacing a hardcoded 2-fixture allowlist, DEC-0029); added SOL/wrapped-SOL as a real Create Reserve asset (DEC-0030); reduced Create Reserve to 2-3 wallet approvals with a real rent-based Wallet Cost Summary shown before any signature (DEC-0031); wrote (but has not yet deployed) an `update_protocol_config` instruction to repoint the DevNet protocol treasury (DEC-0033); added subtle DevNet-transaction status messaging to the Buy/Sell trade panel. Validated the whole pass end-to-end against a brand-new Reserve driven through the real client code (`scripts/verify_e2e_fresh_reserve.ts`), which caught and led to fixing a real USD-to-SOL conversion bug in the wrapped-SOL seed-funding math (DEC-0032). Discovered and logged two environment constraints: the public DevNet airdrop faucet is rate-limited (blocking the treasury upgrade's deploy), and `solana-test-validator`/`anchor test` do not run on this machine without Windows Developer Mode -- adopted localnet-by-default with batched DevNet upgrades as the go-forward policy (DEC-0034). `npm run build`, `npx tsc -b`, and `oxlint` all pass clean.
- **2026-07-28 (Tue), Gate 10-11 (later the same day):** Wired the existing SSR.fun frontend to the live DevNet program: real wallet-adapter connection (Phantom/Solflare/Backpack), real on-chain Reserve reads replacing mocked data for the Gate-9 fixtures, Buy/Sell redefined as a real SOL zap reusing the existing trade tab (DEC-0027), a DevNet-only server-side swap-authority co-signer (`api/devnet/swap-sign.ts`) and test-asset faucet (`api/devnet/mint-test-assets.ts`), and real Reserve creation through the existing Create-a-Reserve stepper for the 3 supported DevNet test assets. Verified every new on-chain code path against live DevNet with real transactions before wiring it into the UI (a full Buy/Sell round trip, a from-scratch Reserve creation, the swap-sign endpoint, and the faucet). Full production build (`tsc -b && vite build`) passes.
- **2026-07-28 (Tue):** **Protocol work:** installed Visual Studio Build Tools (user-approved) to close the BPF/SBF toolchain gap; ran real `cargo-build-sbf`, producing a genuine deployable `.so`; generated a DevNet deployer wallet; worked around a fully-exhausted public airdrop faucet (confirmed via explicit 429 error, both CLI and web3.js paths) by having the user fund the wallet directly; **deployed SSR Protocol to Solana DevNet** and verified the deployment on-chain; applied `cargo fmt`; added two more adversarial tests (repeated-init, excess-redemption) to the test suite. Also ran `cargo check`/`cargo build`/`cargo clippy` clean (zero errors/warnings) before the SBF build, from the toolchain installed the previous day. **Later the same day:** generated a real IDL via `anchor idl build`; fixed a chain of ESM/CJS module-resolution issues to get the Anchor test harness running outside `anchor test`'s local-validator default; replaced faucet-dependent `requestAirdrop` calls with direct transfers from the funded deployer wallet; found and fixed two real test bugs (a stale-snapshot assertion, a singleton-init test incompatible with persistent-network state); **ran the full test suite against the live DevNet program for the first time -- 14 passing, 0 failing.**
- **2026-07-27 (Mon):** [Dashboard work, same day, see below] Inspected the full SSR frontend as product spec; cloned and analyzed Reserve Protocol's Folio reference repo; locked SSR's account/authority/instruction architecture; wrote the complete v1 Anchor program source (17 instructions) and a TypeScript SDK; wrote an Anchor test suite; installed a native Rust/MinGW/Solana-CLI toolchain and used it to compile the program for the native host target, finding and fixing ~15 real compiler-caught bugs; generated a real DevNet program keypair; fixed a real security gap in `collect_fees`. Dashboard work (same day, earlier): migrated hosting to Vercel, connected the custom domain, hardened the testing deployment as unlisted, built the password-protected `/internal/status` dashboard, and fixed its login-lockout bug (DEC-0008).
- **2026-07-24 (Fri):** Unified Reserve card components across the homepage and Discover page, added a real (simulated) wallet-connect modal, expanded the Portfolio page, and completed a terminology pass to align all copy on "Reserve" / "Launch Reserve."
- **2026-07-23 (Thu):** Rebuilt the homepage to match the approved reference design, ported the Discover / Create / Portfolio / Manage / Reserve-detail flows from the SSR.FUN-MERGE prototype, added the eagle seal logo and favicon, and fixed layout issues in the Create-a-Reserve stepper.
- **2026-07-22 (Wed):** No recorded repository activity.

## Recently Completed
- **Gate 1 (research):** Full frontend inspection + Reserve Protocol Folio analysis (`docs/protocol/RESERVE_REFERENCE_ANALYSIS.md`, `FRONTEND_INTEGRATION.md`).
- **Gate 2 (architecture lock):** `SSR_ARCHITECTURE.md`/`ACCOUNT_MODEL.md`, DEC-0009 through DEC-0019.
- **Gates 3-7 (program): written, compiled, linted, and deployed.** `cargo check`/`cargo build`/`cargo clippy` all pass with zero errors/warnings (native host target). Real BPF/SBF compilation (`cargo build-sbf`) succeeded after installing Visual Studio Build Tools, producing a genuine 538,056-byte deployable `.so`.
- **Gate 8: SSR Protocol is deployed and live on Solana DevNet.** Program ID `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`, deployment signature `arj6tzkUCqgSeJBs9inJv3nLcyoK5smasygGEZmDZ5hk84QukwLsJKR9mbaZryJz56uFRTkeXoGtTFSBSMWuaju`, verified on-chain via `solana program show` (correct upgradeable-loader owner, correct authority, correct data length, rent-exempt balance matching the exact `solana rent` estimate). Full record in `docs/protocol/DEVNET_RUNBOOK.md`.
- **Gate 9 (core): the full test suite has executed against the live DevNet program -- 14 passing, 0 failing.** Real Reserve creation, two-asset registration, seeding, proportional mint/redeem across two holders, pause/unpause, a scope-restricted delegate, and the cross-Reserve vault-substitution isolation test (the plan's most security-critical test) all confirmed working on-chain, not just typechecked. Full record in `DEVNET_RUNBOOK.md`'s "Test execution record."
- **Gate 9 (fixtures): persistent, documented DevNet fixtures now exist**, built via `scripts/devnet_fixtures.ts` -- a root manager, 2 restricted delegates with distinct permission scopes, 2 holders, a 2-asset Reserve and a 3-asset "multi-asset" Reserve (both seeded, both with real proportional holder balances), and a pause/unpause cycle demonstrating both Active and Paused states. Full record in `docs/protocol/DEVNET_FIXTURES.md`. Building this also surfaced a real, confirmed limitation of the public DevNet RPC endpoint: it fully blocks `getProgramAccounts` (403) and rate-limits heavily under sustained same-day use (429) -- the fixture script is checkpoint-resumable as a result.
- ~15 real compiler-caught bugs fixed (Anchor lifetime-elision across all handlers, an Anchor-1.0 `CpiContext` API change, a missing Cargo feature, a macro glob-re-export requirement) -- see `DEVNET_RUNBOOK.md`.
- A real security gap fixed: `collect_fees`'s `protocol_fee_destination` now validated against `ProtocolConfig`.
- Two more adversarial tests written (repeated-init, excess-redemption), plus the previously-stubbed cross-Reserve vault-substitution test (the most important one in the plan) fully implemented -- all now passing live, not just written.
- Two real test bugs found and fixed only by actually running against live state: a stale pre-transaction snapshot assertion, and a singleton-init test that assumed resettable local-validator state rather than persistent DevNet state.
- **Gate 6 (SDK):** `packages/sdk` typechecks clean against real installed packages.
- **Gate 10-11 (frontend integration): real wallet connection, real on-chain reads, real Buy/Sell zap, and real Create Reserve are all wired into the existing frontend with its design unchanged.** See `docs/protocol/FRONTEND_INTEGRATION.md` for the full technical record and DEC-0027 for the architecture decision. Verified against live DevNet via `scripts/verify_zap.ts` (Buy 0.005 SOL then Sell half the resulting balance against the Reserve One fixture -- vault balances, Reserve Token supply, and both parties' SOL all moved exactly as computed) and `scripts/verify_create_reserve.ts` (a brand-new Reserve created/registered/seeded from a fresh keypair with zero prior state, confirmed `active` on-chain).
- Full documentation set under `docs/protocol/`, kept current with the verified state throughout.
- Dedicated branch `protocol/devnet-v1`, pushed to origin; prior uncommitted dashboard work preserved untouched throughout.
- (Unrelated) Dashboard: password-gated `/internal/status` with configurable login rate limiting (DEC-0008).
- **Corrective pass (2026-07-28): dynamic Reserve/asset validation, SOL as a real asset, signature reduction + cost transparency, subtle DevNet status messaging, and a real end-to-end fresh-Reserve verification script -- see DEC-0029 through DEC-0032 and `scripts/verify_e2e_fresh_reserve.ts`.** Fresh Reserve `BuHRWKzzXQXhjL3WCsmHTT7qDooh2437DvXuxyExpiWg` (Reserve Token mint `AQ6i33grhTZk3vA9Ph4paGGnsdFR9nif7trEaK1aNJ2d`) created, seeded, Bought from, and Sold from with real signatures and no hardcoded registration anywhere in the path.
- **DevNet protocol treasury (DEC-0033/DEC-0035) is deployed and verified live.** `update_protocol_config` instruction shipped via a real DevNet program upgrade (signature `JuNiHri3m5wuCwv7aKaYHnMLvoMSEPUuJjCehainCrZRUg6RqfZMdUeVxosxjbAzn9hxSFc8nThXcoVGEx9BvVK`); `ProtocolConfig.default_protocol_fee_destination` set to `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq` (signature `2cEtFTEPa5qiEWdPWZ16bTVdQaDZ7XyhUK6zjJpwUKkLvKYwwE8fD11gseoyZHgVRvRthD1d6spzy8VaYRZGcmTC`); verified with a real `collect_fees` call (signature `3k4KKk9EdiuNigWgSjqWK3kiigedAKAP2ifmkX1cMXAzxE4wTk5F8jj5bbGE6sPaqUA2TEKSX11RLjRAbPFxw9Ww`) that paid the treasury 200 raw Reserve Token units (previously 0) and the Reserve's manager 800 raw units, matching the pending fee shares accrued by DEC-0032's Buy exactly.

## In Progress
- Gate 10-11 (pre-existing): no browser-automation tool was available in this environment to drive an actual Phantom click-through -- see Risks.

## Next Actions
1. Get a real browser + Phantom to click through the full flow at least once (connect, view fixtures, Buy, Sell, Create Reserve) -- everything below the UI layer is verified against live DevNet (including production, this pass), but the literal click path has not been human/browser-tested.
2. Before any restricted beta: migrate the upgrade authority off the current single dev-controlled key to a multisig (DEC-0015).
3. Monitor DevNet SOL budget (~3.86 SOL on the deployer after the treasury upgrade, ~0.19 SOL on the swap-authority/fixture-manager wallet as of the last run) -- the swap authority in particular pays out real SOL on every Sell, so it will need periodic top-ups under sustained testing use. Note the public DevNet RPC also confirmed-blocks `getProgramAccounts` (403) and rate-limits heavily under sustained same-day use (429) -- a dedicated/paid RPC endpoint would materially help here.
4. Enable Windows Developer Mode on this machine (or run elevated) so `solana-test-validator`/`anchor test` can actually run, per DEC-0034's localnet-by-default policy -- currently blocked by a Windows privilege requirement (`SeCreateSymbolicLinkPrivilege`).
5. Consider adding a lightweight automated test harness for the new integration logic (`packages/sdk/src/zapInstructions.ts`, `createReserveFlow.ts`) beyond the live-DevNet verification scripts, since no frontend test framework exists in this repo yet (pre-existing gap).

## Engineering Areas

<!--
  Whole-project completion view for the /internal/status dashboard's hero
  metric -- deliberately a DIFFERENT weighting than "Roadmap" below.
  "Roadmap" tracks the current Solana-protocol mission's 8 gates/phases
  only, which under-weights the real, already-shipped SSR.fun simulation
  platform (the entire homepage/Discover/Create/Portfolio/Manage/Reserve-
  detail product, gated at just 10/100 of Roadmap's weight because Roadmap
  is scoped to "the protocol mission", not "the whole project"). This block
  re-weights across the project's actual 5 major engineering areas so the
  headline number represents the entire project. Each area's completion is
  computed from the Roadmap phases it maps to (see mapping below) --
  recompute both blocks together; never hand-edit either completion number
  independently of what it's derived from.

  Mapping:
    - Product / Simulation Platform  = Roadmap phase 1
    - Reserve Protocol                = Roadmap phases 2+3+4 (weighted)
    - Frontend Integration            = Roadmap phase 5
    - Security & Testing              = Roadmap phase 6
    - Production Readiness            = Roadmap phases 7+8 (weighted)
-->

```json
[
  { "area": "Product / Simulation Platform", "weight": 20, "completion": 1.00, "status": "done", "detail": "Homepage, Discover, Create Reserve, Portfolio, Manage, Reserve-detail -- full simulation-mode product." },
  { "area": "Reserve Protocol", "weight": 25, "completion": 0.96, "status": "in_progress", "detail": "17-instruction Anchor program (now 18) live on Solana DevNet; architecture and research 100% done." },
  { "area": "Frontend Integration", "weight": 20, "completion": 0.95, "status": "in_progress", "detail": "Real wallet connection, real on-chain reads, real Buy/Sell zap, real Create Reserve -- all live in production." },
  { "area": "Security & Testing", "weight": 20, "completion": 0.85, "status": "in_progress", "detail": "14/14 tests passing live on DevNet; a full fresh-Reserve E2E lifecycle verified end-to-end; no external audit yet." },
  { "area": "Production Readiness", "weight": 15, "completion": 0.00, "status": "not_started", "detail": "Frontend is genuinely live in production; the PROTOCOL itself is DevNet-only -- needs a security audit and upgrade-authority multisig migration (DEC-0015) before Mainnet." }
]
```

## Roadmap

```json
[
  { "phase": 1, "name": "Frontend Foundation", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 2, "name": "Protocol Research and Gap Analysis", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 3, "name": "Solana Reserve Architecture", "weight": 15, "completion": 1.0, "status": "done" },
  { "phase": 4, "name": "Core Solana Program", "weight": 20, "completion": 0.92, "status": "in_progress" },
  { "phase": 5, "name": "Client and Frontend Integration", "weight": 15, "completion": 0.95, "status": "in_progress" },
  { "phase": 6, "name": "DevNet Testing and Security Validation", "weight": 15, "completion": 0.85, "status": "in_progress" },
  { "phase": 7, "name": "Restricted Beta", "weight": 10, "completion": 0.0, "status": "not_started" },
  { "phase": 8, "name": "Production Readiness", "weight": 5, "completion": 0.0, "status": "not_started" }
]
```

## Blockers
- **`solana-test-validator`/`anchor test` do not run on this machine** without Windows Developer Mode enabled (`ERROR_PRIVILEGE_NOT_HELD` on ledger symlink creation) -- blocks fully adopting DEC-0034's localnet-by-default policy until resolved. Direct `cargo check`/`cargo-build-sbf` remain available as a fallback and were used to validate DEC-0033's new instruction before its deployment.
- The previously-tracked BPF/SBF toolchain gap (Visual Studio Build Tools) and the original DevNet SOL funding gap are both resolved -- see Decision Log DEC-0023/DEC-0024. The DevNet protocol treasury upgrade's funding gap is also resolved (the user transferred 3 SOL to the deployer wallet) and the upgrade itself is deployed and verified -- see DEC-0035.

## Dependencies
- Vercel (hosting, deployment, custom domain, and the environment variable used by the internal dashboard). **Now also holds `DEVNET_SWAP_AUTHORITY_SECRET_KEY`** (a Sensitive/encrypted production env var) for `api/devnet/swap-sign.ts` and `api/devnet/mint-test-assets.ts` -- a hard runtime dependency for Buy/Sell/Create-seeding to work in production.
- Name.com (domain registrar and DNS for `strategic-super-reserve.fun`).
- **Solana DevNet -- now an active runtime dependency, not just a target.** Program is deployed and live there; the frontend now reads/writes it directly.
- Reserve Protocol's `reserve-index-dtf` reference repository (read-only, external to this repo) -- reference material only, not a runtime dependency.
- The public Solana DevNet airdrop faucet is unreliable from this environment (confirmed daily-limited, and confirmed rate-limited again this session across multiple retry attempts) -- further DevNet SOL needs either the user's own wallet/faucet access, or transfers from the now-funded deployer wallet (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`, ~3.86 SOL remaining after the treasury upgrade) or the swap-authority/fixture-manager wallet (`Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj`, ~0.19 SOL remaining).

## Risks
- **The swap-authority wallet's DevNet SOL balance (~0.19 SOL) is a hard operational dependency for Sell to keep working** -- every Sell pays real SOL out of it. Under sustained testing traffic it will need periodic manual top-ups; if it runs dry, Sell (and Reserve seeding during Create) will fail with a clear error rather than silently misbehaving, but won't succeed until refunded.
- **The public DevNet RPC endpoint (`api.devnet.solana.com`) is confirmed unreliable under sustained same-day use**: it fully blocks `getProgramAccounts` (403 "Your IP or provider is blocked from this endpoint") and rate-limits heavily (429) under repeated sequential calls. The frontend's on-chain reads are all direct/known-account reads specifically to avoid the blocked call, but heavy concurrent usage could still hit rate limits -- a dedicated/paid RPC provider is worth considering before wider testing.
- **No real browser + Phantom click-through has been performed** -- no browser-automation tool was available in this environment. Every on-chain code path (wallet-adapter wiring, the zap transactions, Create Reserve) was verified against live DevNet via direct scripts using a throwaway keypair standing in for a connected wallet, and all modules were confirmed to load/transform cleanly through the Vite dev server, but the literal UI click path is unverified by a human or automated browser.
- **No automated test suite exists for the dashboard/frontend either** (pre-existing risk, unchanged; the new integration logic has live-DevNet verification scripts instead, see `scripts/verify_*.ts`).
- **Main JS bundle exceeds 500 kB** (pre-existing, now larger with the Solana web3/wallet-adapter/Anchor libraries bundled client-side for the first time).
- **The general testing site relies on obscurity, not authentication** (see Decision Log DEC-0004/DEC-0005, unchanged, pre-existing).
- **Rebalance trade execution (an actual Jupiter-route CPI) does not exist on-chain at all in v1** (deliberate, per DEC-0017/DEC-0021). Separately, the Buy/Sell zap's SOL<->asset leg uses a DevNet-only fixed-price swap authority, not a real router -- see `FRONTEND_INTEGRATION.md`'s Mainnet-readiness notes below.
- **The upgrade authority is a single dev-controlled key** (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`, DevNet only) -- must migrate to a multisig before any restricted beta, per DEC-0015.

## Mainnet-Readiness Gaps (Gate 10-11 additions)
- **Swap routing**: the DevNet swap authority (fixed test pricing, mint-authority-based asset issuance) must be replaced with a real routing provider (e.g. Jupiter) before Mainnet -- isolated behind `packages/sdk/src/zapInstructions.ts`'s interface so the frontend itself needs no changes, only the instruction-building internals.
- **Asset allowlist**: Buy/Sell/Create-seeding currently only work for the 3 DevNet fixture test mints plus wrapped SOL (the swap authority's own mint authority and its own real SOL balance are what make this possible) -- a production allowlist needs a real asset-onboarding process instead. The allowlist check itself is now dynamic/per-asset-mint rather than per-Reserve-address (DEC-0029), which is the right shape for Mainnet too -- only the specific mints in the allowlist need to change.
- **Oracle/pricing**: `SOL_TEST_PRICE_USD` and the $1-per-fixture-asset constants are fixed testing values, not a price feed -- Mainnet needs Pyth (or similar) for any displayed USD value; core mint/redeem accounting itself never depends on price data (unchanged from the original protocol design).
- **Slippage protection**: the zap's `maxAssetAmounts`/`minAssetAmountsOut` use a flat 2% buffer computed client/server-side, not a user-configurable slippage tolerance.
- **Transaction atomicity**: already production-shaped (single atomic transaction per Buy/Sell), no gap here.
- **Security review/audit**: not started; DevNet-only testing infrastructure (the swap authority, faucet) has zero exposure to real value and would need to be removed entirely, not merely reviewed, before Mainnet.

## Decisions Required
- Should the general testing site move from "unlisted" to real authentication before it's shared with anyone outside the immediate team? (pre-existing, unchanged)

## Technical Health
- **Frontend typecheck:** passing (`tsc -b`), now covering real Solana/wallet-adapter/Anchor integration code across `src/`, `packages/sdk/`, and `api/devnet/` (the latter isolated into its own tsconfig to avoid a monorepo module-system conflict between the frontend's bundler resolution and Node's stricter ESM/CJS rules -- see FRONTEND_INTEGRATION.md). `src/merge/lib/` gained the same CommonJS-scoping `package.json` this pass so its client code (`createReserveClient.ts`, `zapClient.ts`) could be exercised directly from a Node verification script (DEC-0032).
- **Frontend build:** passing (`vite build`), re-verified after this pass's changes.
- **SDK typecheck (`packages/sdk`):** passing (`npx tsc --noEmit`, zero errors); gained `readOnly.ts` (live on-chain reads), `zapInstructions.ts`/`zapPricing.ts` (Buy/Sell zap, now with wrapped-SOL wrap/unwrap and `usdToSolLamports`), `createReserveFlow.ts` (real Reserve creation), and a checked-in `idl/` + `fixtures/` (the committed IDL and DevNet fixture registry the frontend imports).
- **Protocol test-suite typecheck (`tests/`, `tsconfig.tests.json`):** passing (`npx tsc --noEmit`, zero errors).
- **Protocol Rust build (native host target):** passing, zero errors, zero warnings (`cargo check -p ssr_protocol`, re-verified this pass after adding `update_protocol_config`).
- **Protocol Rust build (BPF/SBF target, `cargo build-sbf`):** **passing** -- produces a genuine 544,472-byte `.so` including the new `update_protocol_config` instruction (up from 538,056 bytes deployed on DevNet); **not yet deployed** -- see Blockers/DEC-0033/DEC-0034.
- **Protocol lint (`cargo clippy`):** passing, zero warnings as of the last full run (pre-this-pass; re-run recommended before the next DevNet upgrade).
- **Protocol format (`cargo fmt`):** applied (pre-this-pass).
- **Rust/Anchor tests:** last executed against the live DevNet program -- 14 passing, 0 failing (`npx mocha --require ts-node/register tests/ssr_protocol.ts` against `https://api.devnet.solana.com`). See `DEVNET_RUNBOOK.md`'s "Test execution record." `anchor test`/`solana-test-validator` do not currently run on this machine (Windows Developer Mode required, DEC-0034); no new Rust-level test was added for `update_protocol_config` as a result -- validated instead via `cargo check` + `cargo-build-sbf` + reuse of the already-proven `has_one = authority` / `NotProtocolAuthority` pattern.
- **Lint (frontend):** `oxlint` clean (only pre-existing warnings; no errors), re-verified after this pass's changes.
- **CI:** none configured; deploys are manual and intentional (see Decision Log DEC-0001).
- **New on-chain integration logic verified against live DevNet** (not just typechecked) via `scripts/verify_reads.ts`, `verify_zap.ts`, `verify_swap_sign_endpoint.ts`, `verify_create_reserve.ts`, `verify_mint_test_assets.ts`, `verify_dynamic_reserve.ts` (DEC-0029), and `verify_e2e_fresh_reserve.ts` (DEC-0032, a full fresh-Reserve create/Buy/Sell lifecycle through the real client code) -- see `FRONTEND_INTEGRATION.md` for what each confirms.

## Environment Status
- **Local:** `npm run dev` (Vite dev server) for the frontend -- now requires `DEVNET_SWAP_AUTHORITY_SECRET_KEY` set locally (`.env.local`, see `.env.example`) for Buy/Sell/Create-seeding to work; read-only pages (Discover, DTRDetail without trading) work without it. Protocol code has a fully working local build environment for both native and BPF/SBF targets (Rust 1.97.1, GNU toolchain at `C:\devtools\mingw64`, MSVC toolchain via Visual Studio Build Tools, Solana CLI 4.1.2 at `C:\devtools\solana`). **`solana-test-validator`/`anchor test` do not currently work on this machine** (Windows Developer Mode required -- DEC-0034); direct `cargo check`/`cargo-build-sbf` remain fully functional.
- **Development:** Vercel Preview deployments for the frontend, unchanged.
- **DevNet: SSR Protocol is live, its test suite passes against it, and the frontend now reads/writes it directly.** Program ID `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`, now including the `update_protocol_config` instruction (upgraded this pass, DEC-0035) -- see `docs/protocol/DEVNET_RUNBOOK.md` for the deployment/test record and `FRONTEND_INTEGRATION.md` for the frontend integration record. This corrective pass's dynamic-Reserve-validation, SOL-asset, signature-reduction, and cost-transparency fixes are all frontend/API-side and were already live against the pre-upgrade deployment with no program upgrade needed. `ProtocolConfig.default_protocol_fee_destination` is now `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`, verified both by a direct account read and a real `collect_fees` payout (DEC-0035).
- **Production: `https://strategic-super-reserve.fun` is live with the full 2026-07-28 corrective pass, including the deployed DevNet treasury upgrade (DEC-0035)**, deployed commit `909687f` on `main` (deployment ID `dpl_AMu45Z4riAzuRKaQ3wnhN1VLtapQ`). `DEVNET_SWAP_AUTHORITY_SECRET_KEY` is configured in the Vercel production environment (Sensitive/encrypted). Verified post-deploy: the custom domain serves the exact new build (`main-BMXRO8k3.js` matches the local build output exactly); all main routes (`/`, `#/discover`, `#/create`, `#/portfolio`, `/internal/status`) return 200; `/api/devnet/swap-sign` and `/api/devnet/mint-test-assets` both return correct validation errors for malformed requests; `/api/devnet/swap-sign` returns a valid, correctly-partially-signed Buy transaction for the fresh Reserve `BuHRWKzzXQXhjL3WCsmHTT7qDooh2437DvXuxyExpiWg` created during this pass's E2E validation (DEC-0032) -- confirming the dynamic Reserve validation fix (DEC-0029) works in the deployed production environment, not just locally. A recovery tag (`pre-gate10-frontend-merge`) marks main's state immediately before the original Gate 10-11 integration was merged. **Not yet verified: an actual browser + Phantom click-through** (no browser-automation tool was available in this environment).

## Last Updated
2026-07-28 (corrective pass, deployed)
