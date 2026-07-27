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
On Track (with one hard external blocker -- see Blockers)

## Current Phase
Phase 4: Core Solana Program (in progress -- architecture locked, full v1 instruction set written, unverified pending toolchain)

## Current Objective
Reach a functional SSR Protocol on Solana DevNet: an independent, Solana-native tokenized-reserve program, built using Reserve Protocol's Folio (EVM/Solidity) as reference-only material, with a locked account/authority model, a full instruction set, a TypeScript SDK, and (once unblocked) a real DevNet deployment wired to the existing frontend.

## Executive Summary
Protocol work has moved from "not started" to "designed and coded, awaiting a working Rust/Solana/Anchor toolchain to compile, test, and deploy." This session: inspected the entire SSR.fun frontend as the product specification (surfacing that it contains two incompatible economic models -- see Decisions Required); cloned and deeply studied Reserve Protocol's official `reserve-index-dtf` (Folio) repository as reference-only material; locked the account model, PDA scheme, authority boundaries, and instruction set; hand-wrote the full Anchor program (17 instructions, all state/error/event types) and a TypeScript SDK; wrote an Anchor integration test suite. None of the Rust code has been compiled -- the working environment has no Rust/Solana/Anchor toolchain and no WSL, which is a hard blocker for build, test, and DevNet deployment. Everything that doesn't require that toolchain (research, architecture, source code, SDK, TypeScript typecheck) was completed and, where possible, actually validated.

## Last 5 Working Days
- **2026-07-27 (Mon):** [Dashboard work, same day, see below] **Plus, protocol work:** inspected the full SSR frontend as product spec; cloned and analyzed Reserve Protocol's Folio reference repo; locked SSR's account/authority/instruction architecture (Anchor, SPL Token for the Reserve Token mint, 12-asset v1 cap); wrote the complete v1 Anchor program source and a TypeScript SDK; wrote an Anchor test suite; discovered and adapted to Anchor's 1.0 stable release (a major-version jump past commonly-known 0.3x versions); identified a hard toolchain blocker (no Rust/Solana/Anchor/WSL in this environment) and documented three concrete ways to unblock it. Dashboard work (same day, earlier): migrated hosting to Vercel, connected the custom domain, hardened the testing deployment as unlisted, built the password-protected `/internal/status` dashboard, and fixed its login-lockout bug (DEC-0008).
- **2026-07-24 (Fri):** Unified Reserve card components across the homepage and Discover page, added a real (simulated) wallet-connect modal, expanded the Portfolio page, and completed a terminology pass to align all copy on "Reserve" / "Launch Reserve."
- **2026-07-23 (Thu):** Rebuilt the homepage to match the approved reference design, ported the Discover / Create / Portfolio / Manage / Reserve-detail flows from the SSR.FUN-MERGE prototype, added the eagle seal logo and favicon, and fixed layout issues in the Create-a-Reserve stepper.
- **2026-07-22 (Wed):** No recorded repository activity.
- **2026-07-21 (Tue):** No recorded repository activity.

