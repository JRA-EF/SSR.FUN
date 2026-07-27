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
On Track (with one narrow, well-scoped external blocker -- see Blockers)

## Current Phase
Phase 4: Core Solana Program (in progress -- architecture locked, full v1 instruction set written AND now verified to compile/link cleanly for the native host target; real BPF/SBF compilation still blocked)

## Current Objective
Reach a functional SSR Protocol on Solana DevNet: an independent, Solana-native tokenized-reserve program, built using Reserve Protocol's Folio (EVM/Solidity) as reference-only material, with a locked account/authority model, a full instruction set, a TypeScript SDK, and (once unblocked) a real DevNet deployment wired to the existing frontend.

## Executive Summary
Protocol work has moved from "designed and coded, nothing verified" to "compiles and links cleanly, one narrow gap away from real DevNet deployment." This session: inspected the SSR.fun frontend as product spec; cloned and studied Reserve Protocol's Folio as reference-only material; locked the architecture; hand-wrote the full 17-instruction Anchor program and a TypeScript SDK; then installed a native (non-WSL) Rust/MinGW/Solana-CLI toolchain and used it to actually compile the program, finding and fixing ~15 real bugs in the process (Anchor lifetime-elision pitfalls, a missing Cargo feature, an Anchor-1.0 API change, a macro re-export requirement, and a real security gap in `collect_fees`). `cargo check`/`cargo build` now succeed with zero errors and zero warnings. The one remaining gap is narrow and specific: actual Solana BPF/SBF cross-compilation (`cargo build-sbf`) needs Microsoft's MSVC linker, which requires installing Visual Studio Build Tools -- a multi-GB, proprietary-licensed product judged too large to install autonomously, left as an explicit user decision alongside the previously-documented WSL2 alternative.

## Last 5 Working Days
- **2026-07-27 (Mon):** [Dashboard work, same day, see below] **Protocol work, part 1:** inspected the full SSR frontend as product spec; cloned and analyzed Reserve Protocol's Folio reference repo; locked SSR's account/authority/instruction architecture; wrote the complete v1 Anchor program source (17 instructions) and a TypeScript SDK; wrote an Anchor test suite; identified Anchor's 1.0 stable release and adapted to it. **Protocol work, part 2 (same day, continued session):** installed a native Rust/MinGW/Solana-CLI toolchain (rustup + portable WinLibs GCC + the official Windows Solana CLI release, all user-scoped, no admin/reboot); used it to actually compile the program, finding and fixing ~15 real compiler-caught bugs; generated a real DevNet program keypair; fixed a real security gap in `collect_fees` (unvalidated protocol fee destination); confirmed the one remaining gap is specifically the MSVC linker needed for BPF/SBF cross-compilation. Dashboard work (same day, earlier): migrated hosting to Vercel, connected the custom domain, hardened the testing deployment as unlisted, built the password-protected `/internal/status` dashboard, and fixed its login-lockout bug (DEC-0008).
- **2026-07-24 (Fri):** Unified Reserve card components across the homepage and Discover page, added a real (simulated) wallet-connect modal, expanded the Portfolio page, and completed a terminology pass to align all copy on "Reserve" / "Launch Reserve."
- **2026-07-23 (Thu):** Rebuilt the homepage to match the approved reference design, ported the Discover / Create / Portfolio / Manage / Reserve-detail flows from the SSR.FUN-MERGE prototype, added the eagle seal logo and favicon, and fixed layout issues in the Create-a-Reserve stepper.
- **2026-07-22 (Wed):** No recorded repository activity.
- **2026-07-21 (Tue):** No recorded repository activity.

