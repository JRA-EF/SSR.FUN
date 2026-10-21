# Reserve page: "no liquidity pool yet" banner replaces the unwired add-liquidity card

- **Date:** 2026-10-21
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** none yet (prod has liquidity off; ships with the liquidity prod deploy)
- **Decision log:** none (UI change requested by the Creator)

## What shipped
- The Reserve page showed the root Manager a large "Take your Reserve Token to market" card after their own mint, with the design-preview add-liquidity form inside it. That form was never wired to the live pool flow, so submitting it did nothing. It is gone.
- In its place: a one-line banner for the root Manager -- "TICKER has no liquidity pool yet. Add one on Raydium to give it an open market, with a public price and chart." -- with **Launch liquidity** (opens Manage Reserve on the Liquidity tab, where pools are really launched) and **Not now**.
- It now shows on every visit by the root Manager while there is no pool, not only right after a mint. On Mainnet it asks `/api/mainnet/liquidity` (`action: read`) once per page view, only for the connected root Manager, and stays hidden while loading or if the read fails -- it never claims "no pool" without the server saying so. Off-Mainnet it uses the design-preview pool state as before.
- Manage Reserve accepts `#/dtr/<id>/manage?tab=liquidity` to open the Liquidity tab directly.

## Code touched
- `src/merge/components/LiquidityModule.tsx` -- `LiquidityFirstMintIntro` replaced by `LiquidityLaunchNudge` (+ `useLiveHasNoPool`).
- `src/merge/pages/DTRDetail.tsx` -- mounts the banner for the root Manager whenever liquidity is enabled.
- `src/merge/pages/ManageDTR.tsx` -- initial tab from `?tab=liquidity`.

## Effect on others -- READ THIS
- Everything is behind `VITE_ENABLE_LIQUIDITY` (off on prod), so prod is unchanged until the liquidity deploy.
- `LiquidityPanel` (the preview form) is still used by the design-preview Liquidity tab off-Mainnet; untouched.
- Copy avoids "buy/sell" (the DEC-0228 terminology test scans all of src/).

## Verification
tsc clean; oxlint shows no new findings (ManageDTR's 7 pre-existing rules-of-hooks findings unchanged, shifted by 5 lines); offline suite 1616 passing / 5 pre-existing failures; a `VITE_ENABLE_LIQUIDITY=true VITE_SOLANA_CLUSTER=mainnet-beta` build contains the banner and the `manage?tab=liquidity` link. Not yet seen in a browser with a root-Manager wallet.
