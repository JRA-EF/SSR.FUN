<!--
  Operational runbook for building, testing, and deploying the SSR Protocol
  program to Solana DevNet. Originally written when NO Rust/Solana/Anchor
  toolchain was available; over two sessions, a native (non-WSL) toolchain
  was installed piece by piece (Rust/GCC/Solana CLI, then -- with explicit
  user approval -- Visual Studio Build Tools for the MSVC linker real BPF
  compilation needs) and the program now compiles, links, AND is deployed
  live on Solana DevNet. This document tracks the full history honestly --
  see "Current environment status."
-->

# DevNet Runbook

## SSR Protocol is live on DevNet

Program ID `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` -- see "Deployment record" below for the full, verified detail. Everything past this point in the "Current environment status" section is historical (what it took to get here); if you just need the deployment facts, jump to "Deployment record."

## Current environment status (updated: toolchain now installed)

**Now installed, natively on Windows (no WSL, no admin rights, no reboot required):**
- Rust `1.97.1`, via `rustup`, **default toolchain switched to `stable-x86_64-pc-windows-gnu`** (not the default MSVC target -- see "Why GNU, not MSVC" below). Installed to the default `%USERPROFILE%\.cargo`/`.rustup`.
- A portable WinLibs MinGW-w64 GCC/ld distribution (`gcc 16.1.0`, `mingw-w64ucrt 14.0.0`), extracted to `C:\devtools\mingw64` (**not** the user profile -- see "The space-in-username problem" below).
- Solana CLI `4.1.2` (Agave) + `cargo-build-sbf 4.1.0` (bundles `platform-tools v1.54`), extracted to `C:\devtools\solana\solana-release`.
- A real DevNet program keypair, generated via `solana-keygen`, at `target/deploy/ssr_protocol-keypair.json` (gitignored, never committed). Public key: `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` -- already wired into `Anchor.toml` and `declare_id!()`.

**Verified working (real command output, not assumed):**
- `cargo check -p ssr_protocol` -- **zero errors, zero warnings.**
- `cargo build -p ssr_protocol` (native host target, full compile + link) -- **succeeds.**
- `packages/sdk` and `tests/ssr_protocol.ts` -- typecheck cleanly (`npx tsc --noEmit`) against the real installed `@anchor-lang/core@1.1.2` etc.

**Now also resolved (session 2, with explicit user approval for the Build Tools install):**
- Installed **Visual Studio Build Tools** ("C++ build tools" workload, via `winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --norestart"`), closing the MSVC-linker gap `cargo-build-sbf` needed for its host-side build-script compilation (see "Why GNU, not MSVC" below for why the GNU toolchain alone couldn't close this).
- `cargo-build-sbf --manifest-path programs/ssr_protocol/Cargo.toml` -- **succeeds**, producing `target/deploy/ssr_protocol.so` (538,056 bytes, release/optimized).
- **Deployed to Solana DevNet** and verified on-chain -- see "Deployment record" below. DevNet SOL funding needed a manual user transfer after the public airdrop faucet's daily limit was confirmed exhausted for this environment (429 from both `solana airdrop` and `@solana/web3.js`'s `requestAirdrop`, with the RPC's own error text confirming a daily limit, not a transient one).
- **Gate 8 (deployment) and the core of Gate 9 (running real instructions against the live program) are both complete.** The full `tests/ssr_protocol.ts` suite has executed against the live DevNet program -- 14 passing, 0 failing. See "Test execution record" below for the full history and final result.

## Why GNU, not MSVC (the default Rust target on Windows)

`rustup`'s default Windows target is `x86_64-pc-windows-msvc`, which needs Microsoft's `link.exe` (from Visual Studio Build Tools) -- not installed, and installing it was judged too large/invasive to do autonomously (see below). The `x86_64-pc-windows-gnu` target pairs with a portable MinGW-w64 GCC distribution instead, installable via `winget` with no admin rights and no Visual Studio at all. This unblocked `cargo check`/`cargo build` for the native host target completely. It does **not** unblock `cargo build-sbf`, because that tool's host-side build-script compilation hardcodes the MSVC target internally (confirmed by inspecting its linker invocation), ignoring the active Rust toolchain default.

## The space-in-username problem (a real, separate gotcha, documented in case it recurs)

The Windows user profile on this machine is `C:\Users\JRA DEVNET\...` -- the space in "JRA DEVNET" breaks GCC's own internally-computed library search paths (GCC resolves its own install location via the OS's canonical/long-form path API, which cannot be worked around by invoking it through the legacy 8.3 short-path form like `JRADEV~1`, since that only affects argv[0], not what GCC computes internally). **Fix:** the MinGW distribution must be extracted to a path with no spaces anywhere in it (`C:\devtools\mingw64` here) -- installing it via a normal installer into the default (space-containing) user-scoped location reproduces the bug. If this machine's toolchain is ever reinstalled, keep it at a space-free path.

