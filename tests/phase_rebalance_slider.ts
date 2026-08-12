// Pure-logic regression coverage for the redesigned Manage Reserve ->
// Portfolio Rebalance tab's devUSDC-priority cash-bucket slider model
// (DEC-0084). Covers applySliderWeightChange only -- no wallet/RPC/program
// involvement, consistent with this repo's offline pure-function test
// convention (see tests/phase_rebalance_execution.ts for the same pattern).
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_rebalance_slider.ts
import { expect } from "chai";
import { applySliderWeightChange, type SliderAsset } from "../src/merge/lib/rebalanceSlider";

const DEVUSDC = "DevUsdc1111111111111111111111111111111111";
const MINT_X = "MintX111111111111111111111111111111111111";
const MINT_Y = "MintY111111111111111111111111111111111111";
const MINT_Z = "MintZ111111111111111111111111111111111111";

function sum(assets: SliderAsset[]): number {
  return assets.reduce((s, a) => s + a.weightBps, 0);
}

function find(assets: SliderAsset[], mint: string): number {
  return assets.find((a) => a.mint === mint)!.weightBps;
}

describe("applySliderWeightChange (src/merge/lib/rebalanceSlider.ts)", () => {
  it("decreasing a non-devUSDC asset moves the freed bps 1:1 into devUSDC", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 2000 },
      { mint: MINT_X, weightBps: 5000 },
      { mint: MINT_Y, weightBps: 3000 },
    ];
    const result = applySliderWeightChange(assets, MINT_X, 3000, DEVUSDC);
    expect(find(result, MINT_X)).to.equal(3000);
    expect(find(result, DEVUSDC)).to.equal(4000); // 2000 + 2000 freed
    expect(find(result, MINT_Y)).to.equal(3000); // untouched
    expect(sum(result)).to.equal(10_000);
  });

  it("increasing a non-devUSDC asset draws from devUSDC first, before touching any other asset", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 4000 },
      { mint: MINT_X, weightBps: 3000 },
      { mint: MINT_Y, weightBps: 3000 },
    ];
    const result = applySliderWeightChange(assets, MINT_X, 5000, DEVUSDC);
    expect(find(result, MINT_X)).to.equal(5000);
    expect(find(result, DEVUSDC)).to.equal(2000); // 4000 - 2000 drawn
    expect(find(result, MINT_Y)).to.equal(3000); // untouched -- devUSDC alone covered the need
    expect(sum(result)).to.equal(10_000);
  });

  it("increasing beyond devUSDC's available weight pulls the remainder proportionally from other assets", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 1000 },
      { mint: MINT_X, weightBps: 3000 },
      { mint: MINT_Y, weightBps: 4500 },
      { mint: MINT_Z, weightBps: 1500 },
    ];
    // Need 4000 total for MINT_X to go from 3000 -> 7000. devUSDC covers
    // 1000, leaving 3000 to pull proportionally from MINT_Y (4500) and
    // MINT_Z (1500), a 3:1 split of the remaining 6000 pool.
    const result = applySliderWeightChange(assets, MINT_X, 7000, DEVUSDC);
    expect(find(result, MINT_X)).to.equal(7000);
    expect(find(result, DEVUSDC)).to.equal(0);
    expect(find(result, MINT_Y)).to.equal(4500 - 2250); // 3/4 of the 3000 needed
    expect(find(result, MINT_Z)).to.equal(1500 - 750); // 1/4 of the 3000 needed
    expect(sum(result)).to.equal(10_000);
  });

  it("distributes proportionally, splitting equally when all other assets are currently zero", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 10_000 },
      { mint: MINT_X, weightBps: 0 },
      { mint: MINT_Y, weightBps: 0 },
    ];
    // Decreasing devUSDC by 2000 with both other assets at 0 -> equal split.
    const result = applySliderWeightChange(assets, DEVUSDC, 8000, DEVUSDC);
    expect(find(result, DEVUSDC)).to.equal(8000);
    expect(find(result, MINT_X)).to.equal(1000);
    expect(find(result, MINT_Y)).to.equal(1000);
    expect(sum(result)).to.equal(10_000);
  });

  it("decreasing devUSDC directly redistributes proportionally across non-devUSDC assets", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 4000 },
      { mint: MINT_X, weightBps: 4500 },
      { mint: MINT_Y, weightBps: 1500 },
    ];
    const result = applySliderWeightChange(assets, DEVUSDC, 2000, DEVUSDC);
    expect(find(result, DEVUSDC)).to.equal(2000);
    // 2000 freed, split 3:1 by MINT_X/MINT_Y's current 4500:1500 share.
    expect(find(result, MINT_X)).to.equal(4500 + 1500);
    expect(find(result, MINT_Y)).to.equal(1500 + 500);
    expect(sum(result)).to.equal(10_000);
  });

  it("increasing devUSDC directly pulls proportionally from non-devUSDC assets", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 2000 },
      { mint: MINT_X, weightBps: 6000 },
      { mint: MINT_Y, weightBps: 2000 },
    ];
    const result = applySliderWeightChange(assets, DEVUSDC, 4000, DEVUSDC);
    expect(find(result, DEVUSDC)).to.equal(4000);
    // 2000 pulled, split 3:1 by MINT_X/MINT_Y's current 6000:2000 share.
    expect(find(result, MINT_X)).to.equal(6000 - 1500);
    expect(find(result, MINT_Y)).to.equal(2000 - 500);
    expect(sum(result)).to.equal(10_000);
  });

  it("setting one asset to 100% drives every other asset, including devUSDC, to exactly 0", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 1000 },
      { mint: MINT_X, weightBps: 3000 },
      { mint: MINT_Y, weightBps: 4000 },
      { mint: MINT_Z, weightBps: 2000 },
    ];
    const result = applySliderWeightChange(assets, MINT_Y, 10_000, DEVUSDC);
    expect(find(result, MINT_Y)).to.equal(10_000);
    expect(find(result, DEVUSDC)).to.equal(0);
    expect(find(result, MINT_X)).to.equal(0);
    expect(find(result, MINT_Z)).to.equal(0);
    expect(sum(result)).to.equal(10_000);
  });

  it("setting devUSDC itself to 100% drives every other asset to exactly 0", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 2500 },
      { mint: MINT_X, weightBps: 2500 },
      { mint: MINT_Y, weightBps: 2500 },
      { mint: MINT_Z, weightBps: 2500 },
    ];
    const result = applySliderWeightChange(assets, DEVUSDC, 10_000, DEVUSDC);
    expect(find(result, DEVUSDC)).to.equal(10_000);
    expect(find(result, MINT_X)).to.equal(0);
    expect(find(result, MINT_Y)).to.equal(0);
    expect(find(result, MINT_Z)).to.equal(0);
    expect(sum(result)).to.equal(10_000);
  });

  it("always sums to exactly 10000 bps after an edit, even with an odd 3-way proportional split (rounding)", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 0 },
      { mint: MINT_X, weightBps: 3334 },
      { mint: MINT_Y, weightBps: 3333 },
      { mint: MINT_Z, weightBps: 3333 },
    ];
    // Increasing MINT_X forces a proportional pull across MINT_Y/MINT_Z
    // (devUSDC has nothing to give), an uneven split that would otherwise
    // leave rounding dust.
    const result = applySliderWeightChange(assets, MINT_X, 4001, DEVUSDC);
    expect(find(result, MINT_X)).to.equal(4001);
    expect(sum(result)).to.equal(10_000);
  });

  it("falls back to plain symmetric proportional distribute/pull when devUsdcMint is not present in assets", () => {
    const assets: SliderAsset[] = [
      { mint: MINT_X, weightBps: 6000 },
      { mint: MINT_Y, weightBps: 4000 },
    ];
    const result = applySliderWeightChange(assets, MINT_X, 8000, "SomeMintNotInComposition11111111111111111");
    expect(find(result, MINT_X)).to.equal(8000);
    expect(find(result, MINT_Y)).to.equal(2000);
    expect(sum(result)).to.equal(10_000);
  });

  it("is a no-op that returns the same reference when the edited weight is unchanged", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 4000 },
      { mint: MINT_X, weightBps: 6000 },
    ];
    const result = applySliderWeightChange(assets, MINT_X, 6000, DEVUSDC);
    expect(result).to.equal(assets);
  });

  it("is a pure function -- never mutates the input array or its elements", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 2000 },
      { mint: MINT_X, weightBps: 5000 },
      { mint: MINT_Y, weightBps: 3000 },
    ];
    const snapshot = assets.map((a) => ({ ...a }));
    applySliderWeightChange(assets, MINT_X, 1000, DEVUSDC);
    expect(assets).to.deep.equal(snapshot);
  });

  it("returns the same array unchanged when the edited mint is not found in the composition", () => {
    const assets: SliderAsset[] = [
      { mint: DEVUSDC, weightBps: 4000 },
      { mint: MINT_X, weightBps: 6000 },
    ];
    const result = applySliderWeightChange(assets, "NotInComposition11111111111111111111111111", 5000, DEVUSDC);
    expect(result).to.equal(assets);
  });
});
