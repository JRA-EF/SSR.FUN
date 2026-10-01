# Plan: tokenized stocks as first-class assets

Measured 2026-09-23. Numbers here are on-chain counts, not estimates.

## The decision this rests on

| | Solana | Robinhood Chain |
| --- | --- | --- |
| Tokenized equities | 1,033 (xStocks, PreStocks) | 281 (257 stocks, 22 ETFs, + USDG/WETH) |
| Token standard | Token-2022 | plain ERC-20 (+ ERC-8056 multiplier) |
| Extensions | permanentDelegate, transferHook, confidentialTransferMint (+ transferFee, pausable) | none that block us |
| **Holdable by SSR** | **none** | **all** |

The Solana equities are unholdable because every one of those extensions
breaks something the protocol depends on (balance-delta accounting, custody,
computable NAV). We do not relax that.

**So: stocks are a Robinhood Chain product.** Solana stays crypto baskets. The
Solana equity catalogue is used for discovery and routing, never for holdings.
140 equities exist on BOTH chains, so a Solana user searching TSLA is one
chain away, not at a dead end.

## 1. Asset class becomes a real dimension (foundation)

Today an asset is just symbol/decimals. Add `assetClass: "equity" | "etf" |
"cash" | "crypto"` and `underlying` (the real ticker, e.g. NVDA) to `AssetRef`,
populated by `scripts/generate-robinhood-assets.mjs` from the issuer name it
already reads. Everything below keys off this one field; without it every
surface re-guesses from a name string.

## 2. Visible everywhere an asset appears

- **Discover**: a filter for *Stocks & ETFs* beside the chain filter, and
  equity reserves show their holdings as tickers (NVDA · SPY · AMZN) rather
  than a generic description.
- **Reserve page**: composition rows show the company name and an
  "equity" badge; ETFs read as ETFs.
- **Home**: featured already spans both chains; once stock reserves exist they
  rank on the same AUM basis.
- **Create, step 2**: the type-ahead becomes a browsable picker -- grouped by
  Stocks / ETFs / Cash, searchable by ticker OR company name ("nvidia" finds
  NVDA), showing what the wallet holds. 281 assets is a catalogue, not a list.

## 3. Templates (what actually makes it feel first-class)

One-click starter baskets on the Create page, built from the 281:
Magnificent 7 (all present), Semiconductors (11 present incl. NVDA, AMD, AVGO,
ASML, TSM, ARM), Big Tech, Broad Market (ETFs). A template pre-fills step 2
equal-weighted; the creator edits amounts and launches. This turns "launch a
stock reserve" from a 281-row form into two clicks, and is the single highest
-value item here.

## 4. Solana: explain, then route

An unavailable equity currently just vanishes from the picker. Carry provider +
underlying + product URL into `ledger_asset_catalogue` (same shape as the
launchpad provenance in `lib/ledger/launchpadClassification.ts`, fed by a weekly
cron running `scripts/export-tokenized-assets.mjs`) and say why:

> TSLAx is a tokenized equity (xStocks). SSR can't hold it -- transfer hook and
> permanent delegate. **TSLA is available on Robinhood Chain →**

That link is the point. 140 of them resolve.

## 5. Real prices and history

Marks come from Uniswap v3 spot today, which is honest but has no history, so
24h change and PnL read "--". Robinhood publishes Chainlink feeds for stock
tokens whose prices already include the ERC-8056 multiplier. Reading those
gives real price/AUM history for equity reserves, and is also the correct input
for rebalance pricing (see the multiplier finding in
`ssr-evm/test/SSRStockTokenMultiplier.t.sol`).

## Order

1 and 2 together (foundation + visibility), then 3 (templates), then 4
(routing), then 5 (history). 1-3 are the product; 4 makes the Solana side pay
off; 5 removes the last "--" from the cards.

## Care

Equity reserves carry ERC-8056: `balanceOf` is raw, the displayed amount is
`balanceOfUI`. Custody is pro-rata and safe; anything that PRICES must agree on
which amount it quotes. Rebalances stay on atomic-swap pricing with the 300s
cap. Nothing here claims a tokenized equity is the underlying share, and
availability is the issuer's call, not ours.
