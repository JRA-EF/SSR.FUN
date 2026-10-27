// DEC-0267: a failed Jupiter swap leg in a mint or redeem is described as
// Jupiter's error, never ssr_protocol's. Live 2026-10-26: Jupiter's 6001
// (slippage) on a Reserve #61 mint was reported as "SsrError::ZeroValue",
// and a redeem whose route kept failing inside an Invariant pool (SPL Token
// error 1) was told to "try again" for slippage 17 times.
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { describeJupiterSwapError } from "../src/merge/lib/jupiterSwapClient";
import { DEFAULT_EXCLUDED_DEXES } from "../lib/mainnet/jupiter";

describe("swap leg errors", () => {
  it("Jupiter 6001 reads as slippage, not an SSR error", () => {
    const msg = describeJupiterSwapError(JSON.stringify({ InstructionError: [3, { Custom: 6001 }] }));
    expect(msg).to.include("slippage");
    expect(msg).not.to.include("SsrError");
    expect(msg).not.to.include("ZeroValue");
  });

  it("SPL Token error 1 inside a route says a transfer came up short, not slippage", () => {
    const msg = describeJupiterSwapError(JSON.stringify({ InstructionError: [2, { Custom: 1 }] }));
    expect(msg).to.include("insufficient funds");
    expect(msg).to.include("could not pay out");
    expect(msg).not.to.include("slippage");
  });

  it("mint and redeem swap legs use the Jupiter decoder", () => {
    for (const f of ["src/merge/lib/multiAssetBuyClient.ts", "src/merge/lib/multiAssetSellClient.ts"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src, f).to.match(/JupiterSwapNotLandedError\("failed", signature, `\$\{describeJupiterSwapError\(outcome\.error\)\}/);
    }
  });

  it("Invariant is excluded from routes like ZeroFi and Quantum", () => {
    expect(DEFAULT_EXCLUDED_DEXES).to.include.members(["ZeroFi", "Quantum", "Invariant"]);
  });
});