## Recently Completed
- **Gate 1 (research):** Full frontend inspection producing an internal frontend-action-to-instruction implementation map (`docs/protocol/FRONTEND_INTEGRATION.md`). Reserve Protocol's `reserve-index-dtf` (Folio) cloned to `C:\Users\JRA DEVNET\Projects\references\reserve-protocol` (commit `f02680d`, MIT) and studied at the contract level; analysis in `docs/protocol/RESERVE_REFERENCE_ANALYSIS.md`.
- **Gate 2 (architecture lock):** `docs/protocol/SSR_ARCHITECTURE.md` and `docs/protocol/ACCOUNT_MODEL.md`, recorded as DEC-0009 through DEC-0019.
- **Gates 3-5 (program): written AND now verified to compile.** Full Anchor workspace with all 17 v1 instructions. `cargo check -p ssr_protocol` and `cargo build -p ssr_protocol` (native host target) both succeed with **zero errors, zero warnings** -- a real, evidence-backed milestone, not a claim. ~15 real bugs found and fixed via the compiler (full list in `docs/protocol/DEVNET_RUNBOOK.md`).
- **A real DevNet program keypair was generated** (`solana-keygen`, native host tool): `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`, wired into `Anchor.toml` and `declare_id!()`, replacing the earlier throwaway placeholder. Gitignored, never committed.
- **A real security gap was found and fixed:** `collect_fees`'s `protocol_fee_destination` is now validated against `ProtocolConfig.default_protocol_fee_destination` (previously any caller-supplied address could have received the protocol's fee share).
- **Gate 6 (SDK):** `packages/sdk` -- typechecks successfully against real installed packages (`npx tsc --noEmit`, zero errors).
- **Gate 7 (native-target portion): now genuinely satisfied.** Rust build succeeds for the host target. Remaining Gate 7 item (BPF/SBF-specific build) is the one documented blocker.
- Full documentation set under `docs/protocol/`, all updated this session to reflect the new verified state.
- Dedicated branch `protocol/devnet-v1`; prior uncommitted dashboard work preserved untouched throughout.
- (Unrelated, same day) Dashboard: password-gated `/internal/status` with configurable login rate limiting (DEC-0008).

## In Progress
- Phase 4 (Core Solana Program): source complete and compiles/links cleanly for the native host target; **actual BPF/SBF compilation blocked on a missing MSVC linker** -- see Blockers.
- Phase 5 (Client and Frontend Integration): SDK skeleton done and typechecked; no frontend wiring has started (blocked behind a real deployed program + generated IDL).

## Next Actions
1. **Resolve the one remaining blocker** (see Blockers) -- Visual Studio Build Tools install, WSL2, a cloud devcontainer, or a teammate with an existing Linux/macOS Solana setup.
2. Once unblocked: `cargo-build-sbf` (or `anchor build`), producing the deployable `.so` -- the program keypair/ID are already generated and wired in, no re-generation needed.
3. Run `tests/ssr_protocol.ts` against a local validator for the first real test execution.
4. Deploy to DevNet; record the program ID/signature in `docs/protocol/DEVNET_RUNBOOK.md` (the "Deployment record" table is pre-filled with everything except the deployment itself).
5. Stand up DevNet fixtures and begin Gate 10 frontend integration in the mission's specified order.
6. Resolve the two flagged product/design decisions under Decisions Required below.

## Roadmap

```json
[
  { "phase": 1, "name": "Frontend Foundation", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 2, "name": "Protocol Research and Gap Analysis", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 3, "name": "Solana Reserve Architecture", "weight": 15, "completion": 1.0, "status": "done" },
  { "phase": 4, "name": "Core Solana Program", "weight": 20, "completion": 0.65, "status": "in_progress" },
  { "phase": 5, "name": "Client and Frontend Integration", "weight": 15, "completion": 0.15, "status": "in_progress" },
  { "phase": 6, "name": "DevNet Testing and Security Validation", "weight": 15, "completion": 0.08, "status": "in_progress" },
  { "phase": 7, "name": "Restricted Beta", "weight": 10, "completion": 0.0, "status": "not_started" },
  { "phase": 8, "name": "Production Readiness", "weight": 5, "completion": 0.0, "status": "not_started" }
]
```

