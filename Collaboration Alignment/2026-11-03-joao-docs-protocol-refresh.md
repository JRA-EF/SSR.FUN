# Public /docs refreshed to the current protocol mechanics

- **Date:** 2026-11-03
- **Author:** Joao via Claude Code (Claude Opus 5.5)
- **Branch / commits:** `docs/protocol-refresh` rebased on `main`, pushed to `main` (and `design` fast-forwarded)
- **Deployed to:** production (dpl id in PROJECT_STATUS.md)
- **Decision log:** DEC-0280

## What shipped
ssr.fun/docs (all four documents) now describes the protocol as it runs today: USDC mint fee with the 0.5% protocol floor, redemption and ongoing fees settled in USDC through the fee vault, launch rules (10 assets, exact 100%, $1 seed, route check, price lock), real rebalancing, the SSR pool launch on Raydium with its permanent fee terms (SSR 20% of creator earnings, holder share to backing or locked pool liquidity), the trade tax as part of the token's transfer fee, and the newer PDAs. "Adding liquidity" gained two tabs: `?tab=on-ssr` and `?tab=terms`.

## Code touched
- `src/docs/content/GettingStarted.tsx`, `ProtocolReference.tsx`, `ReserveTokensOnDexes.tsx`, `AddLiquidity.tsx`, `index.tsx` — content
- `src/docs/content/addresses.ts` — `POOL_TRADE_FEE_BPS`, `MIN_TRADE_TAX_BPS` (docs may not hard-code 0.15%/0.25%; the terminology test enforces it)
- `CLAUDE.md` — fee lines now match DEC-0269 (0% mint/TVL fee charged at 0.5%) and DEC-0257 is marked live

## Repositories / environments adjusted
- SSR.FUN: main, design, production deploy. No env, program or API change.

## Effect on others — READ THIS
- When a fee rule, the liquidity flow or the account set changes, update `src/docs/content/*` and bump the `updated` date in `index.tsx`.
- Public docs describe how things work; open gaps (e.g. the double transfer fee on pool launch) stay in DECISION_LOG, the docs state the cost neutrally.

## Verification
`tests/phase_terminology_and_tax_hold.ts` 27 passing, `tsc -p tsconfig.app.json` clean, `vite build` clean, headless Chrome render of every changed tab.
