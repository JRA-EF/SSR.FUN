# Mainnet test campaign: creation edge cases, 10-12 asset Reserves, 6BjT as co-manager and fee recipient, rebalances, unlocked pools

- **Date:** 2026-10-29, 12:20-13:11 UTC (plus the DEC-0269 and #67 liquidity runs from 10:59-11:18)
- **Author:** Joao via Claude (Opus 5.5)
- **Wallet:** protocol wallet `CgHF…4Rw8`, through the app's own client code (createReserveClient, multiAssetBuy/SellClient, rebalanceClient, liquidity clients, managementClient) with the production API handlers run in-process against Mainnet and the prod database. Jupiter: keyless lite API (same 5 req/10 s limit as the publishable key prod has).
- **Program:** DEC-0269 build (Squads #19, slot 462844402). **App:** main 6d6a5b5 / 89a66c2.
- **Scripts:** `../SSR.FUN-feemin-wt/.e2e-local/camp.ts` (+ `liqc.ts`, `swapc.ts`, `sweep.ts`, `reclaim.ts`), state in `camp.json`. Not committed (`.e2e-local` is excluded).

## Effect on others: READ THIS

1. **Incident (mine, contained 12:57-12:59 UTC):** a cleanup step deactivated every lookup table owned by `…4Rw8`, and nine were shared trading tables in `reserve_alts` (`D6ju…`, `8dCAnN…` (#26), `HNkM…`, `A5CH…`, `F5FS…`, `4GKo…`, `D8eu…`, `CtsC…`, `6owr…`). I deleted those 9 rows and closed all deactivated tables. The next mint on each of those Reserves creates a new table through the one-approval flow; that path was verified on #67. **`planAlt` (lib/mainnet/buildCommon.ts) uses the registered table without checking `isActive()`.** A deactivated table makes every trade on that Reserve fail until its row is removed. It should skip an inactive table and drop the row.
2. **The Jupiter key is the biggest problem the campaign found.** On the current key, **a 10-asset Reserve can't be minted or redeemed through the app**: 4 of 4 mints and 1 of 1 redeem failed with "too many requests". Asset removal by rebalance failed 3 of 3. The server builds every leg's quote in one burst, and the key allows 5 per 10 s. A paid Jupiter key is needed before multi-asset Reserves are usable.
3. **12-asset Reserves can't be launched.** The app's maximum is 12 (`MAX_ASSETS_PER_RESERVE`), but the seed transaction for 12 assets touches about 70 accounts, over Solana's 64-account lock limit. A lookup table doesn't help. Reserve **#69** (`394R…bgxo`) is stuck in `assetsInitializing` for good. 10 assets with 2 fee recipients fits. The cap should be lowered, or the seed split.

## Runs

| # | Reserve | Setup | Result |
|---|---|---|---|
| 1 | validate | 13 negative creation cases | 13/13 refused. The fee caps (5.01% mint, 10.01% TVL) are only caught **on-chain**: a failed tx at about 0.00001 SOL, nothing created. The seed-below-minimum case **created #68 before failing** (see incidents). |
| 2 | **#69** E2E12 | 12 assets, 1%/1%, 6BjT co-manager + 50/50 recipient | Created, then the **seed doesn't fit** (64 account locks). Stuck. The swapped assets stayed in the wallet and were reused/swept. |
| 3 | **#70** E2E10 | 10 assets incl. cbBTC (8 dp) + BONK (5 dp), 1%/1%, 6BjT co-manager + 50/50 recipient | Launch OK, 118 s. Seed fee exact. TVL accrual OK. Rebalance (BONK→USDC, 1 swap) OK, NAV −0.005%. **Mint 0/4 and redeem 0/1 (Jupiter 429).** Swept with an **in-kind redeem** through a 55-key lookup table, then one swap per asset. Wound down. **Can't be closed**: 1 protocol fee share left. |
| 4 | **#71** E2EOD | BONK/WIF/USDC, 3.33% mint / 0.07% TVL, 6BjT co-manager + recipient | Odd fee split exact (protocol 166 / manager 167 bps; the TVL floor gives protocol 50 / manager 0). Mints of $2, $1, $0.50 and **$0.01** all exact to the unit. Rebalance adding JUP OK (NAV −0.15%). **Removing WIF failed 3/3** (see below). Recipients changed to 30/70 mid-run: the next mint routed exactly 70% to 6BjT. **Unlocked pool** with 1% trade tax, add $1, add $0.01, collect ×2, trades, full withdraw, redeem all. Still active: **bots hold 2.40 E2EOD** (NAV 1.011, fully backed). |
| 5 | **#72** E2ETH | Two pump.fun tokens + USDC | The route check passed, then the seed failed ("no current price") → stuck. **Resume** recovered it (seed fee exact). Delegate add, change permissions to 2, remove: all OK. Metadata edit OK. Redeem all, wind-down, **closed** (+0.0107 SOL). |
| 6 | **#68** VAL | USDC only (stuck by run 1) | **Resume** with $1: seeded and active. Wind-down → redeem → **closed** (+0.0053 SOL). |
| 7 | **#73** E2EBD | USDC/SOL, 2% mint, fee destination = **6BjT 100%** | Launch 9 s (no swaps). 6BjT got exactly 1% of the seed and of a $1 mint. Redeem all, wind-down, **closed** (+0.008 SOL). Full lifecycle, about 0.03 SOL. |
| 8 | **#74** E2E6 | 6 assets, 1%/1%, 6BjT recipient | Rate-limit probe: **mint 2/2 OK** (31-36 s, slowed by retries), fees exact. Redeem all OK. Wind-down, **closed** (+0.022 SOL). |
| 9 | **#75** E2E8 | 8 assets, 1%/1%, 6BjT recipient | **Mint 0/2** (Jupiter 429, then "no real current USD price" for SOL: the price API is rate-limited too). **Redeem 1/1 OK.** Wind-down, **closed** (+0.028 SOL). **Threshold on the current key: mint breaks between 6 and 8 assets, redeem between 8 and 10.** |
| (earlier) | **#67** E2EF | 0%/0% fees, DEC-0269 | See the DEC-0269 entry. Pool `…5detfpwi` unlocked; launch, buy, sell, collect, withdraw all OK. A bot holds 0.557 E2EF. |

## Fees tracked (USDC)

- **Treasury** received about 0.272 USDC in mint/seed fees this campaign. Every one was within 0.5% of expected (the gap is price drift between quote and NAV), and exact on the USDC-only and SOL-only Reserves. Plus the 20% pool share of LP earnings, and 0.15% transfer fees withheld on every pool trade.
- **6BjT (Creator wallet)** received **0.1505 USDC**: 50% (later 70%) of the manager share on #70/#71, and 100% on #73. It's live money in that wallet.
- **TVL:** the 1-day accruals on #63/#64 earlier today matched 0.5%/yr to the unit. In-campaign accruals were seconds long (1 unit, rounded up).
- **Trade tax:** pools #67 and #71 withhold 0.15% today. The 0.65% / 1.15% rates start at epoch 1073 (around 2026-10-31). **Re-check then** with a tiny trade.

## Incidents and bugs (severity order)

1. **High: Jupiter rate limit breaks multi-asset Reserves** (above). Also: (a) the launch route check returns "unchecked" for some legs; (b) `build-seed` reports a 429 on the price API as "a reserve asset has no current price" **after the Reserve was created** (run 5); (c) `build-rebalance` reports "route is too large to fit" when the smaller route's build was actually rate-limited (run 4, WIF removal); (d) a wound-down Reserve's mint isn't refused before the quotes.
2. **High: 12-asset seed exceeds 64 account locks** (above). #69 is stuck.
3. **High (mine): bulk ALT deactivation** (above). Contained; rule saved: never bulk-deactivate tables owned by the protocol wallet.
4. **Medium: creation can strand a Reserve.** The seed-minimum check and the price check run **after** `create-and-register`. Resume recovers it once the cause clears (runs 5 and 6), but rent is spent and the Reserve stays listed as initialising until then. These checks should move before creation.
5. **Medium: `build-seed` 404 right after creation** ("Reserve not found on Mainnet", run 1). An RPC read-after-write gap; there's no retry.
6. **Medium: a Reserve that ever accrued a TVL fee can't be closed.** Supply never reaches 0 because only the keeper can redeem fee-vault shares, and it defers dust. Its rent stays locked (#70). Suggest a keeper path that flushes the fee vault of wound-down Reserves.
7. **Medium: new small pools get sniped within seconds.** Bots bought $1-2 into #67 and #71 at prices up to **4x NAV**. It's harmless to us (arbitrage: 1 E2EOD minted at $1.01 sold for $3.89), but buyers overpay, and bot-held tokens keep test Reserves from closing.
8. **Low: pool launch double transfer fee.** 2,983,052 tokens debited, 2,974,109 reached the pool (0.3% = 0.15% twice). Already known.
9. **Low: wrong error text.** Withdrawing more LP than held says "Only unlocked treasury liquidity can be withdrawn" although the pool is unlocked.
10. **Low:** the metadata endpoint accepts an 84-character name (the token name is trimmed to 32 on chain). PYUSD is refused (permanent delegate), which is correct, but it means no Token-2022 asset could be tested.

## Capital

- **Start (12:20):** 8.885 SOL + 18.06 USDC. **End (13:11):** 8.199 SOL + 56.28 USDC. 0.30 SOL was swapped to 30.09 USDC for funding.
- **Net cost about $31.** 0.387 SOL spent, against +8.1 USDC from LP earnings and the bot arbitrage. That's after reclaiming about 0.27 SOL by closing 5 Reserves, about 30 empty token accounts and 25 lookup tables (some of the tables were older). The main costs were one Raydium pool (0.19 SOL, of which 0.15 is Raydium's fee) and the Reserves that can't be closed: #69, #70, #71. A closable test Reserve costs about 0.03-0.04 SOL net.
- **Swept:** no Reserve tokens or LP held. Only dust tokens worth under $0.05 each remain.
- **Still open on chain:** #69 (stuck), #70 (wind-down, 1 fee share), #71 (active, bots hold 2.40), #67 (active, a bot holds 0.557). The pools on #67 and #71 hold only Raydium's locked minimum.

## Next

- Install a paid Jupiter key, then re-run 10-asset mint, redeem and asset removal (launch a fresh 8-10 asset Reserve; #70 is wound down).
- Fix the `planAlt` isActive check, cap assets at what a seed fits, and move the seed price/minimum checks before creation.
- Trade-tax check at epoch 1073 on pools `…5detfpwi` (#67) and `…GwQG98` (#71).
