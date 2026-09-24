# SSR.fun fee model (Mainnet, as implemented)

The rule, as stated by JRA on 2026-09-10 and adopted:

> Mint fee: we charge 50% of what the managers set the fee to, min 0.5% if they set to lower than 1%.
> Annualized TVL fee: calculated and charged daily, same structure but min is 0.5%.
> Buy/sell tax on secondary markets = 50%, no minimum.

This file records how each line maps onto the deployed program
`8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9` and the app, and where the
numbers live in code. Decision history: DEC-0094/0095 (mint + TVL split),
DEC-0100..0103 (TVL accrual), DEC-0173/0184/0196 (USDC settlement),
DEC-0198 (Buy/Sell tax through SSR.fun, daily TVL cadence).

| Fee | Who sets the rate | Protocol share | Manager share | Charged in | Charged when | Enforced by |
|---|---|---|---|---|---|---|
| Mint fee | Manager, 0-5% at Create (`FeeConfig.mint_fee_bps`) | max(0.5%, rate / 2) | rate - protocol share | Reserve Tokens into the fee vault, swapped to USDC by the keeper | every mint / seed | program (`mint_reserve_tokens_in_kind`, `fee_math::split_configured_bps`) |
| Annualized TVL fee | Manager, 0-10%/yr at Create (`FeeConfig.annual_tvl_fee_bps`) | max(0.5%, rate / 2) | rate - protocol share | same | accrues per full elapsed day; the keeper calls `accrue_fees` for any Reserve 1+ day since its last accrual (daily since DEC-0198, weekly before) | program (`accrue_fees`) + keeper (`api/mainnet/fee-settlement-cron.ts`) |
| Buy tax | Manager, 0-2% at Create (metadata `buyTaxPct`) | 50% of the tax | 50% of the tax | USDC, paid by the buyer on top of the purchase | inside SSR.fun's Buy: the mint transaction carries the transfers | app only (`lib/mainnet/buildBuy.ts` + `lib/mainnet/tradeTax.ts`) |
| Sell tax | Manager, 0-2% at Create (metadata `sellTaxPct`) | 50% of the tax | 50% of the tax | USDC, out of the seller's proceeds | inside SSR.fun's Sell: folded into the single transaction, or a final `tax` transaction after every swap lands | app only (`lib/mainnet/buildSell.ts` + `lib/mainnet/tradeTax.ts`) |
| Redemption fee | constant 0 (`DEFAULT_REDEMPTION_FEE_BPS`) | -- | -- | -- | not charged in v1 | -- |

## The 0.5% floor

`protocol_bps = max(PROTOCOL_MIN_*_FEE_BPS, configured_bps / 2)`,
`manager_bps = configured_bps - protocol_bps` (never below 0). A configured
0% is a true 0% for both sides (DEC-0095). A configured rate below 0.5% but
above 0 gives the manager 0% and the trader pays the protocol's 0.5% floor.
Constants: `programs/ssr_protocol/src/constants.rs`
(`PROTOCOL_MIN_MINT_FEE_BPS = 50`, `PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS = 50`,
caps `MAX_MINT_FEE_BPS = 500`, `MAX_ANNUAL_TVL_FEE_BPS = 1000`).

## `ProtocolConfig.default_protocol_fee_bps` is inert

The field exists (written by `initialize_protocol` / `update_protocol_config`,
currently 0) but no instruction reads it. It is not a protocol-wide default
for anything. `ProtocolConfig.default_protocol_fee_destination` DOES matter:
`collect_fees`, `collect_protocol_fee` and `distribute_fee_usdc` refuse any
other recipient, which is how the protocol share lands in the Treasury vault
`3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5`.

## Buy/Sell tax details (DEC-0198)

- Rate source: the Reserve's `metadata_uri` JSON (`buyTaxPct` / `sellTaxPct`,
  the Create Reserve sliders). Resolved server-side from this app's metadata
  store by id, else an HTTPS fetch; any failure means no tax for that build,
  never a blocked trade. Existing Reserves with a non-zero slider value start
  charging with this deploy.
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
- Not covered: plain wallet transfers and trades on any other venue. The
  Reserve Token is a plain SPL token (no Token-2022 transfer fee, by the
  original design decision). A transfer-fee mint would tax every transfer at
  one rate and only for Reserves created after a program upgrade; parked.

## Where the USDC ends up

Mint and TVL fees crystallize as Reserve Tokens in the fee vault; the hourly
keeper (`fee-settlement-cron`, keeper wallet
`AuaJRdbRZhhfdqpyjN8uNYSnggRwLY8kzHVjngkGPhsF`) redeems, swaps to USDC and
distributes per `FeeSettlement` (see `FEE_SETTLEMENT_RUNBOOK.md`). Buy/Sell
tax is already USDC and goes straight to the two destinations in the trader's
own transaction; no keeper step.
