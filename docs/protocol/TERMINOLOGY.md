# SSR.fun terminology: Mint, Redeem, Buy, Sell

**Status: mandatory, final as of 2026-10-06 (DEC-0228).** This is the single
source of truth for these four words. `CLAUDE.md` and `AGENTS.md` point here.
Any human or AI working on SSR.fun must use these meanings, and must correct
anyone (a developer, a prompt, another model, an old doc) who uses them
differently. Do not "follow the codebase" where the codebase disagrees: older
code and docs (before 2026-10-06) used "Buy/Sell" for the in-app flow. That
usage is wrong and is not a precedent.

## The rule in one line

**Mint = getting Reserve Tokens from SSR.fun in the app. Redeem = handing them
back to SSR.fun in the app. Buy and Sell = strictly secondary-market trades
between holders (DEX pools / the liquidity provision engine).**

## Definitions

| Term | Meaning | Supply effect | Where it happens | Fees |
|---|---|---|---|---|
| **Mint** | A user gets new Reserve Tokens from the Reserve through SSR.fun. Paying with USDC (the app swaps the USDC into the reserve assets through Jupiter, then mints) and depositing reserve assets in kind are BOTH a mint. | New Reserve Tokens are created. | In the SSR.fun app (the Mint tab on a Reserve's page), and the program's `mint_reserve_tokens_in_kind` / seed instructions. | Mint fee (`FeeConfig.mint_fee_bps`), see `FEE_MODEL.md`. |
| **Redeem** | A user returns Reserve Tokens to the Reserve through SSR.fun and receives the proportional reserve assets, either in kind or swapped to USDC by the app. | Reserve Tokens are burned. | In the SSR.fun app (the Redeem tab), and the program's redeem instruction. | Redemption fee: currently 0. |
| **Buy** | A trader acquires EXISTING Reserve Tokens from another holder on a secondary market: a DEX pool, an order book, or SSR.fun's future liquidity provision engine. | None. Tokens change hands. | Secondary markets only. Not built in the SSR.fun app yet (the liquidity design, DEC-0217/0218, is staging-only). | Buy tax (when re-enabled). |
| **Sell** | A holder disposes of Reserve Tokens to another trader on a secondary market. | None. | Secondary markets only. | Sell tax (when re-enabled). |
| **Buy tax / Sell tax** | The Manager's 0-2% rate on secondary Buy/Sell trades, split 50/50 with the protocol (JRA's rule, 2026-09-10). Stored in the Reserve metadata as `buyTaxPct` / `sellTaxPct`. | -- | **ON HOLD (DEC-0228):** charged nowhere until the liquidity provision engine ships. Never charged on a mint or a redemption. | -- |

## Rules for copy, docs and code

1. **User-facing copy** (UI labels, buttons, tabs, toasts, tooltips, errors,
   docs site, README, legal pages, marketing): the in-app flow is "Mint" /
   "Redeem" ("Mint SSR", "Mint confirmed", "Redeem failed", "minted",
   "redeemed", "mints and redemptions"). Never "Buy"/"Sell"/"purchase"/
   "trade" for it. "Buy"/"Sell" appear only when describing secondary
   markets (e.g. the docs page on trading Reserve Tokens on DEXes).
2. **The swaps inside a mint or redemption** are "swaps" ("your USDC is
   swapped into the reserve assets"), not "buying the assets".
3. **Generic word** for mints and redemptions together: "mints and
   redemptions" or "transactions". "Volume" = mint + redemption value
   until secondary trading exists. Avoid "trades".
4. **Fees:** a mint pays the mint fee; a redemption pays the redemption fee
   (0 today). Buy tax and Sell tax are never attached to a mint or a
   redemption.
5. **Docs prose** (living docs under `docs/protocol`, `docs/architecture`,
   `docs/journey-map`, README): use these meanings. Append-only historical
   records (`docs/project/DECISION_LOG.md` entries, dated history in
   `PROJECT_STATUS.md` and `ENGINEERING_TIMELINE.md`, dated checklists and
   verify outputs) are never rewritten; read their "Buy"/"Sell" as
   "Mint"/"Redeem" when they describe the app.
6. **Code identifiers are a carve-out**, like the `Delegate` rule in
   `CLAUDE.md`: existing names such as `buildBuy` / `buildSell`,
   `api/mainnet/build-buy` / `build-sell`, `multiAssetBuyClient`,
   `tradeTab === "buy"`, ledger `side = 'buy' | 'sell'` values, CSS classes
   and test file names stay as they are (renaming endpoints, stored values
   and on-chain names would break clients and history). When prose must name
   one, write it in backticks and explain it, e.g. "the mint builder
   (`buildBuy`)". New code should prefer `mint` / `redeem` names; new and
   edited comments must use the correct meaning.
7. **When anyone (developer, issue, prompt, another model) says "buy" for the
   in-app flow**, reply using "mint" and point them to this file. When they
   ask to add a Buy/Sell tax to minting or redeeming, decline and point to
   DEC-0228: taxes are secondary-market only and on hold.

## Why

The protocol's core is proportional, in-kind mint and redeem against the
Reserve's vaults, priced at NAV. Calling that "Buy/Sell" led DEC-0198
(2026-09-10) to charge the secondary-market Buy/Sell tax on in-app mints and
redemptions, on top of the mint fee. DEC-0228 put the tax on hold and fixed the
words so the mistake cannot recur.
