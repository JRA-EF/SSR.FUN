// Pure-logic coverage for the Reserve Composition card's per-asset "P&L %"
// column and the Reserve Asset Entry Price Store's request validation --
// the fix for the "P&L is not updating" bug reported live on DELTA
// (mainnet-beta-16): the previous calcReserveAssetPnlPct compared the
// DevNet fixture table against itself, so every Mainnet asset reported a
// structural 0.00% forever. calcAssetPnlPct now compares the asset's live
// price against its server-captured entry price, and returns null (never a
// fabricated 0%) when either side is missing.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_reserve_asset_pnl.ts
import { expect } from "chai";
import { calcAssetPnlPct } from "../src/merge/lib/calculations";
import { TEST_ASSET_PRICES_USD } from "../src/merge/lib/onChainReserve";
import { validateEntryPricePairs, MAX_PAIRS_PER_REQUEST } from "../lib/reserve-entry-price/payload";

const RESERVE = "9oBkwdrTZbuiCcUnJbPSeNMyAfj5DKqY2EHa9HKfE1pK";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("calcAssetPnlPct (src/merge/lib/calculations.ts)", () => {
  it("computes gain and loss against the entry price", () => {
    expect(calcAssetPnlPct(1.1, 1.0)).to.be.closeTo(10, 1e-9);
    expect(calcAssetPnlPct(0.9, 1.0)).to.be.closeTo(-10, 1e-9);
    expect(calcAssetPnlPct(84.41, 84.96)).to.be.closeTo(((84.41 - 84.96) / 84.96) * 100, 1e-9);
  });

  it("returns exactly 0 when the price has not moved since entry", () => {
    expect(calcAssetPnlPct(2.5, 2.5)).to.equal(0);
  });

  it("returns null (never a fabricated 0%) when either side is missing or invalid", () => {
    expect(calcAssetPnlPct(null, 1.0)).to.equal(null);
    expect(calcAssetPnlPct(undefined, 1.0)).to.equal(null);
    expect(calcAssetPnlPct(1.0, null)).to.equal(null);
    expect(calcAssetPnlPct(1.0, undefined)).to.equal(null);
    expect(calcAssetPnlPct(0, 1.0)).to.equal(null);
    expect(calcAssetPnlPct(1.0, 0)).to.equal(null);
    expect(calcAssetPnlPct(-1, 1.0)).to.equal(null);
    expect(calcAssetPnlPct(1.0, Number.NaN)).to.equal(null);
    expect(calcAssetPnlPct(Number.POSITIVE_INFINITY, 1.0)).to.equal(null);
  });

  it("reports 0.00% for every DevNet fixture mint when both sides read the fixed test table (fixture prices never move)", () => {
    for (const mint of Object.keys(TEST_ASSET_PRICES_USD)) {
      expect(calcAssetPnlPct(TEST_ASSET_PRICES_USD[mint], TEST_ASSET_PRICES_USD[mint])).to.equal(0);
    }
  });
});

describe("validateEntryPricePairs (lib/reserve-entry-price/payload.ts)", () => {
  it("accepts a valid pair list and deduplicates repeats", () => {
    const pairs = validateEntryPricePairs([
      { reserve: RESERVE, mint: MINT, decimals: 6 },
      { reserve: RESERVE, mint: MINT, decimals: 6 },
    ]);
    expect(pairs).to.have.length(1);
    expect(pairs[0]).to.deep.equal({ reserve: RESERVE, mint: MINT, decimals: 6 });
  });

  it("rejects an empty, missing, or oversized list", () => {
    expect(() => validateEntryPricePairs(undefined)).to.throw();
    expect(() => validateEntryPricePairs([])).to.throw();
    const oversized = Array.from({ length: MAX_PAIRS_PER_REQUEST + 1 }, () => ({ reserve: RESERVE, mint: MINT, decimals: 6 }));
    expect(() => validateEntryPricePairs(oversized)).to.throw(/too many/i);
  });

  it("rejects malformed addresses, including SQL/URL metacharacters", () => {
    expect(() => validateEntryPricePairs([{ reserve: "not-base58", mint: MINT, decimals: 6 }])).to.throw();
    expect(() => validateEntryPricePairs([{ reserve: RESERVE, mint: "x'; drop table reserve_asset_entry_price; --", decimals: 6 }])).to.throw();
    expect(() => validateEntryPricePairs([{ reserve: `${RESERVE}?x=1`, mint: MINT, decimals: 6 }])).to.throw();
  });

  it("rejects invalid decimals", () => {
    expect(() => validateEntryPricePairs([{ reserve: RESERVE, mint: MINT, decimals: -1 }])).to.throw();
    expect(() => validateEntryPricePairs([{ reserve: RESERVE, mint: MINT, decimals: 2.5 }])).to.throw();
    expect(() => validateEntryPricePairs([{ reserve: RESERVE, mint: MINT, decimals: 19 }])).to.throw();
    expect(() => validateEntryPricePairs([{ reserve: RESERVE, mint: MINT, decimals: "6" }])).to.throw();
  });
});