## Toolchain gap: CLOSED

Previously this section listed three options for closing the BPF/SBF compilation gap. Option 1 (install Visual Studio Build Tools) was taken, with explicit user approval, in session 2 -- see above. The WSL2 and devcontainer/teammate alternatives are no longer needed.

## Test execution record

**The full `tests/ssr_protocol.ts` suite has been executed against the live DevNet program and passes: 14 passing, 0 failing** (final confirmed run, 2026-07-28).

What it took to get there, in order:

1. **IDL generation without a full `anchor build`.** `anchor build`'s vendored toolchain-detection logic panics (`cargo-build-sbf-4.1.0/src/toolchain.rs:357`) because it expects the standard `agave-install`-managed directory layout, which doesn't exist since the Solana CLI here was extracted from a tarball rather than installed via `agave-install`/`solana-install`. Fixing that properly needs `agave-install-init.exe`, which requires admin privileges -- not done. Instead, the narrower `anchor idl build --out target/idl/ssr_protocol.json --out-ts target/types/ssr_protocol.ts -p ssr_protocol` subcommand succeeds without needing the full toolchain-detection path, producing a real, correct IDL (verified: its embedded `address` field matches the deployed program ID).
2. **Running the suite directly via `mocha`/`ts-node`, not `anchor test`** (which defaults to spinning up a local validator -- the opposite of what Gate 9 needs, which is to exercise the already-deployed DevNet program):
   ```
   export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
   export ANCHOR_WALLET="<path to funded deployer keypair>"
   export TS_NODE_PROJECT="tests/tsconfig.json"
   export TS_NODE_TRANSPILE_ONLY=true
   npx mocha --require ts-node/register --timeout 180000 tests/ssr_protocol.ts
   ```
