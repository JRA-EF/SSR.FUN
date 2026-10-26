# Creator trade tax charged by the Reserve Token itself, on every route (DEC-0257)

- **Date:** 2026-10-26
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `feat/trade-tax-transfer-fee` (worktree `../SSR.FUN-tradetax-wt`), from `main` 15e59c8
- **Deployed to:** nothing yet. Needs a Mainnet program upgrade (buffer + ExtendProgram + Squads vote), then a frontend deploy.
- **Decision log:** DEC-0257

## Why
The 0-2% Buy/Sell tax creators set in the liquidity launch was only charged by `swap_with_project_tax_v2`, which nothing routes through: 0 of the 153 swaps in the five SSR pools (Jupiter, bots, direct Raydium) paid it (on-chain check 2026-10-26). DEC-0229 put a fee on every route (Token-2022 transfer fee) but 100% SSR; DEC-0240/0251 gave creators a tax but only on the SSR-routed path. Nobody joined the two.

## What changed
- Program: `enable_trade_tax` (launch transaction only, after `configure_liquidity_revenue_v2`, manager-signed) sets the Reserve Token's transfer fee to 0.15% + the larger of the pool's Buy/Sell rates, records `TradeTax` and zeroes the wrapper rates. `collect_trade_tax` (permissionless) harvests withheld fees and splits them: 0.15% + 20% of the tax -> SSR treasury, 80% -> creator treasury, holder share of that burned. `collect_transfer_fees` and `update_transfer_fee` refuse these mints (6090). Errors 6088-6090.
- Keeper job C uses `collect_trade_tax` when a `TradeTax` account exists. `scripts/update_reserve_transfer_fee.ts` skips these mints.
- Launch form: once the program has it, one "Trade tax" slider (sent as both sides); review and pool card say it is charged on every trade and transfer, any venue.

## Effect on others -- READ THIS
- One rate both directions. Separate buy/sell rates are impossible on every route (only a transfer hook could tell them apart; Raydium CPMM refuses those, and they cannot be added to existing mints).
- It also charges wallet-to-wallet sends, CEX deposits and liquidity adds/withdrawals of that token. Never mint/redeem.
- Paid in Reserve Tokens, not USDC. Token-2022 applies the new rate two epochs (about 4-5 days) after launch.
- Pools launched before the upgrade keep wrapper-only terms (Creator: "the previous ones don't matter").
- A Protocol Admin can no longer change the 0.15% part on these mints (update_transfer_fee refuses; follow-up if ever needed).

## Verification
cargo test 45/45 (5 new). LiteSVM on the compiled program: launch-only (6089), zero tax (6088), once only, old sweep + admin rate refused (6090), 0.15% before the switch all to SSR, 1.15% after: 11,500 -> SSR 3,500 / creator 4,000 / 4,000 burned (supply -4,000), payouts' own fees re-split next run; all earlier scenarios pass. IDL regenerated: purely additive. Offline suite 1718 passing / 4 known failing; tsc (app, api) clean; vite build OK.
