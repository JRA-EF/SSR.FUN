# Launch starts at NAV $1.00; held assets seed at full value

- **Date:** 2026-10-23
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `fix/launch-nav-parity` -> `main`
- **Deployed to:** production `dpl_3tkxRZm4HfkzRHrVf5ydQxAMKZ6j` (ssr.fun) and staging `dpl_BMw3EYbmBpqpbGDitGQjDC1j2mM2` (strategic-super-reserve.fun), both main 5db1aae
- **Decision log:** none (bug fix to DEC-0151/DEC-0249 funding; no program change)

## What happened
SSRES (`HZMn...eTCo`, Reserve `3iEu...Adun`), launched 2026-10-23 13:13 for $500: 100 USDC + $400 of $SSR. The creator already held $SSR, so no swap ran. The $SSR target was the BUY quote for $400 (~768,400 at the time; the two-hop route, Pump.fun fee and price impact make that ~3% fewer tokens than $400 at mid), and the wallet's 731,621.63 $SSR was within the 5% shortfall tolerance, so it seeded all of it without topping up. Vaults: 100 USDC + $369.73 of $SSR = $469.73 (mint fee priced it at $469.47). The seed still minted 500 tokens (one per committed dollar), so NAV started at $0.939.
Gap: $18.59 untopped shortfall + $11.68 buy-quote vs mid sizing = $30.27.

## Fix
1. **Server mints by value** (`lib/mainnet/buildSeed.ts`, `initialTokensForSeedValue`): `seed_reserve_usdc_fee`'s `initial_reserve_tokens` is now the basket's value at SSR's prices -- the same `depositValueUsdcRaw` the mint fee is charged on -- one token per dollar, so NAV starts at exactly $1.00 whatever the swaps delivered. The browser's figure is kept when the value is missing or more than 2x off (a broken price, not swap costs). The build response already returns `initialReserveTokens`, now the real one.
2. **Held assets seed at full value** (`src/merge/lib/createReserveClient.ts`): for an asset the creator already holds, the target is its budget at the mid price (`midPriceUsd`, passed by both Create and Resume from `/api/mainnet/asset-prices`), not the buy quote; and the 5% shortfall tolerance now applies only to an asset this launch already bought. A held asset short of its target buys the gap (anything above the $0.05 dust floor), so only the missing part pays swap fees.

With both, the SSRES launch would have bought ~$30 more $SSR, deposited ~$499 and minted ~499 tokens at $1.00.

## Effect on others -- READ THIS
- The creator may now receive a non-round token count (e.g. 499.31 for a $500 launch). The Review step's "you'll receive" figure is still the committed amount and is labelled as an estimate; the chain value replaces it after launch.
- A creator who holds part of an asset now needs USDC for the top-up. The existing per-swap USDC preflight names the shortfall before anything is signed.
- No program change; DevNet's `seed_reserve` path (no USDC fee) is untouched.

## Verification
`tsc -b` clean; `tests/phase_launch_nav_parity.ts` 8 passing; full offline suite 1,703 passing, only the 4 known `phase_chart_range_selector` failures (same on main).
