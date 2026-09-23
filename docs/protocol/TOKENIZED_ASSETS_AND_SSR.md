# Tokenized equities and SSR.fun

Companion to `TOKENIZED_ASSET_DISCOVERY.md` (the provider-neutral export
recipe, copied verbatim from the stockscore repo). This file records what that
catalogue means *for this protocol*, measured on 2026-09-23 against the live
catalogue and mainnet — not inferred.

## The measurement

`exports/tokenized-assets.json`: 1,033 products, 1,025 xStocks + 8 PreStocks,
all Solana.

| Check | Result |
| --- | --- |
| Already in `ledger_asset_catalogue` | 840 of 1,033 |
| Of those, token program | **all Token-2022** |
| Marked `disabled` by our own extension policy | 734 |
| Marked `unreviewed` | 106 — *not yet scanned, not compatible* |

The 106 are only pending classification. Spot-checking KTOSx, JKHYx and HRLx
on mainnet, each carries `permanentDelegate`, `transferHook` and
`confidentialTransferMint`. TSLAx and the PreStocks tokens carry those plus
`transferFeeConfig`, `pausableConfig`, `defaultAccountState` and
`scaledUiAmountConfig`.

**So: effectively none of the Solana tokenized equities can be held by the
deployed program.** That is not an oversight — every one of those extensions is
rejected for a reason recorded in `packages/sdk/src/mintExtensions.ts`: a
transfer hook or fee breaks the balance-delta accounting every deposit,
redemption and rebalance uses; a permanent delegate lets a third party move the
Reserve's assets out of its vault; confidential transfers make NAV
uncomputable. Accepting them to list these assets would trade the protocol's
core guarantees for a catalogue.

## What IS available

The same equities on Robinhood Chain are plain ERC-20s, which SSR already
holds — the live EQSSR reserve holds NVDA and SPY today.

**140 equities appear on both chains**: AAPL, AMZN, AMD, ARM, ASML, NVDA,
TSLA, and 133 more. So a Solana user searching "TSLA" is not at a dead end;
they are one chain away, and the app now has both.

## How to integrate, in order of value

1. **Explain, don't hide (small).** Today a tokenized equity is silently absent
   from the asset picker. Carry the provider, underlying symbol and product URL
   into `ledger_asset_catalogue` — the same shape as the launchpad provenance in
   `lib/ledger/launchpadClassification.ts` — and say *why* it is unavailable:
   "TSLAx is a tokenized equity (xStocks). SSR cannot hold it: it carries a
   transfer hook and a permanent delegate." Same fix-class as the PUMP
   complaint: an honest, specific absence beats a silent one.

2. **Route to the chain where it works (small, high value).** With the
   underlying symbol in hand, a search for TSLA on Solana can offer the
   Robinhood reserve path instead. This is the only integration that makes the
   catalogue *actionable* rather than informational.

3. **Keep it fresh (small).** `scripts/export-tokenized-assets.mjs` runs
   standalone; wire it to a weekly cron beside `launchpad-classify-cron.ts` and
   write rows rather than committing a snapshot. `exports/*` here is a
   point-in-time handoff, and the guide is explicit that it is not a feed.

4. **Do NOT relax the extension policy (rejected).** The only way to hold these
   on Solana is to accept transfer hooks and permanent delegates. Don't.

## One more thing worth knowing

xStocks mints carry `scaledUiAmountConfig`: the raw token amount differs from
the displayed amount by an issuer-set multiplier. That is the *same* hazard as
ERC-8056 on Robinhood Chain, which the EVM side already handles — pro-rata
custody is safe, but anything that PRICES the asset must agree on which amount
it is quoting. If a wrapped or future path ever makes these holdable, that
lesson transfers directly (see `ssr-evm/test/SSRStockTokenMultiplier.t.sol`).
