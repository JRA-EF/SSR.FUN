# Mainnet test campaign 2: DEC-0272 branch + paid Jupiter key, 12 Reserves, 2 unlocked pools

- **Date:** 2026-10-30, 13:38-14:06 UTC
- **Author:** Joao via Claude (Opus 5.5)
- **Wallet:** protocol wallet `CgHF…4Rw8`, through the app's own client code with the API handlers of branch `fix/campaign-hardening` (3f3abf5, DEC-0272) run in-process against Mainnet and the prod database. Same branch on staging (`dpl_CWfBdJ5y`). Jupiter: the new **paid server key** (now on ssr-fun and ssr-fun-staging).
- **Program:** DEC-0269 build (Squads #19). Scripts: `../SSR.FUN-camp-wt/.e2e-local/` (not committed), state `camp2.json`, log `run2.log`.

## Results

| # | Reserve | Setup | Result |
|---|---|---|---|
| — | validate | 15 negative creation cases | 14 refused. New DEC-0272 cases (11 assets; 10 assets + 5 recipients; 13 assets) refused before any transaction. "Seed $0.0005" is floored to the 1,000-raw minimum and launched (#76, see issue 5). Fee caps still refused only on-chain (about 0.00001 SOL each). |
| 76 | VAL | USDC, $0.001 | Created by the case above. Redeem, wind-down, closed. |
| 77 | CMP10 | **10 assets** (new max), 2 recipients, 6BjT co-manager | Launch 54 s (118 s yesterday). Mints $3/$2/$0.50 **3/3 OK**, 7-12 s; partial redeem OK; **remove WIF by rebalance OK** (9 s, NAV -0.036%); mint after it OK. Full redeem: see issue 1. Closed. |
| 78 | CMPIN | 8 new assets: PYTH, ORCA, JTO, W, RENDER (freeze authority), HNT, mSOL, USDC | Launch 42 s, mints 2/2, redeem, **swap W→BONK by rebalance** OK (12 s), mint, redeem all, closed. |
| 79 | CMPCP | Fee caps exactly: 5% mint / 10% TVL | Seed and mint fees exact (2.5% / 2.5%, 6BjT got its half of the manager share). Closed. |
| 80 | CMPSL | SOL only | Launch 9 s. A 0.25% mint fee charged 0.5% (DEC-0269 minimum). Closed. |
| 81 | CMPHD | cbBTC / USDC / USDT | Full lifecycle, closed. |
| 82 | CMPST | JitoSOL / mSOL / bSOL / SOL | Full lifecycle, closed. |
| 83 | CMPTH | Two pump.fun tokens + USDC (stuck yesterday as #72) | Launch OK, mint and redeem OK (one "No routes found" from Jupiter on the first try), closed. |
| 84 | CMPTB | 5 assets: **stale lookup table test** | Mint created its table; the table was deactivated; the next mint **built and registered a new table** and confirmed; the mint after reused it. DEC-0272 fix verified. Closed. |
| 85 | CMPUS | USDC, fee destination 6BjT | 6BjT received exactly the 0.5% manager share. Could not open a pool (see issue 7). Closed. |
| 86 | CMPMM | BONK / WIF / POPCAT / USDC | **Pool A** `…VxqXR`, unlocked, 1% tax: create, add $0.50, Jupiter buy + sell (0.15% withheld), collect ×2, **full LP withdraw**. Mint fee split exact. TVL accrual OK. Wound down; bots hold 0.58 tokens. |
| 87 | CMPPL | USDC / JUP | **Pool B** `…W8Me`, unlocked, 2% tax: create, add $0.01, buy + sell (0.15%), collect, full withdraw. Wound down; 5,312 raw left (pool minimum + withheld fees). |

## Issues

1. **Medium (new): a full redeem can't retry a failed swap leg.** On #77's redeem-all the redeem and 8 swaps confirmed, the USDT leg didn't land, and the retry rebuild was refused by `lib/mainnet/buildSell.ts:129` ("no Reserve Token supply") because the supply was already 0. The user sees an error although the redeem worked, and that leg stays in the wallet unswapped (1.24 USDT). The legs-only rebuild should skip the supply check.
2. **Medium (persisting): Reserves with a pool can never close**, and bots buy new pools within seconds. Pool A traded at about 2.6× NAV before our add. Raydium's locked minimum keeps supply above 0.
3. **Low (persisting): double transfer fee on pool create**: 1,008,711 tokens debited, 1,005,686 reached the pool.
4. **Low (persisting): wrong error text**: withdrawing more LP than held still says "Only unlocked treasury liquidity can be withdrawn".
5. **Low (new): seeds under $1 launch with NAV under $1.** The client floors each asset to 1,000 raw and the seed mints `max(1, floor(seedUsd))` tokens, so #76 started at NAV $0.001. Suggest a $1 minimum seed in the client.
6. **Low (to verify): collect paid the creator 38.0% of the displayed earnings on both pools** (5,033 / 13,244 and 1,421 / 3,738). With 20% SSR and a 50% holder share, 40% was expected.
7. **UX: the liquidity treasury is the fee destination.** A manager whose fee destination is another wallet can't open a pool themselves (the app says "Liquidity identity changed"). That's correct by design, but the page should say who can do it.
8. Trade tax still 0.15% on every trade. Expected until epoch 1073 (now 1072). Re-check pools #67, #71, #86 and #87 then.

## Capital (protocol wallet)

- **Start:** 8.1987 SOL + 56.2755 USDC. **End:** 7.4235 SOL + 61.6178 USDC.
- **USDC fully recovered (+5.34 USDC).** Never more than about $20 was in play at once. The gain comes from SOL legs that were seeded from native SOL and redeemed into USDC (about $6), plus pool-B and bot arbitrage, minus mint fees (most go to the Treasury and 6BjT).
- **SOL spent: 0.775 SOL (about $73 at $94.7)**, of which about 0.06 SOL turned into USDC through SOL legs. The real cost is about 0.71 SOL: two Raydium pools 0.38 SOL (0.30 is Raydium's fee), rent locked in #86/#87 and their liquidity tables, and fees. Reclaimed: 10 Reserves closed, 8 lookup tables closed (only this campaign's, each checked), 20 empty token accounts closed.
- **Left:** dust tokens under $0.05 each (about $0.15). No Reserve tokens or LP held.
