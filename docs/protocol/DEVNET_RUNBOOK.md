<!--
  Operational runbook for building, testing, and deploying the SSR Protocol
  program to Solana DevNet. Written at a point where NO Rust/Solana/Anchor
  toolchain was available in the working environment -- this document is
  both "how to do it" and an honest record of exactly what's blocked and why.
-->

# DevNet Runbook

## Current environment status (as of this writing)

Checked and confirmed absent from the working environment (Windows, no WSL):
`rustc`, `cargo`, `solana` CLI, `anchor` CLI, `avm`. `wsl --list` reports
"Windows Subsystem for Linux is not installed." Node.js/npm and git ARE
available and were used for everything in this workspace that doesn't
require compiling Rust/BPF/SBF code.

**This blocks, completely, until resolved:**
- `cargo build` / `anchor build` (compiling `programs/ssr_protocol`)
- `anchor test` / any local-validator-based test run
- `solana-keygen new` (generating the real program keypair/ID)
- `anchor deploy` / `solana program deploy` to DevNet
- Gates 7 (build/lint/Rust-side of local validation), 8, 9 of the mission

**Not blocked, and already done in this workspace:**
- All Rust/Anchor source code (written, not compiled -- see the uncompiled-notice comments in `lib.rs` and `instructions/common.rs`)
- All architecture/decision documentation
- TypeScript SDK (`packages/sdk`) and the Anchor test suite (`tests/`) -- both typecheck successfully against the real, currently-installed `@anchor-lang/core@1.1.2`, `@solana/web3.js`, `@solana/spl-token` packages (verified via `npx tsc --noEmit`)
- Frontend inspection, reference-protocol research and analysis

## Closing the toolchain gap

Three options, in order of typical suitability for this repo (Windows host, no WSL currently):

1. **Install WSL2 + the Linux toolchain inside it** (`wsl --install`, then inside the WSL Ubuntu shell: `rustup`, `solana-cli` via the install script, `cargo install anchor-cli` or `avm install latest && avm use latest`). This is the path the rest of this runbook assumes, since Solana/Anchor tooling is developed and tested primarily for Linux/macOS. **Not done automatically by this session** -- installing WSL is a Windows feature change that typically requires a restart and admin rights, which crosses into "ask before doing" territory per this session's operating rules.
2. **Use a Linux devcontainer / remote dev environment** (a cloud VM, GitHub Codespaces, or similar) with the toolchain pre-installed or installed there instead of on this Windows host.
3. **Have a teammate with an existing macOS/Linux Solana dev setup run the build/test/deploy steps** using the source already committed in this workspace, reporting back the program ID/deployment signature to record here.

## Toolchain versions this workspace targets

Verified live against crates.io/npm at the time this workspace was scaffolded (2026-07-27) -- **do not assume these are still latest** by the time you actually install; re-check.

| Component | Version targeted | Source of truth |
|---|---|---|
| `anchor-lang` / `anchor-spl` (Rust) | `1.1.2` | crates.io, `anchor-lang` repository moved to `solana-foundation/anchor` per its own CHANGELOG (also mirrored at `otter-sec/anchor` per crates.io metadata -- if these two ever point at genuinely different code, `solana-foundation/anchor`'s CHANGELOG is the more authoritative source, since it's the one that explicitly narrates the release history used here) |
| `@anchor-lang/core` (TypeScript) | `^1.1.2` | npm; **note the package rename** from the older `@coral-xyz/anchor` -- an Anchor 1.0 breaking change |
| Anchor CLI test runner | `litesvm` template (default since Anchor 1.0) for fast in-process Rust tests; `surfpool` (default local validator for `anchor test`/`anchor localnet`, replacing `solana-test-validator` as the default) | Anchor CHANGELOG 1.0.0 entry |
| `@solana/web3.js` | `^1.98.4` | npm |
| `@solana/spl-token` | `^0.4.15` | npm |
| `solana-program` (Rust, if ever needed directly) | `4.0.0` on crates.io | crates.io -- likely NOT a direct dependency of this program (Anchor's prelude covers what's needed) |

**Once a toolchain is available, run in this order** to catch discrepancies between what's written here and reality as early as possible:

```
solana-keygen new --outfile ~/.config/solana/id.json   # DevNet dev wallet, NOT a mainnet key
solana config set --url https://api.devnet.solana.com
solana airdrop 2                                        # DevNet SOL only, never request/use a mainnet seed phrase

cd <repo root>
anchor build
anchor keys list                                        # get the REAL program ID
```

