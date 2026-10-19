# SSR.fun fee model (DEC-0240, live; DEC-0251 liquidity terms v2)

> **DEC-0251 (2026-10-19, Creator ruling):** pools created after the DEC-0251 program upgrade use **liquidity terms v2**: SSR takes 20% of everything the creator earns from the pool (collected creator fee and Buy/Sell tax), and the creator may share part of the remaining 80% with holders, chosen once at launch. See "Liquidity terms v2" below. The two pool rows in the table describe pools created before that upgrade, which keep their recorded terms.

The Creator's 2026-10-13 ruling (DEC-0240) adopts the secondary-market part of Yeh's DEC-0232 model and keeps primary mint/redeem fees as they were live. Mint fees are paid in USDC at mint time (DEC-0238).

| Revenue | SSR receives | Creator receives | Scope |
|---|---|---|---|
| Mint, including initial seed | Configured 0%: nothing. Otherwise max(0.5%, half the configured fee), paid in USDC in the mint transaction (DEC-0238) | Configured fee minus SSR share, floored at zero, in USDC | Primary issuance |
| Redeem | Protocol share of exactly the configured fee (never raised by a floor) | Remainder of the configured fee | Primary redemption |
| Annualized TVL | Existing split; zero configuration remains zero | Existing split | Unchanged |
| Token-2022 transfer fee | 100% of existing 0.15% fee (admin ceiling 0.25%) | None | All transfers, every venue |
| SSR-created canonical pool | 0.05% equivalent of native creator-fee base, carved from the 0.75% bucket | Native creator earnings after Raydium retention and SSR share | All swaps in that pool, including external interfaces |
| Optional project tax | 25% of tax, no minimum | 75% of tax | Set by the Manager in the liquidity launch on Manage Reserve; SSR secondary swap wrapper only; zero tax means zero tax revenue |

DEC-0232's unconditional 0.5% minimum on mint and redemption (including configured zero) was NOT adopted.

## Native pool fee routing

Raydium config 9 charges 0.25% trade plus 0.75% native creator fees, collected in USDC only. Its currently observed default retention is 5% of creator fees, leaving 0.7125%. The pool creator is the per-Reserve `liquidity_revenue` PDA, never the creator's ordinary wallet. After collection, the router distributes net USDC in the ratio `500 * 1e6 / (7500 * (1e6 - retainedRate))` to SSR and the remainder to the fixed creator treasury. At 5% retention this is 4/57 of net USDC: SSR 0.05%, creator 0.6625%, Raydium retention 0.0375%, before the separate 0.25% trade fee.

The equivalence is to Raydium's native creator-fee base, not necessarily gross wallet turnover: USDC input/output fee bases and integer rounding differ. The token transfer fee is withheld in Reserve Tokens, so it must not be reported as USDC cash revenue without valuation/settlement. Do not add these rates and promise an exact all-in percentage on every trade.

Raydium's direct permissionless collect can only fund the router ATA. It cannot send fees to the creator directly. The splitter uses the registered retention rate and carries fractional USDC remainders across collections. Config/override changes fail closed; pending balances must be reconciled before any future retention migration. No mutable treasury or retention migration instruction is provided. Protocol treasury follows the existing ProtocolConfig destination. LP ownership and LP fees stay separate.

## Optional secondary project tax

A new on-chain swap wrapper invokes Raydium atomically. Buy tax is charged on gross USDC input; the remaining input is swapped. Sell tax is charged on actual USDC received. The final minimum output is checked after project tax and token transfer fees; failure rolls back everything. Rates are configured on-chain at registration, 0-2% per side, and split 25/75 in USDC. Tiny taxes round upward; SSR receives allocation dust. No per-trade caller may override the rate or treasury. Direct external swaps can bypass this optional tax, but cannot bypass the token-level transfer fee or redirect native fees from SSR-created pools.

## Liquidity terms v2 (DEC-0251)

