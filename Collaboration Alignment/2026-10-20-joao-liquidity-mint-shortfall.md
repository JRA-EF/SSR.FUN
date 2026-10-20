# Liquidity launch/add: mint the missing Reserve Tokens first

- **Date:** 2026-10-20
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** staging (ssr-fun-staging) and prod (ssr-fun; liquidity is off there, DEC-0245)
- **Decision log:** DEC-0252

## What shipped
Launching a pool or adding liquidity is no longer capped by the Reserve Tokens the creator treasury already holds. When the treasury holds fewer than the launch or addition needs, the liquidity panel shows "Mint N more <ticker> first". N is the shortfall plus 2% headroom; a launch also counts the 0.15% transfer fee. The panel shows the estimated USDC for the mint and the total USDC needed. The mint runs through the normal Mint flow (`executeMultiAssetBuyMainnet`: same server build, USDC mint fee, swaps, double-mint guard, delivery check). When it confirms, balances refresh and the liquidity review is prepared automatically. Minting is offered only when the connected wallet is the creator treasury.

## Code touched
- `src/merge/lib/liquidity/liquidityMintPlan.ts` (new): pure sizing.
- `src/merge/components/LiquidityMintStep.tsx` (new): the mint card. If swaps landed but nothing was minted, it links to /recover.
- `src/merge/components/LiveLiquidityActions.tsx`, `LiveLiquiditySection.tsx`: the step in the launch and add forms; the forms take a `refresh` prop.
- `tests/phase_liquidity_mint_plan.ts` (new).

## Effect on others -- READ THIS
- `CreatePoolForm` and `AddLiquidityForm` now require a `refresh` prop.
- The review button stays disabled while a mint is needed (the server would refuse the review anyway).
- Next free DEC is 0253.

## Verification
Offline suite 1610 passing / 4 known failing; tsc -b; oxlint on the new files; a vite build with liquidity on and the Mainnet cluster contains the step. NOT yet verified with a real wallet: mint-then-launch or mint-then-add.
