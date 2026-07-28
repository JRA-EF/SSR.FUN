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
Phase 5: Client and Frontend Integration (Gate 10-11 core implementation complete, browser/Phantom click-through validation and production deploy remaining)

## Current Objective
Get a real browser + Phantom to click through the full flow at least once (no browser-automation tool was available to do this directly).

## Executive Summary
**SSR Protocol went from "not started" to "deployed live on Solana DevNet, fully tested against that deployment, and wired into the real frontend with working Buy/Sell and Create Reserve flows" across this session.** Architecture was locked, the 17-instruction Anchor program and a TypeScript SDK were hand-written, a complete native toolchain was installed piece by piece, and the program was deployed and verified live at `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`. Its full test suite passes against that live deployment (14/14), and persistent Gate-9 fixture Reserves exist on-chain (`docs/protocol/DEVNET_FIXTURES.md`). **Gate 10-11 then wired the existing SSR.fun frontend to all of this while preserving its design exactly**: real Phantom/Solflare/Backpack wallet connection (`@solana/wallet-adapter-react`), real on-chain reads for the fixture Reserves (no `getProgramAccounts`, which is confirmed blocked on the public DevNet RPC), and -- per this session's explicit redefinition -- Buy/Sell reusing the existing trade tab as a real SOL zap (Buy = SOL in -> proportional mint; Sell = proportional redeem -> SOL out), executed as a single atomic, two-signer transaction co-signed by a DevNet-only server-side swap authority that independently recomputes every amount from live chain state (DEC-0027). Create Reserve deploys a genuinely new on-chain Reserve when the user picks only the 3 supported DevNet test assets. Every piece of new on-chain logic was verified against live DevNet with real transactions (`scripts/verify_*.ts`) before being wired into the UI -- a full Buy-then-Sell round trip and a from-scratch Reserve creation both succeeded, with vault balances, Reserve Token supply, and SOL moving exactly as expected. `npm run build` (typecheck + production build) passes clean. Remaining: real browser/Phantom click-through (no browser automation tool was available in this environment) and the production deploy itself.

## Last 5 Working Days
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

## In Progress
- Gate 10-11: core implementation complete and verified via direct on-chain scripts (no browser-automation tool was available in this environment to drive an actual Phantom click-through -- see Risks). Production deploy to `strategic-super-reserve.fun` not yet done.

## Next Actions
1. Deploy the integrated frontend to production (`vercel --prod`) and verify `https://strategic-super-reserve.fun` serves it, per the mission's deployment checklist.
2. Get a real browser + Phantom to click through the full flow at least once (connect, view fixtures, Buy, Sell, Create Reserve) -- everything below the UI layer is verified against live DevNet, but the literal click path has not been human/browser-tested.
3. Before any restricted beta: migrate the upgrade authority off the current single dev-controlled key to a multisig (DEC-0015).
4. Monitor DevNet SOL budget (~1.24 SOL on the deployer, ~0.19 SOL on the swap-authority/fixture-manager wallet as of the last run) -- the swap authority in particular pays out real SOL on every Sell, so it will need periodic top-ups under sustained testing use. Note the public DevNet RPC also confirmed-blocks `getProgramAccounts` (403) and rate-limits heavily under sustained same-day use (429) -- a dedicated/paid RPC endpoint would materially help here.
5. Consider adding a lightweight automated test harness for the new integration logic (`packages/sdk/src/zapInstructions.ts`, `createReserveFlow.ts`) beyond the live-DevNet verification scripts, since no frontend test framework exists in this repo yet (pre-existing gap).

## Roadmap

```json
[
  { "phase": 1, "name": "Frontend Foundation", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 2, "name": "Protocol Research and Gap Analysis", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 3, "name": "Solana Reserve Architecture", "weight": 15, "completion": 1.0, "status": "done" },
  { "phase": 4, "name": "Core Solana Program", "weight": 20, "completion": 0.9, "status": "in_progress" },
  { "phase": 5, "name": "Client and Frontend Integration", "weight": 15, "completion": 0.9, "status": "in_progress" },
  { "phase": 6, "name": "DevNet Testing and Security Validation", "weight": 15, "completion": 0.7, "status": "in_progress" },
  { "phase": 7, "name": "Restricted Beta", "weight": 10, "completion": 0.0, "status": "not_started" },
  { "phase": 8, "name": "Production Readiness", "weight": 5, "completion": 0.0, "status": "not_started" }
]
```

## Blockers
No blockers currently active. The previously-tracked BPF/SBF toolchain gap (Visual Studio Build Tools) and DevNet SOL funding gap (public airdrop faucet exhausted) are both resolved -- see Decision Log DEC-0023/DEC-0024.