| Revenue | SSR receives | Creator receives | Holders receive |
|---|---|---|---|
| Collected creator fee (Raydium's 0.75% after its own retention) | 20% (fractional remainders carried across collections) | 80% minus the holder share | Holder share of the 80% (0-100%, fixed at launch, default 0) |
| Optional Buy/Sell tax (0-2% per side, set with sliders in the liquidity launch) | 20% (rounding dust to SSR) | 80% minus the holder share | Holder share of the 80% |

- **Where it is recorded:** `configure_liquidity_revenue_v2` writes the taxes and the holder share into the pool's `LiquidityRevenue` + `LiquidityTerms` accounts when the pool is created. No instruction changes them afterwards. v1 `configure_liquidity_revenue` now refuses (`LiquidityTermsV2Required`), so every new pool is v2.
- **Holder share ("feed the basket"):** paid in USDC to the basket feed (the `LiquidityTerms` PDA's USDC ATA). The program releases it linearly over 24 hours (a new deposit spreads together with whatever is still locked over a fresh 24 hours). Each hour the keeper (fee-settlement-cron job D) collects the pool's creator fees, then splits the released USDC across the Reserve's assets by target weight and runs one atomic transaction per asset: `basket_feed_begin` (keeper-signed; lends the released USDC) -> Jupiter route -> `rebalance_swap_end` (deposits what arrived into the vault, refusing below the quoted minimum). A USDC asset needs no route. Nothing is minted, and mint/redeem price every token from live vault balances, so the backing behind every Reserve Token grows. This mirrors MAG7's "fees go back into the basket" on Robinhood Chain.
- **Rounding:** SSR's 20% of collected fees carries remainders like v1; the holder part rounds down in the creator's favour; tax total rounds up as in v1.
- **Unchanged:** the 0.15% transfer fee (100% SSR), mint/redeem/TVL fees, the 0.25% pool trade fee.

## Deployment

The liquidity instructions ship in the same program upgrade as DEC-0238's successors (see PROJECT_STATUS for slot and deployment). Pool creation is co-signed by the Raydium-approved payer `6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS`; all initial LP ends in the creator treasury (`finalize_liquidity_pool`).

## `ProtocolConfig.default_protocol_fee_bps` is inert

The field exists (written by `initialize_protocol` / `update_protocol_config`,
currently 0) but no instruction reads it. It is not a protocol-wide default
for anything. `ProtocolConfig.default_protocol_fee_destination` DOES matter:
`collect_fees`, `collect_protocol_fee` and `distribute_fee_usdc` refuse any
other recipient, which is how the protocol share lands in the Treasury vault
`3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5`.

## Historical tax removal — superseded for SSR-routed DEX swaps by DEC-0240

DEC-0229 removed the Buy/Sell tax entirely (Create Reserve sliders, metadata
fields for new payloads, the build-buy/build-sell lookups, and then the tax
code itself: `lib/mainnet/tradeTax.ts`, `lib/mainnet/tradeTaxHold.ts`, the
builders' tax options and `tax` transaction kind, and the client's tax step)
and replaced it with the protocol transfer fee in the table above. The history below is kept for
context.


From 2026-09-10 (DEC-0198) to 2026-10-06 the app charged the Buy tax inside
its in-app mint transaction and the Sell tax inside its redemption, because
the app then labelled those flows "Buy" and "Sell". That double-charged
minters (mint fee plus Buy tax) and contradicted the rule, which puts the tax
on secondary markets. DEC-0228 stopped it: a `TRADE_TAX_ON_HOLD`
flag kept `api/mainnet/build-buy.ts` / `build-sell.ts` from resolving any rate, so
the mint builder (`buildBuy`) and the redeem builder (`buildSell`) added no
tax, and the Reserve page's Mint and Redeem panels stopped showing a tax row. The Create Reserve sliders still record
`buyTaxPct` / `sellTaxPct` in the metadata for later.

The tax returns only with the liquidity provision engine, on secondary
Buy/Sell trades, by a new decision. Open question carried over from DEC-0221:
whether the Manager's half should follow the on-chain ManagerFeeRecipients
split (the removed code paid the primary fee destination only).

### Removed implementation (DEC-0198, history only)

The mechanics below describe the code that lived in `lib/mainnet/tradeTax.ts`
until it was deleted after DEC-0229 (it is in git history). Where they say
"Buy"/"Sell" they mean the in-app mint and redemption it was wrongly attached to.


- Rate source: the Reserve's `metadata_uri` JSON (`buyTaxPct` / `sellTaxPct`,
  the Create Reserve sliders). Resolved server-side from this app's metadata
  store by id, else an HTTPS fetch; any failure means no tax for that build,
  never a blocked trade. Existing Reserves with a non-zero slider value start
  charging with this deploy. (Historical: superseded by the hold.)
- Buy base: the purchase's full USDC value (every leg's required deposit at
  its price), falling back to the USDC the plan spends when a price is
  unknown. The wallet must cover purchase + tax or the build refuses (422).
- Sell base: each swap's minimum out at the sale's slippage (not the
  optimistic quote, so the transfer can never exceed what arrives) plus the
  USDC leg's entitlement when the redeem is part of the build.
- Split: `tax = floor(base x bps / 10_000)`, protocol `floor(tax / 2)`,
  manager the remainder. No minimum. Protocol -> Treasury vault USDC ATA
  (off-curve), manager -> `FeeConfig.fee_destination`'s USDC ATA (created
  idempotently, rent paid by the trader). Not routed through the on-chain
  ManagerFeeRecipients split; a manager with several recipients receives the
  tax at the primary fee destination.
- Swaps-only rebuilds (`legsOnly`) never carry the tax. A Sell whose `tax`
  transaction expires after the swaps landed is rebuilt once (`taxOnly` on the
  same persisted base) and re-signed. A tax that fails on-chain is logged and
  does not undo the sale.
- Not covered (at the time): plain wallet transfers and trades on any other
  venue. DEC-0229 adopted the Token-2022 transfer fee for Reserves created
  after it, which does cover them, at one rate, for new Reserves only.

## Where the USDC ends up

Mint and TVL fees crystallize as Reserve Tokens in the fee vault; the hourly
keeper (`fee-settlement-cron`, keeper wallet
`AuaJRdbRZhhfdqpyjN8uNYSnggRwLY8kzHVjngkGPhsF`) redeems, swaps to USDC and
distributes per `FeeSettlement` (see `FEE_SETTLEMENT_RUNBOOK.md`). The Buy/Sell
tax, when it returns for secondary trades, is already USDC and goes straight to
the two destinations in the trader's own transaction; no keeper step. Nothing
is charged while it is on hold.
