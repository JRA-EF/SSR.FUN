<!--
  Operational runbook for building, testing, and deploying the SSR Protocol
  program to Solana DevNet. Originally written when NO Rust/Solana/Anchor
  toolchain was available; mid-session, a native (non-WSL) toolchain was
  installed and the program now compiles and links cleanly. This document
  tracks both states honestly -- see "Current environment status."
-->

# DevNet Runbook

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

**Still blocked:**
- `cargo build-sbf` (actual Solana BPF/SBF cross-compilation, the artifact that would actually be deployable) -- fails while compiling HOST-side build-scripts/proc-macros (`proc-macro2`, `serde`, `thiserror`, etc., which must run on the host during the build regardless of the final target). `cargo-build-sbf` hardcodes `x86_64-pc-windows-msvc` for this host-side compilation regardless of the default Rust toolchain, and this environment has no MSVC linker (`link.exe`) -- Visual Studio itself isn't installed, only the portable MinGW GCC (which the SBF host-tooling ignores). Fixing this requires installing **Visual Studio Build Tools** ("C++ build tools" workload, Microsoft, proprietary license, multi-GB) -- a install of comparable size/invasiveness to the WSL2 path, so it was **not done automatically**; see "Closing the remaining gap" below.
- `anchor test` / any local-validator-based execution (needs the SBF `.so` above).
- Actual DevNet deployment (needs the SBF `.so` above).
- Gates 8-9 of the mission remain blocked on this one specific gap; Gate 7 (Rust build/lint) is otherwise satisfied for the native-target portion.

## Why GNU, not MSVC (the default Rust target on Windows)

`rustup`'s default Windows target is `x86_64-pc-windows-msvc`, which needs Microsoft's `link.exe` (from Visual Studio Build Tools) -- not installed, and installing it was judged too large/invasive to do autonomously (see below). The `x86_64-pc-windows-gnu` target pairs with a portable MinGW-w64 GCC distribution instead, installable via `winget` with no admin rights and no Visual Studio at all. This unblocked `cargo check`/`cargo build` for the native host target completely. It does **not** unblock `cargo build-sbf`, because that tool's host-side build-script compilation hardcodes the MSVC target internally (confirmed by inspecting its linker invocation), ignoring the active Rust toolchain default.

## The space-in-username problem (a real, separate gotcha, documented in case it recurs)

The Windows user profile on this machine is `C:\Users\JRA DEVNET\...` -- the space in "JRA DEVNET" breaks GCC's own internally-computed library search paths (GCC resolves its own install location via the OS's canonical/long-form path API, which cannot be worked around by invoking it through the legacy 8.3 short-path form like `JRADEV~1`, since that only affects argv[0], not what GCC computes internally). **Fix:** the MinGW distribution must be extracted to a path with no spaces anywhere in it (`C:\devtools\mingw64` here) -- installing it via a normal installer into the default (space-containing) user-scoped location reproduces the bug. If this machine's toolchain is ever reinstalled, keep it at a space-free path.

## Closing the remaining gap (real BPF/SBF compilation)

Three options, in order of typical suitability:

1. **Install Visual Studio Build Tools** (`winget install --id Microsoft.VisualStudio.2022.BuildTools`, "C++ build tools" workload). Confirmed available via `winget show` (proprietary license, multi-GB). **Not done automatically this session** -- comparable in size/invasiveness to the WSL2 path below, so left for an explicit decision rather than silently committing several GB and minutes of install time to a licensed Microsoft product.
2. **Install WSL2 + the Linux toolchain inside it** (`wsl --install`, then `rustup`/`solana-cli`/`avm install latest && avm use latest` inside Ubuntu). Solana/Anchor tooling is developed and tested primarily for Linux/macOS, so this is the most-likely-to-just-work path long-term. Requires a restart and admin rights.
3. **Use a Linux devcontainer / remote dev environment**, or **have a teammate with an existing macOS/Linux Solana setup** build/test/deploy the source already committed here and report back the program ID/deployment signature.

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
- DevNet fixture wallets (root manager, ≥2 restricted delegates, ≥2 holders) should be generated fresh per the mission's fixture requirements once Gate 9 is reachable; document their DevNet-only pubkeys (not the keypair files themselves) in this runbook once they exist.

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
