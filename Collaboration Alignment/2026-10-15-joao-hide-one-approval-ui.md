# Hide "One-Approval Mint and Redeem" from the UI

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `fix/hide-one-approval-ui`, cut from `origin/main` @ `f4e8a72`
- **Deployed to:** see the Follow-up line below
- **Decision log:** DEC-0243

## What shipped
- Manage Reserve no longer shows the "One-Approval Mint and Redeem" card or its Enable button.
- Launch a Reserve no longer ends with the optional lookup-table step: one fewer wallet approval, and no toasts about it.
- The first large mint or redemption of a Reserve without a table still creates it automatically (a separate one-time approval); its progress line now reads "One-time setup for this Reserve ...".

## Code touched
- `src/merge/pages/ManageDTR.tsx`: card, state, fetch and enable handler removed.
- `src/merge/pages/CreateDTR.tsx`: post-launch table step, the +1 approval and its step line removed.
- `src/merge/pages/DTRDetail.tsx`, `src/merge/lib/multiAssetBuyClient.ts`: setup wording.

## Effect on others — READ THIS
- `release/2026-10-15` (DEC-0241/0242, not deployed) still carries the old card; merging it will need this change kept (conflicts in ManageDTR.tsx/CreateDTR.tsx).
- `reserveAltClient.createAndRegisterReserveAlt` is now unused by the UI; the build-buy/build-sell table path is unchanged.

## Verification
tsc -b, vite build clean; oxlint count unchanged; offline suite 1519 passing with the 5 known failures.

Follow-up 2026-10-15: deployed to production `dpl_3DgwPKsxLm6sxpz447ZAffMEdU7H` (ssr-hlxul7kzi), aliased to ssr.fun; live `assets/main-C7SOuJmQ.js` checked: the old card text is absent and the new setup wording is present.