3. **A chain of ESM/CJS module-resolution errors** had to be worked through to get the harness running at all -- the repo root `package.json` has `"type": "module"` (a deliberate, genuine ESM project), which conflicts with `ts-mocha`/classic `ts-node` + `mocha`'s CommonJS-oriented resolution. Fixed by scoping `tests/` as its own CJS boundary (`tests/package.json` with `{"type": "commonjs"}`, plus a dedicated `tests/tsconfig.json` for ts-node's runtime compilation, separate from the type-checking-only `tsconfig.tests.json`), and by removing `"type": "module"` from `packages/sdk/package.json` (a CJS-requiring boundary cannot synchronously `require()` a genuine ESM package -- a hard Node.js limitation, not fixable by loader tricks) with its internal imports converted from `.js`-suffixed back to extensionless accordingly.
4. **The DevNet public airdrop faucet was confirmed exhausted for this environment** (daily limit, per explicit 429 error text from both `solana airdrop` and `@solana/web3.js`'s `requestAirdrop`). The test suite's `before()` hook and three other call sites previously called `connection.requestAirdrop(...)` to fund ephemeral test keypairs -- all replaced with a `fundWallet()` helper that transfers SOL directly from the already-funded `ANCHOR_WALLET` deployer via `SystemProgram.transfer`. Funding amounts were kept deliberately small (0.3 SOL for the two keypairs that create accounts/pay rent across the suite, 0.05 SOL for keypairs used only in a single adversarial test) since this SOL is not reclaimed from the ephemeral keypairs after the run -- see "Wallet / fixture safety" below for the ongoing budget implication.
5. **Two real bugs surfaced by actually running against live state** (not caught by typechecking, since both are runtime/state issues):
   - `tests/ssr_protocol.ts`'s "seeds the Reserve with an initial in-kind deposit" test asserted `managerReserveTokenAccount.amount !== "0"`, but `managerReserveTokenAccount` was the object returned by `getOrCreateAssociatedTokenAccount` *before* the `seedReserve` call that actually mints into it -- the assertion was comparing a stale pre-transaction snapshot, which is always `"0"` regardless of what actually happened on-chain. Fixed by re-fetching via `getAccount(connection, managerReserveTokenAccount.address)` after the RPC call.
   - The "initializes the protocol singleton" test unconditionally called `initializeProtocol`, but `ProtocolConfig` is a true one-time global singleton PDA -- on a **persistent** network like DevNet (unlike a local validator, which resets state every run), it can only ever be initialized once for the program's entire lifetime. Once initialized by an earlier run, re-running the bare "initializes" test fails with "already in use," even though the protocol is working exactly as designed (confirmed by the adjacent "rejects re-initializing" test, which passed both times). Fixed by checking `program.account.protocolConfig.fetchNullable(...)` first and only calling `initializeProtocol` if it returns `null`, then asserting the config's contents either way.

Final passing run covers: protocol singleton init (idempotent-safe), Reserve creation, two-asset registration + duplicate rejection, initial seeding, rejecting re-seed of an Active Reserve, a second holder minting and redeeming proportionally, rejecting over-balance redemption, unauthorized-pause rejection, manager pause/unpause, a restricted `UPDATE_TARGETS`-only delegate (privilege-boundary enforced), repeated-protocol-init rejection, and the cross-Reserve vault-substitution isolation test (the single most security-critical test in the suite). See TEST_PLAN.md and SECURITY_INVARIANTS.md for the per-invariant mapping.

## Toolchain versions this workspace targets (still accurate)

| Component | Version | Source of truth |
|---|---|---|
| `anchor-lang` / `anchor-spl` (Rust) | `1.1.2` | crates.io; confirmed compiles clean against this workspace |
| `@anchor-lang/core` (TypeScript) | `^1.1.2` | npm; note the package rename from the older `@coral-xyz/anchor` |
| Solana CLI / Agave | `4.1.2` | `solana --version`, installed this session |
| `cargo-build-sbf` / platform-tools | `4.1.0` / `v1.54` | bundled with the Solana CLI release |
| Rust | `1.97.1` (both `-msvc` and `-gnu` toolchains installed; `-gnu` is default) | `rustc --version` |
| `@solana/web3.js` | `^1.98.4` | npm |
| `@solana/spl-token` | `^0.4.15` | npm |

## Once the SBF gap is closed, run in this order

```
export PATH="$HOME/.cargo/bin:/c/devtools/mingw64/bin:/c/devtools/solana/solana-release/bin:$PATH"
solana config set --url https://api.devnet.solana.com
solana airdrop 2 --keypair target/deploy/ssr_protocol-keypair.json   # DevNet SOL only

cd <repo root>
cargo-build-sbf --manifest-path programs/ssr_protocol/Cargo.toml
# or, once Visual Studio Build Tools / WSL close the gap: anchor build
```

The program keypair and ID are already generated and wired in (see above) -- no need to re-run `anchor keys list` unless the keypair is regenerated.

1. `cargo-build-sbf` (or `anchor build`) -- produces the deployable `.so`.
2. Exercise `tests/ssr_protocol.ts` against a local validator (`solana-test-validator`, bundled in the same release at `C:\devtools\solana\solana-release\bin`) or `anchor test`.
3. Once tests pass locally: `solana program deploy target/deploy/ssr_protocol.so --keypair target/deploy/ssr_protocol-keypair.json --url devnet` (or `anchor deploy --provider.cluster devnet`).
4. Record the deployment in "Deployment record" below -- this file is the source of truth per CLAUDE.md's project-status conventions, not chat/PR description.

## Real compiler-caught bugs fixed this session (for anyone touching this code next)

All found via actual `cargo check`/`cargo build` output, not guessed -- listed since they're exactly the kind of subtle Anchor/Rust issues likely to recur if similar patterns are copied elsewhere in the codebase later:

1. **`init_if_needed` requires an explicit Cargo feature.** Added `features = ["init-if-needed"]` to `anchor-lang` in `programs/ssr_protocol/Cargo.toml` -- used by `collect_fees.rs`, `mint_reserve_tokens_in_kind.rs`, `seed_reserve.rs`.
2. **`CpiContext::new`/`new_with_signer` take the program's `Pubkey` directly, not its `AccountInfo`** (an actual Anchor 1.0 breaking change -- "Remove program account info from CPI context"). Every `CpiContext::new(ctx.accounts.token_program.to_account_info(), ...)` call had to become `CpiContext::new(ctx.accounts.token_program.key(), ...)`; `instructions/common.rs::AssetLeg.token_program` changed from `AccountInfo<'info>` to `Pubkey` accordingly.
3. **Every handler function needs an EXPLICIT, unified lifetime: `pub fn handler<'info>(ctx: Context<'info, Foo<'info>>, ...)`, never the elided `Context<Foo>`.** Eliding it creates two INDEPENDENT anonymous lifetimes (one for `Context` itself, one for `Foo`'s own parameter) instead of one shared lifetime -- harmless until a handler body passes two different `ctx.accounts` fields (or a field plus `ctx.remaining_accounts`) to the same downstream call, since `Account`/`AccountInfo` are invariant over their lifetime parameter and Rust can't unify two independently-elided lifetimes after the fact. This affected all 17 instruction handlers AND all 17 dispatch wrappers in `lib.rs`'s `#[program]` module -- both needed the fix.
4. **Helper functions taking multiple `Account`/`AccountInfo` references should use INDEPENDENT lifetime parameters per argument** (e.g. `fn f<'r, 'd>(reserve: &Account<'r, Reserve>, delegate: &'d AccountInfo<'d>)`), not one shared lifetime across arguments that don't actually need to be tied together -- same invariance issue as #3, one level down in `instructions/common.rs`.
5. **To get a genuine `&'info AccountInfo<'info>` from an `UncheckedAccount<'info>` field, pass `&ctx.accounts.some_field` directly (relying on `Deref`), never `ctx.accounts.some_field.to_account_info()`** -- the latter clones into a fresh, short-lived owned value that can never satisfy an `'info`-tied reference bound, no matter how it's subsequently borrowed. (`UncheckedAccount<'info>` is defined as `struct UncheckedAccount<'info>(&'info AccountInfo<'info>)` in anchor-lang 1.1.2, and derefs to it.)
6. **Instruction modules split across files must `pub use module::*;` (glob), not `pub use module::SomeStruct;` (named), even when it makes an unrelated function name (`handler`, here) ambiguous if referenced unqualified.** `#[derive(Accounts)]` generates a companion `__client_accounts_<name>` module as a sibling of the struct; the `#[program]` macro's generated code assumes it's reachable at the crate root via glob re-export chains. A named re-export silently drops that sibling module, surfacing as a deeply confusing "unresolved import `crate`" pointing at the `#[program]` attribute line itself, nowhere near the real cause. The `handler`-name ambiguity this creates is harmless as long as nothing calls it unqualified (this codebase always calls it fully module-qualified).
7. **`collect_fees`'s `protocol_fee_destination` needed real validation** against `ProtocolConfig.default_protocol_fee_destination` -- previously unvalidated (flagged, then fixed, in `docs/protocol/SECURITY_INVARIANTS.md`).

