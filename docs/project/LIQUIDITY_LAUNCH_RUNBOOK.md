# Liquidity launch runbook — DEC-0236

Observed 2026-10-11. Source/local verification is complete for the cases below; Mainnet activation is not. No Mainnet assets were moved by this work.

## Verified artifact and authority

- Program: `8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9`
- ProgramData: `2YF7aofgPbNj96pJJh1uzLtCk4H2fUq1FVLxFf9TAwow`, deployed slot 454528266.
- Current upgrade authority: Squads vault `HFmqpPVVdMRcwaSKkbxLNga8byBJb3LK1FsURsDQqYoW`. Historical individual-wallet instructions are obsolete.
- Locally built artifact: 1,486,840 bytes; SHA256 `56a758a3e76938751568a6d1775e64623f35b9617f936553cbe1b3284a71201e`.
- Existing ProgramData allocation: 1,099,637 bytes. Required allocation including metadata: 1,486,885; minimum extension 387,248 bytes.
- Read-only rent estimate: additional storage 1.967219840 SOL; temporary upload buffer 7.553985400 SOL, excluding transaction fees. Refresh against current RPC before funding; temporary buffer recovery depends on successful upgrade and authorized closure.

## Release sequence

1. Review/merge source and additive IDL changes. Preserve existing account layouts and DEC-0232 economics. Keep server/browser release gates false.
2. Obtain the legitimate funded upload signer and authorized Squads execution path. Do not generate an arbitrary Mainnet identity as a substitute. Verify current on-chain authority, artifact hash, storage and rent again.
3. Extend storage and upload the verified artifact through the established Squads upgrade process. Verify the uploaded buffer before proposal execution; verify the deployed program afterward. Publish/verify IDL with its actual authority. Record signatures, slot, artifact hash and deployment in Collaboration Alignment and PROJECT_STATUS.
4. Establish operational co-signing for approved Raydium payer `6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS`. The transaction supports sequential wallet switching; a hosted co-sign service is not implemented. Treasury funds both transfer hops atomically and receives all initial LP; approved payer pays native pool rent. Program-controlled treasury spending needs a separate adapter.
5. Verify a legitimately funded new Token-2022 Reserve/USDC pool on Mainnet: NAV creation, both transfer fees, fixed native revenue routing/splits, taxed swaps, Collect, additions, withdrawal, timed expiry/extension and native permanent Fee Key. Use staging/Mainnet verification; do not use legacy Reserve Tokens as eligible fixtures.
6. Complete representative real Jupiter 1/5/10-asset quotes in both directions, including ExactOut availability, actual caps/impact, fee floors and route latency. Anonymous API failures are evidence of unavailable results, not zero execution cost. A configured API credential may be required. Local synthetic baskets are not a substitute.
7. Verify browser-wallet multi-signature preservation, explicit route approval, address-table setup/requote, unknown submission reconciliation and no duplicate spend. Verify pause after preparation rejects additions while permitted exits remain available. Routes exceeding account or packet limits remain unavailable.
8. Only after these checks, change source release gates together, rerun checks and ship production frontend from clean `main`. Record deployment ID, verification and rollback procedure. Do not enable through an environment-variable bypass.

## Local reproduction

Uses existing installed toolchain/dependencies; no installation required. Genesis fixture generation writes an ephemeral local-only key to `/tmp/ssr-liquidity-payer.json` and synthetic accounts to `/tmp/ssr-liquidity-fixtures`. Never publish that key. Scripts hardcode localhost RPC; synthetic permissions/balances have no Mainnet meaning.

Build with `/Users/enigma/.avm/bin/anchor-1.1.2 build --program-name ssr_protocol --ignore-keys`. Do not run key synchronization: the source intentionally uses the existing Mainnet program ID. Existing generated IDL is copied to the SDK. The installed empty SBF syscall manifest produces a warning despite successful local execution; stack-frame diagnostics are eliminated.

Run TypeScript fixture/runtime scripts with the existing ts-node runner and `tests/tsconfig.json` (transpile-only). Start an isolated `solana-test-validator` bound to `127.0.0.1`, RPC port `19199`, a fresh temporary ledger, and `--account-dir /tmp/ssr-liquidity-fixtures`. Load the built SSR program and public native binaries with `--bpf-program` for each ID. Run `scripts/liquidity_local_runtime.cts`, then `scripts/liquidity_multiasset_runtime.cts`. Never point these fixtures at a shared ledger. Stop the owned validator afterward.

Public native binaries used:

| Program | SHA256 |
|---|---|
| Raydium CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a` |
| Raydium lock `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` | `efd657a986796e1b204ebae198e691d4137d5f89a401693b83f7fb1a142f802d` |
| Metaplex `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` |

Raydium SDK ABI inspected at revision `e2e8bcd865189c994682a9477ec8eaf1e2da8aaf`; cp-swap source at `b3187ae53a1b95a201f855a59024a12ca8f5b51a`. No upstream scripts were executed or SDK dependency installed. Native lock is closed source: runtime compatibility is not an external security audit.

## Evidence and known limits

[evidence/2026-10-11-liquidity-runtime.json](evidence/2026-10-11-liquidity-runtime.json) contains local checks and public deployment/rent metadata. App build/API typecheck passed; Rust 33/33; phase suite 1419 passing with four pre-existing chart/native-reset failures. Local native execution covers both Compound routes, fixed fee destinations, timed and native permanent locks, substitution attacks, pause-after-simulation, and five-/ten-asset primary flows. No actual browser-wallet/Mainnet lifecycle execution is claimed. Timed lock guarantees remain subject to SSR upgrade governance.

### Refreshed read-only and deployment observations

At 2026-10-11T22:24:36Z, permission/config 9 verified again at slot 455814752. There were 38 existing Reserves and zero eligible Token-2022 Reserves. Anonymous Jupiter SOL ExactOut worked; five-asset checks returned a mix of quotes, unsupported ExactOut HTTP 400 and rate-limit HTTP 429; ten-asset price retrieval returned HTTP 429. See evidence/2026-10-11-liquidity-readonly-refresh.json. Do not treat the partial basket report as a successful arbitrage-cost model.

The design preview account rejects production's frequent cron schedules. Preview packaging omits `crons` only in an isolated deployment copy; repository production scheduling remains unchanged. Remote build reported existing `api/feedback/board.ts` unknown-value typing diagnostics and 31 dependency advisories (1 critical, 24 high, 5 moderate, 1 low). The critical shell-quote advisory is inherited through react-native/react-devtools in the mobile wallet dependency tree; no direct application imports were found. This is partial triage, not proof of unreachability or remediation. No dependency versions were changed; do not run a blind breaking audit upgrade. Track general dependency remediation separately before public launch.

Preview attempt `dpl_BdzFahQtCXnueLevreMG5wqsTJQT` completed its build but failed output deployment: Hobby permits at most 12 serverless functions. There is no successful preview deployment. Use an already-authorized deployment destination with sufficient function capacity, or resolve hosting capacity explicitly; do not silently omit application endpoints.
