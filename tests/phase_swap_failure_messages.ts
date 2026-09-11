// Swap failure messages that name the venue, the amount and the asset
// (DEC-0199). Before this, a failed leg read "Jupiter could not build the
// swap for <mint>" -- neither the route nor the size, so a dead venue, an
// excluded DEX and a too-small amount were indistinguishable.
import { expect } from "chai";
import { DEFAULT_EXCLUDED_DEXES, describeRoute, describeSwapFailure, formatUsdcRaw, routeLabelsOf, shortMint, MAINNET_USDC_MINT, type JupiterQuote } from "../lib/mainnet/jupiter";

const ASSET = "HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump";

/** A quote shaped like Jupiter's, carrying a two-hop route. */
function quoteWithRoute(labels: string[]): JupiterQuote {
  return {
    inAmount: "300",
    outAmount: "1000",
    priceImpactPct: "0.01",
    routePlan: labels.map((label) => ({ swapInfo: { label }, percent: 100 })),
  } as unknown as JupiterQuote;
}

describe("route naming", () => {
  it("pulls venue labels out of a quote's routePlan in hop order, de-duplicated, and tolerates a quote with none", () => {
    expect(routeLabelsOf(quoteWithRoute(["Meteora DLMM", "Raydium CLMM"]))).to.deep.equal(["Meteora DLMM", "Raydium CLMM"]);
    expect(routeLabelsOf(quoteWithRoute(["Orca V2", "Orca V2"]))).to.deep.equal(["Orca V2"]);
    expect(routeLabelsOf({ inAmount: "1", outAmount: "1", priceImpactPct: "0" } as JupiterQuote)).to.deep.equal([]);
    expect(routeLabelsOf(null)).to.deep.equal([]);
    expect(routeLabelsOf(undefined)).to.deep.equal([]);
  });
  it("describeRoute joins hops with an arrow; shortMint keeps both ends", () => {
    expect(describeRoute(["Meteora DLMM", "Raydium CLMM"])).to.equal("Meteora DLMM -> Raydium CLMM");
    expect(describeRoute(["Orca V2"])).to.equal("Orca V2");
    expect(describeRoute([])).to.equal("");
    expect(shortMint(ASSET)).to.equal("HgBRWf...HCpump");
    expect(shortMint("SOL")).to.equal("SOL");
  });
  it("formatUsdcRaw shows dust at full precision and real money as money -- never a misleading $0.00", () => {
    expect(formatUsdcRaw(300n)).to.equal("$0.000300");
    expect(formatUsdcRaw(1n)).to.equal("$0.000001");
    expect(formatUsdcRaw(12_500_000n)).to.equal("$12.50");
  });
});

describe("describeSwapFailure", () => {
  it("a BUILD failure names the venue(s), the exact amount, the asset and Jupiter's own words", () => {
    const msg = describeSwapFailure({
      stage: "build",
      inputMint: MAINNET_USDC_MINT,
      outputMint: ASSET,
      amountRaw: 300n,
      quote: quoteWithRoute(["Meteora DLMM", "Raydium CLMM"]),
      message: "Cannot compute other amount threshold",
    });
    expect(msg).to.include("Meteora DLMM -> Raydium CLMM");
    expect(msg).to.include("$0.000300");
    expect(msg).to.include("HgBRWf...HCpump");
    expect(msg).to.include("Cannot compute other amount threshold");
    expect(msg).to.include("Nothing was swapped");
  });
  it("a QUOTE failure says no route was found, and names the venues excluded on purpose so an excluded-DEX case is not mistaken for dead liquidity", () => {
    const msg = describeSwapFailure({ stage: "quote", inputMint: MAINNET_USDC_MINT, outputMint: ASSET, amountRaw: 5_000_000n, message: "No routes found" });
    expect(msg).to.include("no route");
    expect(msg).to.include("$5.00");
    expect(msg).to.include("No routes found");
    for (const dex of DEFAULT_EXCLUDED_DEXES) expect(msg).to.include(dex);
  });
  it("adds the fee reality ONLY for a genuinely dust-sized amount, and never states it as the cause", () => {
    const dust = describeSwapFailure({ stage: "build", inputMint: MAINNET_USDC_MINT, outputMint: ASSET, amountRaw: 300n, quote: quoteWithRoute(["Orca V2"]), message: "x" });
    expect(dust).to.include("smaller than this swap's own network fee");
    const real = describeSwapFailure({ stage: "build", inputMint: MAINNET_USDC_MINT, outputMint: ASSET, amountRaw: 5_000_000n, quote: quoteWithRoute(["Orca V2"]), message: "x" });
    expect(real).to.not.include("network fee");
  });
  it("handles the SELL direction (asset in, USDC out) by naming the asset being sold in raw units", () => {
    const msg = describeSwapFailure({ stage: "quote", inputMint: ASSET, outputMint: MAINNET_USDC_MINT, amountRaw: 4_200n, message: "No routes found" });
    expect(msg).to.include("4200 raw units of HgBRWf...HCpump");
  });
  it("falls back to a truthful phrase when the quote carries no route labels", () => {
    const msg = describeSwapFailure({ stage: "build", inputMint: MAINNET_USDC_MINT, outputMint: ASSET, amountRaw: 5_000_000n, quote: null, message: "upstream 500" });
    expect(msg).to.include("The route Jupiter chose");
    expect(msg).to.not.include("undefined");
  });
});
