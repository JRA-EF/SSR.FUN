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
Phase 4: Core Solana Program (substantially complete) / Phase 6: DevNet Testing (core suite now passing live)

## Current Objective
Begin wiring the frontend to the live DevNet program (Gate 10), using the now-real persistent fixtures in `docs/protocol/DEVNET_FIXTURES.md`.

## Executive Summary
**SSR Protocol went from "not started" to "compiled, deployed, live on Solana DevNet, and passing its full test suite against that live deployment" across this session.** Architecture was locked, the full 17-instruction Anchor program and a TypeScript SDK were hand-written, then a complete native toolchain (Rust, a GCC linker, the Solana CLI, and -- with explicit user approval -- Visual Studio Build Tools for the MSVC linker real BPF compilation needs) was installed piece by piece, closing every gap in turn. The program compiles clean (`cargo check`/`cargo build`, zero errors/warnings), passes `cargo clippy` clean, and **is deployed and verified live on DevNet** at program ID `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` (confirmed via `solana program show`). **The full integration/adversarial test suite (`tests/ssr_protocol.ts`) has now actually executed against that live deployment: 14 passing, 0 failing** -- covering Reserve creation, two-asset registration, seeding, proportional mint/redeem across two holders, pause/unpause, a scope-restricted delegate, repeated-init rejection, excess-redemption rejection, and the cross-Reserve vault-substitution isolation test (the single most security-critical test in the plan). Getting here surfaced and fixed ~15 real compiler-caught bugs, one real security gap (`collect_fees`'s unvalidated fee destination), and two real runtime test bugs (a stale-snapshot assertion, and a singleton-init test that assumed a resettable local validator rather than persistent DevNet state). DevNet SOL funding required manual user transfers after the public airdrop faucet's daily limit was confirmed exhausted for this environment; the deployer wallet has ~1.73 SOL remaining, enough for roughly 2 more full suite runs at current funding levels. Next: build persistent, documented Gate 9 fixture wallets, then wire the frontend to the live program (Gate 10).

## Last 5 Working Days
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
- Full documentation set under `docs/protocol/`, kept current with the verified state throughout.
- Dedicated branch `protocol/devnet-v1`, five commits; prior uncommitted dashboard work preserved untouched throughout.
- (Unrelated) Dashboard: password-gated `/internal/status` with configurable login rate limiting (DEC-0008).

## In Progress
- Gate 9: **complete.** The test suite's own real instructions (create Reserve, seed, mint, redeem, delegate management) have run successfully against the live program (14/14 passing), and persistent, documented fixture wallets/Reserves (root manager, 2 restricted delegates with distinct scopes, 2 holders, a 2-asset Reserve, a 3-asset Reserve) now exist as long-lived on-chain state -- see `docs/protocol/DEVNET_FIXTURES.md`.
- Gate 10 (frontend integration): not started, now unblocked by the live deployment, the passing test suite, and real persistent fixtures to point at.

## Next Actions
1. Begin Gate 10 frontend integration in the mission's specified order (wallet → discovery → state → creation → seeding → mint → redeem → ...), using `docs/protocol/DEVNET_FIXTURES.md`'s real Reserves/mints/wallets as the initial data to point the frontend at.
2. Resolve the two flagged product/design decisions under Decisions Required below.
3. Before any restricted beta: migrate the upgrade authority off the current single dev-controlled key to a multisig (DEC-0015).
4. Monitor DevNet SOL budget (~1.29 SOL on the deployer, ~0.20 SOL on the fixture manager wallet as of the last run) -- may need another manual top-up before extensive further on-chain work. Note the public DevNet RPC also confirmed-blocks `getProgramAccounts` (403) and rate-limits heavily under sustained same-day use (429) -- a dedicated/paid RPC endpoint would materially help Gate 10 work.

## Roadmap

```json
[
  { "phase": 1, "name": "Frontend Foundation", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 2, "name": "Protocol Research and Gap Analysis", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 3, "name": "Solana Reserve Architecture", "weight": 15, "completion": 1.0, "status": "done" },
  { "phase": 4, "name": "Core Solana Program", "weight": 20, "completion": 0.9, "status": "in_progress" },
  { "phase": 5, "name": "Client and Frontend Integration", "weight": 15, "completion": 0.2, "status": "in_progress" },
  { "phase": 6, "name": "DevNet Testing and Security Validation", "weight": 15, "completion": 0.55, "status": "in_progress" },
  { "phase": 7, "name": "Restricted Beta", "weight": 10, "completion": 0.0, "status": "not_started" },
  { "phase": 8, "name": "Production Readiness", "weight": 5, "completion": 0.0, "status": "not_started" }
]
```

## Blockers
No blockers currently active. The previously-tracked BPF/SBF toolchain gap (Visual Studio Build Tools) and DevNet SOL funding gap (public airdrop faucet exhausted) are both resolved -- see Decision Log DEC-0023/DEC-0024.

## Dependencies
- Vercel (hosting, deployment, custom domain, and the environment variable used by the internal dashboard).
- Name.com (domain registrar and DNS for `strategic-super-reserve.fun`).
- **Solana DevNet -- now an active runtime dependency, not just a target.** Program is deployed and live there.
- Reserve Protocol's `reserve-index-dtf` reference repository (read-only, external to this repo) -- reference material only, not a runtime dependency.
- The public Solana DevNet airdrop faucet is unreliable from this environment (confirmed daily-limited) -- further DevNet SOL needs either the user's own wallet/faucet access, or transfers from the now-funded deployer wallet (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`, ~1.73 SOL remaining after deployment plus two full test-suite runs).

## Risks
- **DevNet SOL budget is limited and the public faucet is exhausted for this environment.** ~1.29 SOL remains on the deployer wallet, ~0.20 SOL on the fixture manager wallet; each full test-suite run consumes ~0.75 SOL in ephemeral-keypair funding (not reclaimed). Further extensive on-chain work may need another manual top-up from the user.
- **The public DevNet RPC endpoint (`api.devnet.solana.com`) is confirmed unreliable under sustained same-day use**: it fully blocks `getProgramAccounts` (403 "Your IP or provider is blocked from this endpoint") and rate-limits heavily (429) under repeated sequential calls. Gate 10 frontend work hitting this same endpoint should expect the same friction -- a dedicated/paid RPC provider is worth considering before then.
- **The frontend contains two incompatible economic models** (a dead in-kind NAV mint/redeem model and a live AMM buy/sell model) -- resolved for the *protocol's* design per DEC-0009, but the frontend itself still needs new UI for proportional mint/redeem before Gate 10 can meaningfully complete. See Decisions Required.
- **No automated test suite exists for the dashboard/frontend either** (pre-existing risk, unchanged).
- **Main JS bundle exceeds 500 kB** (pre-existing, unchanged).
- **The general testing site relies on obscurity, not authentication** (see Decision Log DEC-0004/DEC-0005, unchanged, pre-existing).
- **Rebalance trade execution (an actual Jupiter-route CPI) does not exist on-chain at all in v1** (deliberate, per DEC-0017/DEC-0021).
- **The upgrade authority is a single dev-controlled key** (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`, DevNet only) -- must migrate to a multisig before any restricted beta, per DEC-0015.

## Decisions Required
- **Whether/when to build the new proportional-mint/redeem frontend UI** (does not exist yet in any form) versus continuing to treat the existing AMM Buy/Sell UI as the near-term user-facing surface while the real protocol work continues underneath it. See `docs/protocol/FRONTEND_INTEGRATION.md`.
- Should the general testing site move from "unlisted" to real authentication before it's shared with anyone outside the immediate team? (pre-existing, unchanged)

## Technical Health
- **Frontend typecheck:** passing (`tsc -b`), unaffected by protocol work.
- **Frontend build:** passing (`vite build`), unaffected by protocol work.
- **SDK typecheck (`packages/sdk`):** passing (`npx tsc --noEmit`, zero errors).
- **Protocol test-suite typecheck (`tests/`, `tsconfig.tests.json`):** passing (`npx tsc --noEmit`, zero errors).
- **Protocol Rust build (native host target):** passing, zero errors, zero warnings.
- **Protocol Rust build (BPF/SBF target, `cargo build-sbf`):** **passing** -- produces a genuine 538,056-byte `.so`, now deployed to DevNet.
- **Protocol lint (`cargo clippy`):** passing, zero warnings (verified on a forced fresh run, not a cached result).
- **Protocol format (`cargo fmt`):** applied.
- **Rust/Anchor tests:** **executed against the live DevNet program -- 14 passing, 0 failing** (`npx mocha --require ts-node/register tests/ssr_protocol.ts` against `https://api.devnet.solana.com`). See `DEVNET_RUNBOOK.md`'s "Test execution record."
- **Lint (frontend):** `oxlint` configured and available.
- **CI:** none configured; deploys are manual and intentional (see Decision Log DEC-0001).

## Environment Status
- **Local:** `npm run dev` (Vite dev server) for the frontend -- unchanged. Protocol code has a fully working local build environment for both native and BPF/SBF targets (Rust 1.97.1, GNU toolchain at `C:\devtools\mingw64`, MSVC toolchain via Visual Studio Build Tools, Solana CLI 4.1.2 at `C:\devtools\solana`).
- **Development:** Vercel Preview deployments for the frontend, unchanged.
- **DevNet: SSR Protocol is live and its test suite passes against it.** Program ID `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` -- see `docs/protocol/DEVNET_RUNBOOK.md` for the full deployment and test-execution record.
- **Production:** `https://strategic-super-reserve.fun` -- live, frontend-only simulation, kept unlisted, unaffected by protocol work.

## Last Updated
2026-07-28 15:10 UTC
