// DEC-0228 (2026-10-06): the Manager's Buy tax and Sell tax are ON HOLD.
//
// Terminology (docs/protocol/TERMINOLOGY.md, mandatory): getting Reserve
// Tokens from SSR.fun in the app is a MINT and handing them back is a REDEEM.
// "Buy" and "Sell" are strictly secondary-market trades between holders (DEX
// pools / the liquidity provision engine, not built yet). The Buy/Sell tax is
// a secondary-market tax, so it must never be charged on a mint or a
// redemption. DEC-0198 (2026-09-10) charged it inside SSR.fun's mint and
// redeem transactions because the app called them "Buy" and "Sell"; that is
// what this flag switches off.
//
// While true, api/mainnet/build-buy.ts and build-sell.ts do not resolve any
// tax rate, so the mint and redeem builders charge no tax. The tax code in
// tradeTax.ts stays in place for the liquidity provision engine. The Reserve
// page's Mint and Redeem panels no longer show any Buy/Sell tax at all.
// tests/phase_terminology_and_tax_hold.ts pins all of this. Re-enabling is a
// new decision (for secondary-market trades only), not a flag flip.
export const TRADE_TAX_ON_HOLD = true as const;