None of the "highest-risk code" items originally flagged in this file's earlier draft (Token-2022 extension introspection API, `InitSpace`/manual space calculations, `InterfaceAccount::reload()`, the `#[instruction(...)]` attribute) turned out to be wrong -- they all compiled as originally written. The actual bugs were entirely about lifetime elision and macro re-export mechanics, none of which were on that predicted list.

## Wallet / fixture safety

- Use `solana airdrop` for DevNet SOL only. Never request, generate from, or use a Mainnet seed phrase anywhere in this workflow.
- Generated keypairs (including `target/deploy/ssr_protocol-keypair.json`, generated this session) are gitignored (`*-keypair.json`, `target/`, `.anchor/`, `test-ledger/`) and were never committed -- confirmed via `git check-ignore`.
- **DevNet SOL budget is finite and the public faucet is exhausted for this environment.** Every test run funds fresh ephemeral keypairs from the deployer wallet via `fundWallet()`, and that SOL is not reclaimed afterward (the keypairs are discarded). At current funding levels (0.3 SOL × 2 + 0.05 SOL × 3 ≈ 0.75 SOL per full suite run), the deployer wallet can support roughly 1-2 more full runs before needing another manual top-up. Balance after the two 2026-07-28 test-suite confirmation runs plus building the persistent DEVNET_FIXTURES.md fixtures: **~1.29 SOL** on the deployer (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`), **~0.20 SOL** on the fixture manager wallet (see DEVNET_FIXTURES.md; check via `solana balance <path> --url devnet`). If it runs low, either reduce `fundWallet` amounts further (real per-test rent/fee cost is well under 0.05 SOL) or ask the user for another manual DevNet SOL transfer -- do not silently hammer the public faucet again, it is confirmed daily-rate-limited from this environment.
- **Persistent, documented DevNet fixture wallets now exist**, built via `scripts/devnet_fixtures.ts` -- distinct from the test suite's own ephemeral, discarded-after-the-run keypairs. See `docs/protocol/DEVNET_FIXTURES.md` for the full record (root manager, 2 restricted delegates with distinct scopes, 2 holders, a 2-asset Reserve, a 3-asset "multi-asset" Reserve, both seeded and with real proportional holder balances, plus a pause/unpause cycle demonstrating both Active and Paused states). The script is checkpoint-resumable (`devnet-fixtures/checkpoint.json`, gitignored) since the public DevNet RPC proved prone to sustained rate-limiting (`429 Too Many Requests`) and even outright blocks `getProgramAccounts` (`403 Forbidden: "Your IP or provider is blocked from this endpoint"`) under this session's heavy same-day usage -- a real, confirmed limitation of the free public endpoint, not a bug in the script. An earlier interrupted run also left a genuine, unplanned example of the documented "abandoned Reserve" invariant on-chain (reserve_id 6, stuck in `AssetsInitializing`) -- left as-is and documented rather than cleaned up, since v1 has no reclaim instruction for exactly this case.

## Deployment record

**SSR Protocol is live on Solana DevNet.**

| Field | Value |
|---|---|
| Cluster | DevNet (`https://api.devnet.solana.com`) |
| Program ID | `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` |
| Deployment signature | `arj6tzkUCqgSeJBs9inJv3nLcyoK5smasygGEZmDZ5hk84QukwLsJKR9mbaZryJz56uFRTkeXoGtTFSBSMWuaju` |
| Deployed Git commit | `2cb7084` ("Add repeated-init and excess-redemption adversarial tests") on `protocol/devnet-v1` |
| Program owner | `BPFLoaderUpgradeab1e11111111111111111111111` (upgradeable, as designed) |
| ProgramData address | `4YMiJc7UEH4QtRhaL5P6usgEf68sw1eZirKmoNvqqoXA` |
| Data length | 538,056 bytes |
| Program account balance | 3.746 SOL (rent-exempt minimum, matches `solana rent` estimate exactly) |
| Upgrade authority pubkey | `6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk` (dev-controlled DevNet deployer wallet, single key per DEC-0015 -- migrate to a multisig before any restricted beta) |
| Deployment timestamp | 2026-07-28 (verified via `solana program show`) |
| Explorer | https://explorer.solana.com/address/2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW?cluster=devnet |

Verified via `solana program show 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW --url devnet` -- all fields above are read directly from that command's output, not assumed.

DevNet SOL funding note: the public airdrop faucet was rate-limited/exhausted from this environment's IP for the entire session (`solana airdrop` and `@solana/web3.js`'s `requestAirdrop` both returned 429 "reached your airdrop limit today"). The user funded the deployer wallet manually instead (two transfers, ~11 SOL total) -- this is the reason `docs/project/DECISION_LOG.md` records a funding-path decision alongside the deployment one.

