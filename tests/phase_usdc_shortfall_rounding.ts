import { expect } from "chai";
import { usdcCentsText } from "../src/merge/lib/multiAssetBuyPlan";

// Ops alert 2026-11-18: "holds 2.90 USDC but this mint needs ~2.90 USDC -- 0.00 USDC short".
describe("USDC shortfall text rounding", () => {
  it("rounds held down and needed/short up, so a real gap never reads 0.00", () => {
    expect(usdcCentsText(2_904_999n, "down")).to.equal("2.90");
    expect(usdcCentsText(2_900_001n, "up")).to.equal("2.91");
    expect(usdcCentsText(1n, "up")).to.equal("0.01");
    expect(usdcCentsText(5_000_000n, "up")).to.equal("5.00");
    expect(usdcCentsText(0n, "down")).to.equal("0.00");
  });
});
