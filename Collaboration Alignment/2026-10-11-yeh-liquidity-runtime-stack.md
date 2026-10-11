# Liquidity lifecycle and runtime stack

- **Date:** 2026-10-11
- **Author:** Yeh via Codex
- **Branch / commits:** feature/raydium-permissioned-cpmm, this commit after e0c7098
- **Deployed to:** none; Mainnet execution disabled
- **Decision log:** DEC-0236

## What shipped
Creation, additions, Collect, withdrawal, timed/native permanent locks, both approved Compound routes, exact-message wallet signing and submission recovery. Source is ready for integration review; operational Mainnet release is not complete.

## Code touched
- Protocol liquidity revenue/lock instructions and account wrappers: authorization, atomic initial LP ownership, custody, SBF stack repair.
- SDK/IDL: additive lifecycle instructions and tranche derivation.
- lib/mainnet and api/mainnet: contextual reads, NAV, capped atomic preparation, simulation, lookup setup, disabled release endpoint.
- Liquidity UI/client: unsigned review, per-wallet signing, confirmation/recovery and tranche controls.
- Tests/scripts: offline regressions and isolated local runtime coverage.
- Project docs/evidence: DEC-0236 and launch runbook.

## Repositories / environments adjusted
SSR.FUN only. No new dependencies or skill execution. No production env, Neon, keys or Squads changes. Local ephemeral fixtures are outside the repository. Overnight heartbeat finish-ssr-liquidity-launch continues this task every 30 minutes; disable when shipped or all remaining work requires unavailable external access.

## Effect on others — READ THIS
Do not enable execution before program/IDL upgrade and Mainnet verification. Current upgrade authority is Squads vault HFmqpPVVdMRcwaSKkbxLNga8byBJb3LK1FsURsDQqYoW, not the historical individual wallet. Funded uploader, authorized Squads execution and approved 6sm payer co-sign access remain needed. No remote co-sign service exists. Preserve DEC-0232 economics. Existing ManageDTR hooks issue and unrelated .claude/launch.json remain untouched. Local synthetic permission is not evidence of a new Mainnet grant. Production frontend deploys only from main.

## Verification
App build/API typecheck pass; Rust 33/33; phase suite 1419 passing/four known chart failures. Actual local SSR/Raydium/native-lock runtime passes; 5/10-asset seed/mint/redeem pass. SBF stack diagnostics removed; empty toolchain syscall manifest still produces warning. Evidence and artifact hash: docs/project/evidence/2026-10-11-liquidity-runtime.json. Mainnet launch steps: docs/project/LIQUIDITY_LAUNCH_RUNBOOK.md.