## Recently Completed
- **Gate 1 (research):** Full frontend inspection (routes, domain types, seed data, calculations, state, every flow) producing an internal frontend-action-to-instruction implementation map (`docs/protocol/FRONTEND_INTEGRATION.md`). Reserve Protocol's `reserve-index-dtf` (Folio) cloned to `C:\Users\JRA DEVNET\Projects\references\reserve-protocol` (commit `f02680d`, MIT) and studied at the contract level (not just README); analysis in `docs/protocol/RESERVE_REFERENCE_ANALYSIS.md`.
- **Gate 2 (architecture lock):** `docs/protocol/SSR_ARCHITECTURE.md` and `docs/protocol/ACCOUNT_MODEL.md` -- Anchor framework, SPL Token (classic) for the Reserve Token mint with per-asset Token-2022 support, PDA seed scheme, 12-asset v1 cap, authority/delegate model, all recorded as DEC-0009 through DEC-0019.
- **Gates 3-5 (program):** Full Anchor workspace (`Anchor.toml`, `Cargo.toml`, `programs/ssr_protocol/`) with all 17 v1 instructions written: `initialize_protocol`, `create_reserve`, `initialize_reserve_asset`, `seed_reserve`, `mint_reserve_tokens_in_kind`, `redeem_reserve_tokens_in_kind`, `update_targets`, `add_delegate`, `update_delegate_permissions`, `remove_delegate`, `transfer_reserve_manager`, `pause_reserve`, `unpause_reserve`, `accrue_fees`, `collect_fees`, `record_rebalance`, `update_metadata`. **Not compiled** -- see Blockers.
- **Gate 6 (SDK):** `packages/sdk` -- PDA derivation, deterministic-integer mint/redeem/seed calculators mirroring the Rust math, a thin client class. **Typechecks successfully against the real, currently-installed `@anchor-lang/core@1.1.2`, `@solana/web3.js`, `@solana/spl-token`** (`npx tsc --noEmit`, zero errors) -- genuine, if partial, validation.
- **Gate 7 (partial):** TypeScript SDK and test-suite typecheck (above) both pass. Rust build/lint/test, and frontend integration (Gate 10), remain blocked.
- Full documentation set: `RESERVE_REFERENCE_ANALYSIS.md`, `SSR_ARCHITECTURE.md`, `ACCOUNT_MODEL.md`, `INSTRUCTION_REFERENCE.md`, `SECURITY_INVARIANTS.md`, `DEVNET_RUNBOOK.md`, `FRONTEND_INTEGRATION.md`, `TEST_PLAN.md` under `docs/protocol/`.
- Dedicated branch `protocol/devnet-v1` established for all of the above; prior uncommitted dashboard work preserved untouched throughout.
- (Unrelated, same day) Dashboard: password-gated `/internal/status` with configurable login rate limiting (DEC-0008).

## In Progress
- Phase 4 (Core Solana Program): source complete, **awaiting a working Rust/Solana/Anchor toolchain to compile and verify** -- see Blockers.
- Phase 5 (Client and Frontend Integration): SDK skeleton done and typechecked; no frontend wiring has started (blocked behind a real deployed program + generated IDL).

## Next Actions
1. **Resolve the toolchain blocker** (see Blockers) -- this is the single gating item for all further verified progress.
2. Once unblocked: `anchor build`, fix whatever the compiler finds (three specific highest-risk spots are pre-identified in `docs/protocol/DEVNET_RUNBOOK.md`), then `anchor test`.
3. Deploy to DevNet with a fresh dev authority keypair; record the program ID/signature in `docs/protocol/DEVNET_RUNBOOK.md`.
4. Stand up DevNet fixtures (per `docs/protocol/TEST_PLAN.md`/mission fixture requirements) and begin Gate 10 frontend integration in the mission's specified order.
5. Resolve the two flagged product/design decisions under Decisions Required below.

## Roadmap

```json
[
  { "phase": 1, "name": "Frontend Foundation", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 2, "name": "Protocol Research and Gap Analysis", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 3, "name": "Solana Reserve Architecture", "weight": 15, "completion": 1.0, "status": "done" },
  { "phase": 4, "name": "Core Solana Program", "weight": 20, "completion": 0.4, "status": "in_progress" },
  { "phase": 5, "name": "Client and Frontend Integration", "weight": 15, "completion": 0.15, "status": "in_progress" },
  { "phase": 6, "name": "DevNet Testing and Security Validation", "weight": 15, "completion": 0.05, "status": "in_progress" },
  { "phase": 7, "name": "Restricted Beta", "weight": 10, "completion": 0.0, "status": "not_started" },
  { "phase": 8, "name": "Production Readiness", "weight": 5, "completion": 0.0, "status": "not_started" }
]
```

## Blockers
- **No Rust/Solana/Anchor toolchain (and no WSL) in the working environment.** Confirmed absent: `rustc`, `cargo`, `solana` CLI, `anchor` CLI, `avm`; `wsl --list` reports WSL itself isn't installed. This blocks compiling `programs/ssr_protocol`, running `anchor test`, generating a real program keypair/ID, and any DevNet deployment -- i.e. Gates 7 (Rust portion), 8, and 9 entirely. Three concrete unblocking paths are documented in `docs/protocol/DEVNET_RUNBOOK.md` (install WSL2, use a cloud/Linux devcontainer, or have someone with an existing Linux/macOS Solana setup build+test the already-written source). **This requires a user decision on which path to take** -- installing WSL2 is a disruptive, restart-likely system change this session did not perform autonomously (see DEC-0022).

