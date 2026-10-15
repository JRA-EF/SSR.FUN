# Empty Reserves stay discoverable, with a "possibly abandoned" warning

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `fix/empty-reserve-discoverable`, cut from `origin/main` @ `3250b70`
- **Deployed to:** production ssr.fun dpl_38y4crRQfnvF3PDqHAhazWUhDfWq (main 7b48dc1), 2026-10-15. Staging not redeployed (Yeh is testing liquidity there).
- **Decision log:** DEC-0246

## Why
The Creator launched "SOLAMI" (Reserve …9TdPji) and redeemed every token the same morning. It then vanished from Discover, search and Manage Reserve. The shared eligibility gate hid any Reserve with zero supply as "never seeded". Seven more Mainnet Reserves are in the same state (I, testt, STOCKLANA, SUPERTEAMGERMANYRULES, ILOVESOLANA, ram, …gNZRir). All of their vaults and fee vaults read 0, so no funds are stranded.

## What changed
- `packages/sdk/src/reserveEligibility.ts`: the zero-supply rule is gone. A never-seeded Reserve is still hidden by its `assetsInitializing` status. A Closed Reserve no longer exists on-chain. New `isEmptyReserve()` and `EMPTY_RESERVE_WARNING`.
- Discover / Featured card (`reserveCardProps.ts`, `components/ReserveCard.tsx`, `.badge-warn` in `index.css`): an "Empty · possibly abandoned" badge, "Price unavailable" in place of the 0/0 fallback price, and a "View" button instead of "Mint".
- Reserve page (`DTRDetail.tsx`): an "Empty" badge, the warning banner, and the Mint tab plus the mobile Mint button disabled (same pattern as Wind Down).
- Manage Reserve gets the Reserve back automatically, because it uses the same gate.

## Effect on others — READ THIS
- **These Reserves cannot be minted.** The program's mint needs supply > 0, and `seed_reserve*` only accepts `assetsInitializing`. Making them mintable needs a program upgrade, which the Creator decided against for now ("maybe just add a warning").
- Landing-stats Reserve counts now include empty Reserves.

## Verification
- New `tests/phase_empty_reserve.ts` (5 tests); `phase_reserve_eligibility.ts` updated.
- Offline suite 1526 passing / 4 known failures (ChartTimeframeSelector ×2, native-control reset ×2). `tsc -b` and `npm run build` clean.
- Not yet browser-checked on a deployment.