Then:
1. Replace the placeholder `SSRPro11111111111111111111111111111111111` in **both** `Anchor.toml` (`[programs.localnet]`/`[programs.devnet]`) and `programs/ssr_protocol/src/lib.rs`'s `declare_id!(...)` with the real ID from `anchor keys list`.
2. `anchor build` again (the program ID is baked into the binary via `declare_id!`).
3. `anchor test` -- this is the first real signal on whether the hand-written Rust in this workspace actually compiles and behaves as designed. **Expect to need fixes** -- see "Highest-risk code to check first" below.
4. Once tests pass locally: `anchor deploy --provider.cluster devnet` (or `solana program deploy` directly with the built `.so`).
5. Record the deployment here (see "Deployment record" below) -- do not just note it in chat/PR description, this file is the source of truth per CLAUDE.md's project-status conventions.

## Highest-risk code to check first once a compiler exists

In descending order of "most likely to need a fix":

1. **`programs/ssr_protocol/src/instructions/common.rs::validate_asset_mint_extensions`** -- the `spl_token_2022::extension::ExtensionType`/`StateWithExtensions` API surface was written from memory without a compiler; variant names and the exact re-export path through `anchor_spl::token_2022::spl_token_2022` are the single most likely spot to need adjustment.
2. **Anchor account-space calculations** (`Reserve::SPACE`, `ProtocolConfig::SPACE`, etc.) -- manually computed byte counts; a Rust enum's Borsh-encoded size assumption (1 byte per unit-variant enum) should be double-checked against whatever `anchor-lang` 1.1.2 actually does (`InitSpace` derive macro, if available in this version, would be a more robust replacement -- consider adopting it instead of manual `SPACE` constants once compiling).
3. **`seed_reserve.rs`/`mint_reserve_tokens_in_kind.rs`'s remaining-accounts + `InterfaceAccount<TokenAccount>::reload()`** pattern -- verify `reload()` exists with this exact signature on the installed `anchor-spl` 1.1.2's `InterfaceAccount`.
4. **The `#[instruction(delegate_wallet: Pubkey)]` attribute on `AddDelegate`** -- confirm Anchor 1.1.2 still resolves instruction-argument references inside `seeds = [...]` constraints exactly as in the 0.3x lineage (nothing in the CHANGELOG's breaking-changes list suggests this changed, but it's untested).
5. **Cargo dependency resolution** -- `anchor-spl`'s `features = ["token", "associated_token", "token_2022"]` list should be double-checked against the actual current feature names in the installed crate.

## Wallet / fixture safety

- Use `solana airdrop` for DevNet SOL only. Never request, generate from, or use a Mainnet seed phrase anywhere in this workflow.
- Generated keypairs for the deploy/upgrade authority and any test wallets must never be committed -- `.gitignore` was updated (this session) to exclude `*-keypair.json`, `target/`, `.anchor/`, `test-ledger/`.
- DevNet fixture wallets (root manager, ≥2 restricted delegates, ≥2 holders) should be generated fresh per the mission's fixture requirements once Gate 9 is reachable; document their DevNet-only pubkeys (not the keypair files themselves) in this runbook once they exist.

## Deployment record (fill in once Gate 8 is reachable)

| Field | Value |
|---|---|
| Cluster | _(pending)_ |
| Program ID | _(pending)_ |
| Deployment signature | _(pending)_ |
| Deployed Git commit | _(pending)_ |
| IDL version | _(pending)_ |
| Upgrade authority pubkey | _(pending -- single dev keypair for v1, per DEC-0015; multisig migration is a pre-restricted-beta requirement, not a DevNet one)_ |
| Deployment timestamp | _(pending)_ |

## Upgrade policy (v1 DevNet)

- Upgradeable program, standard Solana `BPFLoaderUpgradeable` model (see RESERVE_REFERENCE_ANALYSIS.md section 13 for why SSR does NOT need the reference protocol's proxy/version-registry pattern -- Solana's native upgrade-in-place model already covers this).
- Upgrade authority: a single dev-controlled keypair for v1 DevNet (matches DEC-0015 -- no DAO/multisig yet).
- State-version strategy: `schema_version` field on `ProtocolConfig` and `Reserve` (currently `1`); bump on any breaking account-layout change and write an explicit migration path before deploying the new version.
- IDL versioning: Anchor 1.0 replaced legacy on-chain IDL storage with Program Metadata integration (see CHANGELOG) -- `anchor deploy`'s default IDL-upload behavior should be used rather than any manual legacy `anchor idl init`/`idl upgrade` flow (removed in 1.0 per the CHANGELOG's breaking-changes list).
- **Before any restricted beta:** migrate the upgrade authority to a multisig (e.g. Squads) and complete the security-review items listed in RESERVE_REFERENCE_ANALYSIS.md section 18 and SECURITY_INVARIANTS.md's "Outstanding gaps."
- **Before Mainnet:** full external audit; do not present the DevNet single-key trust model as production-ready (mission instruction, restated here for visibility).