## Dependencies
- Vercel (hosting, deployment, custom domain, and the environment variable used by the internal dashboard).
- Name.com (domain registrar and DNS for `strategic-super-reserve.fun`).
- **Solana DevNet access -- now an active dependency** (Phase 4 has started). Blocked on the toolchain gap above, not on DevNet itself being reachable (DevNet RPC access was confirmed reachable over the network during this session).
- Reserve Protocol's `reserve-index-dtf` reference repository (read-only, external to this repo, at `C:\Users\JRA DEVNET\Projects\references\reserve-protocol`) -- reference material only, not a runtime dependency.

## Risks
- **No automated test suite has ever actually executed for the protocol code.** A full Anchor test suite exists (`tests/ssr_protocol.ts`) and typechecks, but has never run against a compiled program -- see Blockers. Treat all protocol-side correctness claims as "designed and written," not "verified," until Gate 7 completes for real.
- **`instructions/common.rs::validate_asset_mint_extensions`'s Token-2022 extension-introspection code is the single highest-risk-of-needing-a-fix spot** in the whole program (written from memory without a compiler) -- flagged explicitly in the code and in `docs/protocol/DEVNET_RUNBOOK.md`.
- **The frontend contains two incompatible economic models** (a dead in-kind NAV mint/redeem model and a live AMM buy/sell model) -- resolved for the *protocol's* design per DEC-0009, but the frontend itself still needs new UI for proportional mint/redeem before Gate 10 can meaningfully complete. See Decisions Required.
- **No automated test suite exists for the dashboard/frontend either** (pre-existing risk, unchanged). Typecheck and build are the only automated verification for that code today.
- **Main JS bundle exceeds 500 kB** (pre-minification chunk-size warning from Vite, pre-existing, unchanged). Will compound as Phase 5 adds real client/on-chain integration code.
- **The general testing site relies on obscurity, not authentication** (see Decision Log DEC-0004/DEC-0005, unchanged, pre-existing).
- **`collect_fees`'s protocol fee destination is not yet cross-checked against any canonical config field** -- flagged in `docs/protocol/SECURITY_INVARIANTS.md` "Outstanding gaps," needs a fix before this instruction should be trusted with real funds.

## Decisions Required
- **How to close the toolchain gap** (WSL2 install / cloud devcontainer / teammate with existing setup) -- see Blockers. Needed before any further protocol progress can be verified.
- **Whether/when to build the new proportional-mint/redeem frontend UI** (does not exist yet in any form) versus continuing to treat the existing AMM Buy/Sell UI as the near-term user-facing surface while the real protocol work continues underneath it. See `docs/protocol/FRONTEND_INTEGRATION.md`.
- Should the general testing site move from "unlisted" to real authentication before it's shared with anyone outside the immediate team? (pre-existing, unchanged)

## Technical Health
- **Frontend typecheck:** passing (`tsc -b`), unaffected by protocol work.
- **Frontend build:** passing (`vite build`), unaffected by protocol work.
- **SDK typecheck (`packages/sdk`):** passing (`npx tsc --noEmit`, zero errors) against real installed packages.
- **Protocol test-suite typecheck (`tests/`, `tsconfig.tests.json`):** passing (`npx tsc --noEmit`, zero errors) against real installed packages. **Never executed against a compiled program.**
- **Rust build (`cargo build`/`anchor build`):** **not run -- no toolchain available.**
- **Rust/Anchor tests:** **not run -- no toolchain available.**
- **Lint:** `oxlint` (frontend) configured and available; `cargo clippy`/`cargo fmt` (protocol) not run -- no toolchain available.
- **CI:** none configured; deploys are manual and intentional (see Decision Log DEC-0001).

## Environment Status
- **Local:** `npm run dev` (Vite dev server) for the frontend -- unchanged. Protocol code has no local runnable environment yet (no toolchain).
- **Development:** Vercel Preview deployments for the frontend, unchanged.
- **DevNet:** Not yet provisioned -- no program has been built or deployed. RPC reachability confirmed; deployment itself blocked on the toolchain gap.
- **Production:** `https://strategic-super-reserve.fun` -- live, frontend-only simulation, kept unlisted, unaffected by protocol work.

## Last Updated
2026-07-27 20:15 UTC