## Upgrade policy (v1 DevNet)

- Upgradeable program, standard Solana `BPFLoaderUpgradeable` model (see RESERVE_REFERENCE_ANALYSIS.md section 13 for why SSR does NOT need the reference protocol's proxy/version-registry pattern -- Solana's native upgrade-in-place model already covers this).
- Upgrade authority: a single dev-controlled keypair for v1 DevNet (matches DEC-0015 -- no DAO/multisig yet).
- State-version strategy: `schema_version` field on `ProtocolConfig` and `Reserve` (currently `1`); bump on any breaking account-layout change and write an explicit migration path before deploying the new version.
- IDL versioning: Anchor 1.0 replaced legacy on-chain IDL storage with Program Metadata integration (see CHANGELOG) -- `anchor deploy`'s default IDL-upload behavior should be used rather than any manual legacy `anchor idl init`/`idl upgrade` flow (removed in 1.0 per the CHANGELOG's breaking-changes list).
- **Before any restricted beta:** migrate the upgrade authority to a multisig (e.g. Squads) and complete the security-review items listed in RESERVE_REFERENCE_ANALYSIS.md section 18 and SECURITY_INVARIANTS.md's "Outstanding gaps."
- **Before Mainnet:** full external audit; do not present the DevNet single-key trust model as production-ready (mission instruction, restated here for visibility).
- **Going forward (DEC-0034, 2026-07-28):** localnet is the default environment for protocol development and validation; real DevNet upgrades are batched, checkpointed events (material Rust change + local tests pass + frontend validated locally), not a per-change habit. Before any upgrade: check the compiled `.so` size, list/reuse/close deployment buffers (`solana program show --buffers --buffer-authority <deployer-keypair>`), and calculate the exact additional SOL needed; after: verify via `solana program show` and record recovered lamports + final deployer balance.

