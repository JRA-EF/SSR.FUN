# Raydium permission verified; CPMM read/prepare adapter

- Date: 2026-10-08
- Author: Yeh via Codex
- Branch: feature/raydium-permissioned-cpmm (from origin/design 6b36e0a)
- Deployed to: none
- Decision log: DEC-0231; next free ID 0232 (check other branches first)

## What changed
Permission independently verified via finalized Solana RPC: grant transaction supplied by Yeh, slot 454602528, successful CreatePermissionPda; expected PDA HqMmvmtRUHup5ACL7mTf5bCj6STYB6ZUMgnd4CN8LmLB and stored payer match 6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS.
Read/prepare adapter validates permission, config, treasury-bound PoolState, Reserve/USDC pair, token programs and USDC-only creator fees, resolves creator-share overrides, and prepares permissionless Collect to fixed treasury ATAs. No signing/submission, live UI or pool-creation implementation.

## Code touched
src/merge/lib/liquidity/raydiumCpmm.ts; tests/phase_raydium_cpmm.ts; liquidity spec, decision log and project status.

## Environments adjusted
None. Read-only Mainnet RPC. No keys read, dependencies installed, pool created or deployment.

## Effect on others
- Permission prerequisite resolved. Preferred CPMM path selected.
- Config 9 currently retains 5% of creator fees by default; net is 0.7125%, unless a treasury-specific override exists. Earlier 0% retention is stale.
- DEC-0229 Token-2022 transfer fees invalidate classic-only liquidity assumptions. Net pool deposits and arbitrage need transfer-fee treatment before live creation.
- OPEN-14: approved payer must sign and own initial asset accounts; clarify team wallet/service arrangement and final LP ownership. User asked asynchronously; do not assume a server private key is available.
- OPEN-13 remains a hard block on live Compound. Timed/permanent locks remain unimplemented. Keyed real-basket Jupiter verification remains required.
- ManageDTR hook-order issue untouched.

## Verification
Seven CPMM tests plus ten existing preview tests pass. App typecheck and full suite results recorded after verification below.

Verification completed: SDK rebuilt; app typecheck passed; oxlint passed for new files; full phase suite 1354 passing / 4 known chart/native-reset failures. Seven adapter regression tests pass. No transaction simulation or submission claimed.
