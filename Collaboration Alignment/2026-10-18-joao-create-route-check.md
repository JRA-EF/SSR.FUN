# Launch a Reserve: route check, exact 100%, swaps before creation

- **Date:** 2026-10-18
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `feat/create-preflight`, cut from `origin/main` @ `8314b45`
- **Deployed to:** none yet
- **Decision log:** DEC-0249

## What shipped
- Basket Composition: Next needs exactly 100%. When you continue, every asset is checked for a working Jupiter route at the amount the launch will spend. Each asset is marked Ready, Risky (can continue), Must remove, or Could not check (never blocks). Must-remove assets have a Remove button. Removed assets stay listed with a "replace it" note.
- Launch swaps every asset BEFORE creating the Reserve. If one asset's swap fails, nothing is created on-chain. The page goes back to the basket with that asset flagged and every field kept. Assets already swapped for are reused from the wallet.
- Prices are locked for 20 minutes from the first launch attempt. Retries, relaunches and Resume inside that window keep earlier swaps and targets.
- Slippage no longer stops a launch. A swap that does not land is retried at 1.5%, then 3%, then 5%. What each asset really received shows under it in the Wallet Cost Summary, plus a footer warning.
- The whole Create form is saved per wallet and restored on return (pictures excluded). It is cleared on launch.

## Code touched
- `src/merge/lib/createReserveClient.ts`: fund before create-and-register. Adds `SeedAssetFundingError`, `LAUNCH_PRICE_LOCK_MS`, `LAUNCH_SWAP_SLIPPAGE_STEPS_BPS`, `priceLockUntil`/`persistedFunding`, and `onSwapSettled`.
- `src/merge/lib/launchPreflight.ts` (new) and `api/mainnet/launch-preflight.ts` + `lib/mainnet/launchPreflight.ts` (new): the route check.
- `src/merge/lib/createDraft.ts` (new): the saved draft.
- `src/merge/components/LaunchCheckPanel.tsx` (new): the per-asset list.
- `src/merge/pages/CreateDTR.tsx`: gate, panel, draft, failure path, Wallet Cost Summary notes, approval order copy.
- `src/merge/lib/jupiterSwapClient.ts` (`JupiterQuoteError`) and `api/mainnet/jupiter-swap.ts` (`reason` on every error).
- `src/merge/lib/launchFunding.ts` (`budgetUsdcRaw`) and `src/merge/lib/basketAllocation.ts` (`allocationGateMessage`).

## Repositories / environments adjusted
- SSR.FUN only. No env vars, no program change.

## Effect on others -- READ THIS
- **Launch approval order changed:** swaps first, then create-and-register, then seed. A `CreateReserveStepError` at `fund-seed-assets` with `addresses === null` means nothing was created.
- New localStorage key `ssr_create_draft_v1`. Do not reuse it.
- New endpoint `/api/mainnet/launch-preflight` (quotes only, 12/min per IP).
- Gap: a creator who abandons after some swaps keeps those assets in the wallet. `/recover` does not list them yet (it only knows created Reserves).

## Verification
`tests/phase_create_preflight.ts` 23 passing. Full offline suite 1577 passing / 5 failing (known set plus the IDL pin test that needs `target/idl`). tsc, vite build and oxlint are clean. A live read-only route check against Jupiter's lite API behaved as expected. Not yet run with a real wallet launch.

- **Follow-up 2026-10-18:** deployed to staging `ssr-fun-staging` (strategic-super-reserve.fun) dpl_F5fJ4t3bzBqacL6X8rb6BTQTGPu9 = `feat/create-preflight` d8f29b4 (contains staging's previous build 1b77417, so this also brings DEC-0244 native SOL to staging). Not on main or ssr.fun. The route-check endpoint sits behind the site password gate like every API there; test from a signed-in browser.
