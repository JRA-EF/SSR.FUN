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

## How to integrate the shared artifacts, visibly

The artifacts are: the guide (`TOKENIZED_ASSET_DISCOVERY.md`), the runnable
exporter (`scripts/export-tokenized-assets.mjs`, Node built-ins only), and a
1,033-row snapshot (`exports/tokenized-assets.{json,csv}`). The design below
uses all three without pretending the catalogue is something it is not.

### Where the data lives

A table of its own, `ledger_tokenized_assets`, keyed by mint:

    mint (pk), provider, product_name, symbol, underlying_symbol,
    network, official_product_url, catalog_source_url,
    provider_token_price_usd, provider_mark_price_usd,
    implied_valuation_usd, retrieved_at, first_seen_at, removed_at

It is PROVENANCE, joined to `ledger_asset_catalogue` by mint -- never merged
into it and never consulted for eligibility. Eligibility stays exactly where it
is (`assessMintAccount`, the program's extension policy). A row here says "this
mint is a tokenized equity from this provider"; it never says holdable,
tradable or available.

### How it refreshes

`api/ledger/tokenized-assets-cron.ts`, weekly, beside
`launchpad-classify-cron.ts`. It calls the exporter's normalizers directly --
the script already exports `normalizePrestocks` / `normalizeXstocks` and uses
only Node built-ins, so it runs unmodified -- and upserts, setting `removed_at`
for rows a provider stops listing rather than deleting them. `exports/*` stays
as the checked-in handoff snapshot; the guide is explicit that it is a
point-in-time export, not a feed, so the app must never read those files at
runtime.

### Surface 1: a real page (the visible part)

`#/stocks` -- "Tokenized Stocks", in the primary nav. Every row: symbol,
product name, underlying ticker, provider badge, official product link, and a
status chip that is the honest answer for THAT asset:

| Status | Meaning |
| --- | --- |
| Available on Robinhood Chain | the same underlying is one of our 281 ERC-20s -- links to Launch with it pre-filled |
| Not holdable on Solana | names the blocking extensions, e.g. "transfer hook, permanent delegate" |
| Not yet reviewed | in the catalogue, extension scan pending |

Filters for provider, status and a search box. A footer line carries
`retrieved_at` and links the source APIs and the guide, so the page states its
own provenance rather than implying the app discovered this itself.

### Surface 2: search

The existing `ReserveSearch` in the header currently finds Reserves. Typing
TSLA should also find the tokenized asset and show its status chip, because
that is where a person actually asks the question.

### Surface 3: the Create picker

An equity ticker typed into the Robinhood basket picker already resolves. The
Solana picker should resolve it too -- and then refuse it with the reason and
the cross-chain route, instead of the ticker silently not existing.

### What the UI must not do

The guide is strict, and these are load-bearing:
- never present a listing as liquid, buyable, or legally available;
- never infer a mint from a ticker -- always the provider's published address;
- always show provider, retrieval time and source URL next to the data;
- provider price/mark/valuation are PROVIDER values, labelled as such, never
  shown as an observed pool quote or a Reserve NAV input;
- keep the exporter's `VCXX` exclusion; adding a provider means its own
  official catalogue and its own verified mint mapping.

### Effort

Table + cron half a day; the page about a day; search and the picker a few
hours each. Nothing here touches the program, the catalogue's eligibility
rules, or any Reserve's holdings.

## One more thing worth knowing

xStocks mints carry `scaledUiAmountConfig`: the raw token amount differs from
the displayed amount by an issuer-set multiplier. That is the *same* hazard as
ERC-8056 on Robinhood Chain, which the EVM side already handles — pro-rata
custody is safe, but anything that PRICES the asset must agree on which amount
it is quoting. If a wrapped or future path ever makes these holdable, that
lesson transfers directly (see `ssr-evm/test/SSRStockTokenMultiplier.t.sol`).