## Dependencies
- Vercel (hosting, deployment, custom domain, and the environment variable used by the internal dashboard). **Now also holds `DEVNET_SWAP_AUTHORITY_SECRET_KEY`** (a Sensitive/encrypted production env var) for `api/devnet/swap-sign.ts` and `api/devnet/mint-test-assets.ts` -- a hard runtime dependency for Buy/Sell/Create-seeding to work in production.
- Name.com (domain registrar and DNS for `strategic-super-reserve.fun`).
- **Solana DevNet -- now an active runtime dependency, not just a target.** Program is deployed and live there; the frontend now reads/writes it directly.
- Reserve Protocol's `reserve-index-dtf` reference repository (read-only, external to this repo) -- reference material only, not a runtime dependency.
- The public Solana DevNet airdrop faucet is unreliable from this environment (confirmed daily-limited) -- further DevNet SOL needs either the user's own wallet/faucet access, or transfers from the now-funded deployer wallet (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`, ~1.24 SOL remaining) or the swap-authority/fixture-manager wallet (`Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj`, ~0.19 SOL remaining).

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
- **Asset allowlist**: Buy/Sell/Create-seeding currently only work for the 3 DevNet fixture test mints (the swap authority's own mint authority is what makes this possible) -- a production allowlist needs a real asset-onboarding process instead.
- **Oracle/pricing**: `SOL_TEST_PRICE_USD` and the $1-per-fixture-asset constants are fixed testing values, not a price feed -- Mainnet needs Pyth (or similar) for any displayed USD value; core mint/redeem accounting itself never depends on price data (unchanged from the original protocol design).
- **Slippage protection**: the zap's `maxAssetAmounts`/`minAssetAmountsOut` use a flat 2% buffer computed client/server-side, not a user-configurable slippage tolerance.
- **Transaction atomicity**: already production-shaped (single atomic transaction per Buy/Sell), no gap here.
- **Security review/audit**: not started; DevNet-only testing infrastructure (the swap authority, faucet) has zero exposure to real value and would need to be removed entirely, not merely reviewed, before Mainnet.

## Decisions Required
- Should the general testing site move from "unlisted" to real authentication before it's shared with anyone outside the immediate team? (pre-existing, unchanged)

## Technical Health
- **Frontend typecheck:** passing (`tsc -b`), now covering real Solana/wallet-adapter/Anchor integration code across `src/`, `packages/sdk/`, and `api/devnet/` (the latter isolated into its own tsconfig to avoid a monorepo module-system conflict between the frontend's bundler resolution and Node's stricter ESM/CJS rules -- see FRONTEND_INTEGRATION.md).
- **Frontend build:** passing (`vite build`).
- **SDK typecheck (`packages/sdk`):** passing (`npx tsc --noEmit`, zero errors); gained `readOnly.ts` (live on-chain reads), `zapInstructions.ts`/`zapPricing.ts` (Buy/Sell zap), `createReserveFlow.ts` (real Reserve creation), and a checked-in `idl/` + `fixtures/` (the committed IDL and DevNet fixture registry the frontend imports).
- **Protocol test-suite typecheck (`tests/`, `tsconfig.tests.json`):** passing (`npx tsc --noEmit`, zero errors).
- **Protocol Rust build (native host target):** passing, zero errors, zero warnings.
- **Protocol Rust build (BPF/SBF target, `cargo build-sbf`):** **passing** -- produces a genuine 538,056-byte `.so`, now deployed to DevNet.
- **Protocol lint (`cargo clippy`):** passing, zero warnings (verified on a forced fresh run, not a cached result).
- **Protocol format (`cargo fmt`):** applied.
- **Rust/Anchor tests:** **executed against the live DevNet program -- 14 passing, 0 failing** (`npx mocha --require ts-node/register tests/ssr_protocol.ts` against `https://api.devnet.solana.com`). See `DEVNET_RUNBOOK.md`'s "Test execution record."
- **Lint (frontend):** `oxlint` clean (only pre-existing warnings; no errors) after the full Gate 10-11 change set.
- **CI:** none configured; deploys are manual and intentional (see Decision Log DEC-0001).
- **New on-chain integration logic verified against live DevNet** (not just typechecked) via `scripts/verify_reads.ts`, `verify_zap.ts`, `verify_swap_sign_endpoint.ts`, `verify_create_reserve.ts`, `verify_mint_test_assets.ts` -- see `FRONTEND_INTEGRATION.md` for what each confirms.

## Environment Status
- **Local:** `npm run dev` (Vite dev server) for the frontend -- now requires `DEVNET_SWAP_AUTHORITY_SECRET_KEY` set locally (`.env.local`, see `.env.example`) for Buy/Sell/Create-seeding to work; read-only pages (Discover, DTRDetail without trading) work without it. Protocol code has a fully working local build environment for both native and BPF/SBF targets (Rust 1.97.1, GNU toolchain at `C:\devtools\mingw64`, MSVC toolchain via Visual Studio Build Tools, Solana CLI 4.1.2 at `C:\devtools\solana`).
- **Development:** Vercel Preview deployments for the frontend, unchanged.
- **DevNet: SSR Protocol is live, its test suite passes against it, and the frontend now reads/writes it directly.** Program ID `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` -- see `docs/protocol/DEVNET_RUNBOOK.md` for the deployment/test record and `FRONTEND_INTEGRATION.md` for the frontend integration record.
- **Production: `https://strategic-super-reserve.fun` is live with Gate 10-11's full frontend integration**, deployed commit `d1f5ffb` on `main` (deployment ID `dpl_3UCdpdfkGLzLkM3DkH8rrts9bSvj`). `DEVNET_SWAP_AUTHORITY_SECRET_KEY` is configured in the Vercel production environment (Sensitive/encrypted). Verified post-deploy: the live domain serves the exact new build (asset hash matches the local build output); `/api/devnet/swap-sign` and `/api/devnet/mint-test-assets` both return correct validation errors for malformed requests and a correct, real, partially-signed transaction for a valid Buy request against the live Reserve One fixture; all main routes (`/`, `#/discover`, `#/create`, `#/portfolio`, `/internal/status`) return 200. A recovery tag (`pre-gate10-frontend-merge`) marks main's state immediately before this integration was merged. The first deploy attempt crashed both API routes in production (500, `ERR_REQUIRE_ESM` from a transitive dependency) -- found via this post-deploy smoke test, fixed, and redeployed within the same session (DEC-0028). **Not yet verified: an actual browser + Phantom click-through** (no browser-automation tool was available in this environment).

## Last Updated
2026-07-28 18:20 UTC
