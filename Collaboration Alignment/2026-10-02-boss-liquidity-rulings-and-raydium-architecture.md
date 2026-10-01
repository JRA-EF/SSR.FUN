# Liquidity Module: Yeh's product rulings (DEC-0222) and the conditional Raydium architecture (DEC-0223)

- **Date:** 2026-10-02
- **Author:** Boss / Yeh (enigma@enigma-fund.com) via Claude Code (Fable 5.1)
- **Branch / commits:** `feature/liquidity-arch` (branched from `origin/design` @ `f30beb4`). Not merged to `design`, `staging` or `main`.
- **Deployed to:** none
- **Decision log:** DEC-0222, DEC-0223 (appended). **Next free id is DEC-0224.**

## What shipped
Documentation and preview-copy changes only; no on-chain or live-client code.

1. **Rulings (DEC-0222).** DEX liquidity is optional and never blocks launch. LP fees are the **creator's** earnings, paid to a fixed creator treasury (the spec's "Reserve treasury" was imprecise -- OPEN-8 resolved; LP fees are not part of the 50% $SSR buyback). The creator gets **Collect** and **Compound**. Locks bind principal only; fees stay collectable/compoundable in every lock state. **No partial locks in v1**: the lock applies per liquidity-addition tranche. Badges must read chain state.
2. **Architecture (DEC-0223), conditional on Raydium.**
   - Preferred: Raydium **permissioned CPMM** on AmmConfig index 9 (`LNmHRmMvk9kmtepfTSr98kqGLThd61kH1DPWf2cVRaC`, 0.25% trade + 0.75% creator). Needs a Raydium-granted `Permission` PDA (8 exist on Mainnet). **SSR has NOT been granted one. Do not claim or imply otherwise anywhere.** Yeh is contacting Raydium.
   - Committed fallback: **permissionless Raydium CLMM**, Reserve Token / USDC, full-range position opened at NAV, **0.8% tier** (index 17, `DQeN7dZyQvXKT7YwmgqyuC7AYFkwMoP7RwtucsDEdfYZ`), `CreateCustomizablePool` with `collect_fee_on` = the USDC side and dynamic fee **off**. Timed locks via a minimal SSR escrow program holding the position NFT; permanent locks via Raydium's native lock (compounding a locked tranche = new locked position). Everything behind a liquidity adapter so the primitive can change without touching the UI.
3. Spec `docs/project/LIQUIDITY_MODULE_SPEC.md` bumped to v0.3 (Sections 1, 2, 3.2, 4.1, 5, 6, 7, 8, 10 edited; new Section 12).
4. Preview UI: **Compound** button beside Collect; every "Reserve treasury" string now reads "your creator treasury"; lock copy says fees keep flowing; Solana pool type label reads "full-range position". Still labelled a design preview; no funds move.
5. `scripts/liquidity_arb_band.ts`: NAV-arbitrage band model with live Jupiter quotes (run with `JUPITER_API_KEY` for the keyed API; lite-api rate-limits).

## Code touched
- `docs/project/DECISION_LOG.md` -- DEC-0222, DEC-0223 appended.
- `docs/project/LIQUIDITY_MODULE_SPEC.md` -- v0.3 as above.
- `docs/project/PROJECT_STATUS.md` -- Last 5 Working Days, In Progress, Decisions Required, Last Updated.
- `src/merge/lib/liquidityPreview.ts` -- `poolTypeLabel` narrowed to "full-range position"; `compoundedTotalUsd` on the preview pool; doc comments.
- `src/merge/store/useAppStore.ts` -- new `compoundLiquidityPreviewFees` action; `compoundedTotalUsd` initialised.
- `src/merge/components/LiquidityModule.tsx` -- Compound button + copy changes (no layout changes beyond the fee card's button row).
- `scripts/liquidity_arb_band.ts` -- new.

## Repositories / environments adjusted
- SSR.FUN only, branch `feature/liquidity-arch`. No Vercel, Neon, Squads, Raydium or key changes.

## Effect on others -- READ THIS
- **DEC numbering:** 0222 and 0223 are taken on `feature/liquidity-arch`. Use **0224** next. (Numbering note from the 2026-10-01 entry still stands: the duplicated 0197-0202 block on `main` needs renumbering, owner unassigned.)
- **Merge path:** this branch is meant to merge into `design` (Boss's branch) and ride to `main` with the design -> staging -> main flow; it is NOT a PR to `main`. Tell the folder before merging it anywhere else.
- **Do not start live liquidity client work** until Raydium answers on permissioned CPMM or Yeh calls the fallback. When it starts: the adapter interface in spec Section 12.4 is the seam; the preview store actions are its first implementation.
- **Before any lock is built:** OPEN-12 -- confirm USDC/SOL are not on Raydium's CLMM restricted-issuer NFT-freeze list.
- **Before implementation:** re-run `scripts/liquidity_arb_band.ts` with the keyed Jupiter API against real Reserve compositions (DEC-0223 makes this a precondition).
- Persisted preview pools created before this change lack `compoundedTotalUsd`; the store treats it as 0 (`?? 0`), no migration needed.
- Liquidity files (`LiquidityModule.tsx`, `liquidityPreview.ts`, the spec) remain the Boss's in-flight area -- coordinate before editing.

## Verification
- `npm run build --workspace=packages/sdk` then `npx tsc -p tsconfig.app.json --noEmit`: clean.
- oxlint on the changed files and the repo test suite: see the commit message for results.
- Preview behaviour (Compound button, copy) checked in the browser on the dev server; no deploy.
- On-chain facts (AmmConfig decodes, Permission PDA count, CLMM config list) read from Mainnet RPC and `api-v3.raydium.io` on 2026-10-01; Raydium program sources at raydium-cp-swap `59fb845` and raydium-clmm `ed1eb41`.

**Follow-up 2026-10-02 (same author):** review-fix commit per Yeh (DEC-0224). Solana pool label is now the neutral "liquidity pool" (not "full-range position"); the preview's pair selector is USDC-only on Solana (SOL = OPEN-2b); the spec no longer mentions DevNet; `scripts/liquidity_arb_band.ts` measures USDC→basket and basket→USDC separately against Jupiter mid; Compound is a no-op / disabled without a valid NAV (never a $1 fallback) with regression tests in `tests/phase_liquidity_preview.ts`; wording is "creator DEX earnings" (native CPMM creator fee vs. creator's share of CLMM LP fees). **Next free DEC id: 0225.**
