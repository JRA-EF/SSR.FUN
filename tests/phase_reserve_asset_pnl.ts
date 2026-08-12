// Pure-logic coverage for the Reserve Composition card's new "P&L %" column
// (asset-level P&L for a Reserve's own underlying holding, distinct from
// calcUnrealizedPnlPct's user-position P&L). See calculations.ts's header
// comment on calcReserveAssetPnlPct for why 0.00% is the correct answer
// today, not a placeholder: TEST_ASSET_PRICES_USD has exactly one fixed
// price per mint in this DevNet environment, so referenceAssetPriceUsd and
// the current price are, for now, the same source.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_reserve_asset_pnl.ts
import { expect } from "chai";
import { calcReserveAssetPnlPct, referenceAssetPriceUsd } from "../src/merge/lib/calculations";
import { TEST_ASSET_PRICES_USD } from "../src/merge/lib/onChainReserve";

describe("calcReserveAssetPnlPct / referenceAssetPriceUsd (src/merge/lib/calculations.ts)", () => {
  it("returns exactly 0.00% for a known mint -- reference and current price are the same fixed table today", () => {
    const [mint] = Object.keys(TEST_ASSET_PRICES_USD);
    expect(referenceAssetPriceUsd(mint)).to.equal(TEST_ASSET_PRICES_USD[mint]);
    expect(calcReserveAssetPnlPct(mint)).to.equal(0);
  });

  it("returns 0 (not NaN/Infinity) for a mint with no known price", () => {
    expect(referenceAssetPriceUsd("NotARealMint1111111111111111111111111111")).to.equal(0);
    expect(calcReserveAssetPnlPct("NotARealMint1111111111111111111111111111")).to.equal(0);
  });

  it("is consistent across every currently-known test asset mint", () => {
    for (const mint of Object.keys(TEST_ASSET_PRICES_USD)) {
      expect(calcReserveAssetPnlPct(mint)).to.equal(0);
    }
  });
});
