# Real rebalancing: the vaults actually change

- **Date:** 2026-10-18
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `feat/rebalance-execution`, cut from `origin/main` @ `8314b45`
- **Deployed to:** none yet. The Mainnet program upgrade is NOT executed.
- **Decision log:** DEC-0250

## What shipped
- **Program (additive):**
  - `rebalance_swap_begin` / `rebalance_swap_end` form a flash swap inside one transaction: the vault lends the sell asset, the Jupiter route swaps it, and end deposits the output into the buy vault.
  - End must receive at least `min_out`. SSR's quote signer co-signs that minimum (the keeper key from DEC-0238).
  - `remove_reserve_asset_compact` removes an empty asset from any position. The last-registered asset takes over that position.
- **Server:** `/api/mainnet/build-rebalance` plans the swaps from vault balances, prices and targets. It builds the targets tx, one co-signed tx per swap, and the cleanup tx. GET reports whether the deployed program has the instruction.
- **Manage → Submit Rebalance:** one wallet approval covers every transaction. Per-step results are shown. "Rebalance Holdings to Targets" appears when holdings are off target. The composition hides 0% assets with empty vaults.

## Code touched
- `programs/ssr_protocol/src/instructions/rebalance_swap.rs`, `remove_reserve_asset_compact.rs`, `state/rebalance_ticket.rs` (all new).
- `programs/ssr_protocol/src/errors.rs`: errors 6076-6079 appended. Also `events.rs`, `constants.rs`, `lib.rs` and `Cargo.toml` (adds `solana-instructions-sysvar`, already in the lock).
- `packages/sdk/idl/*` (regenerated) and `packages/sdk/src/rebalanceSwapInstructions.ts` (new).
- `lib/mainnet/rebalancePlan.ts`, `lib/mainnet/buildRebalance.ts`, `api/mainnet/build-rebalance.ts` (all new).
- `src/merge/lib/rebalanceClient.ts` (new). Also `src/merge/lib/onChainReserve.ts` (`visibleCompositionAssets`) and `src/merge/pages/ManageDTR.tsx`.
- `tools/rebalance-litesvm/`: a standalone crate that runs the compiled program in LiteSVM (`cargo +stable-x86_64-pc-windows-msvc run`).
- `scripts/rebalance-dry-run.ts` and `scripts/rebalance-probe.ts`: both read-only.

## Effect on others -- READ THIS
- Asset `order_index` can now change after a compact removal. Always read it from chain; every current builder already does.
- Error range is now 6000-6079.
- Building on this machine:
  - Host Rust builds need `cargo +stable-x86_64-pc-windows-msvc`; the GNU default fails to link build scripts.
  - `anchor idl build` needs `rustup default stable-x86_64-pc-windows-msvc` for the run. Switch back to the GNU default afterwards.
- The frontend can ship before the upgrade: it asks the chain and keeps the old target-only flow, with honest copy, until the instruction exists.

## Verification
- `tests/phase_real_rebalance.ts`: 16 passing. Full suite: 1570 passing / 5 known failures. `cargo test`: 33 passed.
- LiteSVM run against the compiled binary: the swap, 7 refusals, a compact remove and a redemption afterwards all behaved as designed.
- Read-only dry run on live testes: 2 swaps + 1 removal, all within transaction size.
- origin/main's program is byte-identical to the live Mainnet program (88bce6d0…).