## Blockers
- **Real Solana BPF/SBF compilation (`cargo build-sbf`) needs Microsoft's MSVC linker (`link.exe`), which needs Visual Studio Build Tools installed.** Everything else about the toolchain is now resolved (Rust, a GCC linker for the native host target, the Solana CLI itself are all installed and working -- `cargo check`/`cargo build` succeed with zero errors). `cargo-build-sbf` specifically hardcodes the MSVC target for its host-side build-script compilation regardless of the active Rust toolchain default, and this environment has no MSVC linker (confirmed: no Visual Studio install, only a portable MinGW GCC which `cargo-build-sbf` doesn't use for this step). **Requires a user decision**, in order of likely suitability: (1) install Visual Studio Build Tools (`winget install --id Microsoft.VisualStudio.2022.BuildTools`, "C++ build tools" workload -- multi-GB, proprietary license, not done autonomously since it's comparable in size/invasiveness to the WSL2 option); (2) install WSL2 (admin rights + likely restart, not done autonomously per DEC-0022); (3) use a cloud/Linux devcontainer; (4) have someone with an existing Linux/macOS Solana setup build+test+deploy the already-verified source in this workspace and report back the program ID/signature. Full detail in `docs/protocol/DEVNET_RUNBOOK.md`.

## Dependencies
- Vercel (hosting, deployment, custom domain, and the environment variable used by the internal dashboard).
- Name.com (domain registrar and DNS for `strategic-super-reserve.fun`).
- Solana DevNet access -- RPC reachability confirmed reachable over the network; deployment itself blocked on the toolchain gap above, not on DevNet being reachable.
- Reserve Protocol's `reserve-index-dtf` reference repository (read-only, external to this repo) -- reference material only, not a runtime dependency.

## Risks
- **No test has ever actually executed against a compiled program.** A full Anchor test suite exists (`tests/ssr_protocol.ts`), typechecks, and now has a real compiled-and-linked program to eventually run against once the BPF gap closes -- but no test has run yet. Treat runtime/CPI behavior as unverified until then.
- **The frontend contains two incompatible economic models** (a dead in-kind NAV mint/redeem model and a live AMM buy/sell model) -- resolved for the *protocol's* design per DEC-0009, but the frontend itself still needs new UI for proportional mint/redeem before Gate 10 can meaningfully complete. See Decisions Required.
- **No automated test suite exists for the dashboard/frontend either** (pre-existing risk, unchanged).
- **Main JS bundle exceeds 500 kB** (pre-existing, unchanged). Will compound as Phase 5 adds real client/on-chain integration code.
- **The general testing site relies on obscurity, not authentication** (see Decision Log DEC-0004/DEC-0005, unchanged, pre-existing).
- **Rebalance trade execution (an actual Jupiter-route CPI) does not exist on-chain at all in v1** (deliberate, per DEC-0017/DEC-0021) -- manual rebalancing is bookkeeping-only until this is designed and built as its own security-reviewed feature.

## Decisions Required
- **How to close the remaining BPF/SBF toolchain gap** (Visual Studio Build Tools / WSL2 / cloud devcontainer / teammate with existing setup) -- see Blockers. Needed before any DevNet deployment.
- **Whether/when to build the new proportional-mint/redeem frontend UI** (does not exist yet in any form) versus continuing to treat the existing AMM Buy/Sell UI as the near-term user-facing surface while the real protocol work continues underneath it. See `docs/protocol/FRONTEND_INTEGRATION.md`.
- Should the general testing site move from "unlisted" to real authentication before it's shared with anyone outside the immediate team? (pre-existing, unchanged)

## Technical Health
- **Frontend typecheck:** passing (`tsc -b`), unaffected by protocol work.
- **Frontend build:** passing (`vite build`), unaffected by protocol work.
- **SDK typecheck (`packages/sdk`):** passing (`npx tsc --noEmit`, zero errors) against real installed packages.
- **Protocol test-suite typecheck (`tests/`, `tsconfig.tests.json`):** passing (`npx tsc --noEmit`, zero errors). **Never executed against a compiled program.**
- **Protocol Rust build (native host target, `cargo check`/`cargo build -p ssr_protocol`):** **passing, zero errors, zero warnings** -- verified this session with a newly-installed native toolchain.
- **Protocol Rust build (BPF/SBF target, `cargo build-sbf`):** blocked -- see Blockers.
- **Rust/Anchor tests:** not run -- needs the BPF build above.
- **Lint:** `oxlint` (frontend) configured and available; `cargo clippy`/`cargo fmt` (protocol) not yet run (tooling now available, just not yet exercised -- a same-toolchain follow-up, not a new blocker).
- **CI:** none configured; deploys are manual and intentional (see Decision Log DEC-0001).

## Environment Status
- **Local:** `npm run dev` (Vite dev server) for the frontend -- unchanged. Protocol code now has a working local native-target build environment (Rust 1.97.1 + GNU toolchain at `C:\devtools\mingw64` + Solana CLI 4.1.2 at `C:\devtools\solana`, all installed this session); BPF-target builds still blocked.
- **Development:** Vercel Preview deployments for the frontend, unchanged.
- **DevNet:** Not yet provisioned -- no program deployed yet. RPC reachability confirmed. A real program keypair exists (`2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`), generated and wired in, awaiting the BPF build to actually deploy.
- **Production:** `https://strategic-super-reserve.fun` -- live, frontend-only simulation, kept unlisted, unaffected by protocol work.

## Last Updated
2026-07-27 22:10 UTC