## Program upgrade: `update_protocol_config` (DEC-0033/DEC-0035, deployed)

A new instruction (`programs/ssr_protocol/src/instructions/update_protocol_config.rs`) lets the protocol authority repoint `ProtocolConfig.default_protocol_fee_destination` (and `default_protocol_fee_bps`) after the fact -- `initialize_protocol` only ever runs once. Deployed and used to set the DevNet treasury to `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`.

| Field | Value |
|---|---|
| Status | **Deployed and verified live** |
| Upgrade signature | `JuNiHri3m5wuCwv7aKaYHnMLvoMSEPUuJjCehainCrZRUg6RqfZMdUeVxosxjbAzn9hxSFc8nThXcoVGEx9BvVK` |
| New Data Length | 548,296 bytes (up from 538,056 bytes) |
| Funding | Deployer wallet (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`) was funded with a direct 3 SOL transfer from the treasury wallet itself (tx `36xa2uVFMy1LXqnAdDeSDg3AbbPV78b8as65LCfHJWFixtULS4VywL5RrZWh5PJRe9RPFKhuwB4V9k2nZsSbwmKU`) after the public faucet stayed rate-limited across this session. |
| `update_protocol_config` call | Signature `2cEtFTEPa5qiEWdPWZ16bTVdQaDZ7XyhUK6zjJpwUKkLvKYwwE8fD11gseoyZHgVRvRthD1d6spzy8VaYRZGcmTC` -- `default_protocol_fee_destination`: `6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk` -> `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq` |
| Fee-routing verification | `collect_fees` call (signature `3k4KKk9EdiuNigWgSjqWK3kiigedAKAP2ifmkX1cMXAzxE4wTk5F8jj5bbGE6sPaqUA2TEKSX11RLjRAbPFxw9Ww`) against Reserve `BuHRWKzzXQXhjL3WCsmHTT7qDooh2437DvXuxyExpiWg`'s pending shares (800 manager / 200 protocol, raw units, accrued by DEC-0032's Buy): manager Reserve Token balance 1,099,500 -> 1,100,300; treasury Reserve Token balance 0 (no ATA) -> 200. |
| IDL regeneration gotcha | `anchor idl build` works (unlike `anchor build`/`anchor test`, which panic -- DEC-0025/DEC-0034) but prints Cargo build noise before the JSON on stdout, and the committed `packages/sdk/idl/ssr_protocol.ts` is a hand-maintained **camelCase transform** of the raw JSON IDL, not a literal mirror -- regenerating it naively broke `program.account.*` typing across the SDK. Fixed by surgically merging just the 3 new entries (instruction + event + type) into both files in their respective conventions. See DEC-0035. |

## Program upgrade: claimant-only Manager fee collection, instant Protocol mint/TVL fee transfers, time-weighted TVL settlement (2026-08-14 pass, deployed)

Corrects several fee-distribution issues in one pass: `collect_manager_fee_share`'s `recipient` is now a `Signer` (only that exact wallet may collect its own accrued balance -- previously any wallet could trigger any recipient's payout); every mint (including the initial seed) now mints the Protocol's fee share directly to treasury in the SAME transaction via CPI, never leaving it as a `pending_protocol_fee_shares` balance; the Annualized TVL fee now settles via a genuine time-weighted-average-supply accumulator (new `TvlAccrual` PDA, one per Reserve) rather than a linear "days x latest snapshot" approximation, with the Protocol's settled share also minted instantly to treasury. See `docs/project/DECISION_LOG.md`'s entries for this pass for the full root-cause/design rationale.

| Field | Value |
|---|---|
| Status | **Deployed and verified live** |
| Upgrade signature | `WGkDTY31YPqewUcw5doaH2L5Gpd7D4NhYAcTboW5RjYhdp3WwaX99KzmdYAE5RPiXTV3jwHcT9Fa3cNMRTMo2KY` |
| Slot | 483836553 |
| New Data Length | 874,952 bytes (up from 828,848 bytes) |
| New account | `TvlAccrual` (`programs/ssr_protocol/src/state/tvl_accrual.rs`), PDA seed `tvl_accrual` + reserve, lazily created on a Reserve's first checkpoint/settlement call -- no realloc/migration needed for any already-initialized `Reserve` account. |
| New instruction accounts | `mint_reserve_tokens_in_kind`/`seed_reserve` gained `protocol_fee_destination_token_account`/`protocol_fee_destination`/`tvl_accrual`; `redeem_reserve_tokens_in_kind` gained `tvl_accrual`/`system_program` (and `redeemer` is now `mut`, fronting `tvl_accrual`'s one-time rent); `accrue_fees` gained `protocol_config`/`mint_authority`/`tvl_accrual`/`protocol_fee_destination_token_account`/`protocol_fee_destination`/`payer`/`associated_token_program`/`system_program` -- it now genuinely SETTLES (mints to treasury), where it previously only accrued a pending balance. `collect_manager_fee_share` lost its separate `payer` account (`recipient` now pays its own ATA rent, since it must sign anyway). |
| New events | `ProtocolMintFeeTransferred`, `TvlFeeSettled`. |
| Funding | Deployer wallet (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`) needed ~0.6 SOL more than its existing balance to cover the larger program's rent-exemption; the user sent a direct DevNet SOL transfer to cover it (public faucet remains rate-limited/exhausted for this environment, unchanged from every prior pass). |
| Live verification | See `docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_CHECKLIST_2026-08-14.md` for the full 17-item checklist against the user's explicit verification list, with real transaction signatures for every item. |
| `update_fee_recipients` behavior change | Previously required EVERY current recipient's `pending_fee_shares` to be zero before a routing change (the frontend auto-bundled a "collect everyone first" step) -- now structurally impossible since only a recipient's own wallet can collect its own balance. Changed to: a recipient who STAYS on the list keeps its pending balance carried forward (never blocked); only a recipient being REMOVED must already have zero pending. See `programs/ssr_protocol/src/instructions/update_fee_recipients.rs`'s header comment. |
