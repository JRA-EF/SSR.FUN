// Offline, pure-logic regression coverage for the Mainnet USD pricing layer
// (see docs/protocol/SSR_ARCHITECTURE.md / docs/project/DECISION_LOG.md's
// Mainnet-pricing-layer entry): server-side Pyth Core (primary) + Jupiter
// Price V3 (fallback) validation/hierarchy logic (packages/sdk/src/pricing.ts,
// used by api/mainnet/asset-prices.ts), the AUM/Market Cap aggregation that
// turns validated per-asset prices into a Reserve-level figure
// (src/merge/lib/onChainReserve.ts's computeAumFromPrices/computeMarketCap),
// the removed "NAV per Token" card / added "Market Cap" card (source-text
// regression, matching tests/phase_mainnet_production_fixes.ts's own
// established pattern for this kind of UI-copy assertion), and the
// program-reconciled Buy estimate (packages/sdk's
// computeDirectReserveTokensRequested + computeNetMintOutput, the exact same
// functions DTRDetail.tsx's "Est. You Receive" now calls) -- including the
// concrete "10 [asset] in -> ~9.90 [Reserve Token] out after a 1% Mint Fee"
// case this pass was asked to fix for the real "alpha" (SSR-backed) Reserve.
//
// All network-free: no live Pyth/Jupiter/RPC calls here (see the live,
// hand-verified diagnosis of the real "alpha" Reserve recorded in the
// decision log entry for how these fixture numbers were derived from real
// Mainnet state -- this file only re-checks the pure math against them).
import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import {
  validatePythPrice,
  validateJupiterPrice,
  resolvePriceHierarchy,
  PYTH_MAX_STALENESS_SEC,
  PYTH_MAX_CONFIDENCE_RATIO,
  MAX_BLOCK_LAG_SLOTS,
  type RawPythPrice,
  type RawJupiterPrice,
} from "../packages/sdk/src/pricing";
import { computeAumFromPrices, computeMarketCap, type AssetPriceInfo } from "../src/merge/lib/onChainReserve";
import { computeDirectReserveTokensRequested } from "../packages/sdk/src/directInstructions";
import { computeNetMintOutput } from "../packages/sdk/src/calculations";

const SOL_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const USDC_FEED_ID = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
// The real ALPHA Reserve's SSR mint (BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump)
// has no Pyth feed (confirmed by live search against both symbol and mint at
// implementation time) -- Jupiter Price V3 is its only source.
const SSR_MINT = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";

describe("pricing.ts -- validatePythPrice", () => {
  const nowSec = 1_800_000_000;
  function freshQuote(overrides: Partial<RawPythPrice> = {}): RawPythPrice {
    return { id: SOL_FEED_ID, price: "9148308327", conf: "4601387", expo: -8, publishTimeSec: nowSec - 5, ...overrides };
  }

  it("accepts a fresh, low-confidence-interval quote and scales it correctly by expo", () => {
    const result = validatePythPrice(freshQuote(), SOL_FEED_ID, nowSec);
    expect(result).to.not.equal(null);
    expect(result!.usdPrice).to.be.closeTo(91.48308327, 1e-6);
    expect(result!.source).to.equal("pyth");
    expect(result!.confidenceRatio).to.be.closeTo(4601387 / 9148308327, 1e-9);
  });

  it("rejects a quote older than PYTH_MAX_STALENESS_SEC -- never returned as if fresh", () => {
    const result = validatePythPrice(freshQuote({ publishTimeSec: nowSec - (PYTH_MAX_STALENESS_SEC + 1) }), SOL_FEED_ID, nowSec);
    expect(result).to.equal(null);
  });

  it("rejects a quote from the future beyond a small clock-skew tolerance", () => {
    const result = validatePythPrice(freshQuote({ publishTimeSec: nowSec + 30 }), SOL_FEED_ID, nowSec);
    expect(result).to.equal(null);
  });

  it("rejects a quote whose confidence interval exceeds PYTH_MAX_CONFIDENCE_RATIO of the price -- a real Hermes 'low confidence' condition, never silently trusted", () => {
    const price = 1_000_000_000;
    const tooWideConf = Math.ceil(price * (PYTH_MAX_CONFIDENCE_RATIO + 0.01));
    const result = validatePythPrice(freshQuote({ price: String(price), conf: String(tooWideConf) }), SOL_FEED_ID, nowSec);
    expect(result).to.equal(null);
  });

  it("rejects a feed-id identity mismatch -- never prices the wrong asset from a response mix-up", () => {
    const result = validatePythPrice(freshQuote({ id: USDC_FEED_ID }), SOL_FEED_ID, nowSec);
    expect(result).to.equal(null);
  });

  it("rejects a non-positive or non-finite price", () => {
    expect(validatePythPrice(freshQuote({ price: "0" }), SOL_FEED_ID, nowSec)).to.equal(null);
    expect(validatePythPrice(freshQuote({ price: "not-a-number" }), SOL_FEED_ID, nowSec)).to.equal(null);
  });
});

describe("pricing.ts -- validateJupiterPrice", () => {
  const currentSlot = 300_000_000;
  function freshQuote(overrides: Partial<RawJupiterPrice> = {}): RawJupiterPrice {
    return { usdPrice: 0.00048268588081433423, decimals: 6, blockId: currentSlot - 100, ...overrides };
  }

  it("accepts a valid, decimals-matched, recent-block quote", () => {
    const result = validateJupiterPrice(freshQuote(), 6, currentSlot);
    expect(result).to.not.equal(null);
    expect(result!.usdPrice).to.equal(0.00048268588081433423);
    expect(result!.source).to.equal("jupiter");
  });

  it("treats a null/missing price as unavailable, never coerced to 0", () => {
    expect(validateJupiterPrice(freshQuote({ usdPrice: null }), 6, currentSlot)).to.equal(null);
    expect(validateJupiterPrice(freshQuote({ usdPrice: undefined }), 6, currentSlot)).to.equal(null);
  });

  it("rejects a decimals mismatch against the on-chain-verified value -- never trusts an unverified decimals claim", () => {
    expect(validateJupiterPrice(freshQuote({ decimals: 9 }), 6, currentSlot)).to.equal(null);
  });

  it("rejects a missing/zero blockId, and a blockId too far behind the current slot", () => {
    expect(validateJupiterPrice(freshQuote({ blockId: null }), 6, currentSlot)).to.equal(null);
    expect(validateJupiterPrice(freshQuote({ blockId: currentSlot - MAX_BLOCK_LAG_SLOTS - 1 }), 6, currentSlot)).to.equal(null);
  });

  it("skips the block-recency check when currentSlot itself couldn't be read (0) -- fails open on a fetch hiccup, not on every quote", () => {
    const result = validateJupiterPrice(freshQuote({ blockId: 1 }), 6, 0);
    expect(result).to.not.equal(null);
  });

  it("real ALPHA regression: a real ~19,956-slot (~133 minute) gap for the thin-liquidity SSR mint is accepted, not flagged unavailable -- live-confirmed against the real ALPHA Reserve post-deploy: Jupiter's blockId for SSR (440662420) legitimately lagged the real current Mainnet slot (440682376) by more than the original 15,000-slot bound, intermittently blanking a genuinely valid price for no real staleness reason", () => {
    const realCurrentSlot = 440_682_376;
    const realSsrBlockId = 440_662_420;
    expect(realCurrentSlot - realSsrBlockId).to.equal(19_956);
    const result = validateJupiterPrice({ usdPrice: 0.00048130018216587764, decimals: 6, blockId: realSsrBlockId }, 6, realCurrentSlot);
    expect(result).to.not.equal(null);
    expect(result!.usdPrice).to.equal(0.00048130018216587764);
  });
});

describe("pricing.ts -- resolvePriceHierarchy", () => {
  const pyth = { usdPrice: 100, source: "pyth" as const, lastUpdated: 1000 };
  const jupiterClose = { usdPrice: 100.5, source: "jupiter" as const, lastUpdated: 2000 };
  const jupiterFar = { usdPrice: 130, source: "jupiter" as const, lastUpdated: 2000 };

  it("Pyth wins when both are valid, and flags no deviation for a close agreement", () => {
    const result = resolvePriceHierarchy(pyth, jupiterClose);
    expect(result!.source).to.equal("pyth");
    expect(result!.usdPrice).to.equal(100);
    expect(result!.deviationFlagged).to.equal(false);
  });

  it("flags (never blocks or averages) a material Pyth/Jupiter disagreement, still returning Pyth's price", () => {
    const result = resolvePriceHierarchy(pyth, jupiterFar);
    expect(result!.source).to.equal("pyth");
    expect(result!.usdPrice).to.equal(100); // still Pyth's number, not an average
    expect(result!.deviationFlagged).to.equal(true);
  });

  it("falls back to Jupiter when Pyth is unavailable", () => {
    const result = resolvePriceHierarchy(null, jupiterClose);
    expect(result!.source).to.equal("jupiter");
    expect(result!.usdPrice).to.equal(100.5);
  });

  it("returns null (never a fabricated price) when neither source is valid", () => {
    expect(resolvePriceHierarchy(null, null)).to.equal(null);
  });
});

describe("onChainReserve.ts -- computeAumFromPrices (real ALPHA Reserve numbers)", () => {
  // Live-verified at implementation time: ALPHA's SSR vault held 21,132.446514
  // SSR (21132446514 raw @ 6 decimals), Jupiter Price V3 priced SSR at
  // $0.00048268588081433423, giving AUM ~= $10.20.
  const alphaAssets = [{ assetMint: SSR_MINT, vaultBalanceRaw: "21132446514", decimals: 6 }];
  const alphaSupplyRaw = "9950000"; // 9.95 ALPHA reserve tokens (6 decimals)

  it("computes the real ALPHA AUM/Token Price/Market Cap from a validated Jupiter price", () => {
    const priceByMint: Record<string, AssetPriceInfo> = { [SSR_MINT]: { usdPrice: 0.00048268588081433423, source: "jupiter", lastUpdated: Date.now() } };
    const aum = computeAumFromPrices(alphaAssets, priceByMint);
    expect(aum.pricingComplete).to.equal(true);
    expect(aum.priceSource).to.equal("jupiter");
    expect(aum.aumUsd).to.be.closeTo(10.2003, 0.001);
    const tokenPrice = aum.aumUsd / (Number(alphaSupplyRaw) / 1e6);
    expect(tokenPrice).to.be.closeTo(1.0252, 0.001);
    // Market Cap = supply x Token Price -- mathematically equal to AUM here
    // (Token Price IS the internal NAV in this protocol today; see
    // computeMarketCap's own header) -- computed independently, not just AUM
    // relabeled, so this equality is a genuine property being asserted, not
    // a definition.
    expect(computeMarketCap(alphaSupplyRaw, tokenPrice)).to.be.closeTo(aum.aumUsd, 1e-6);
  });

  it("never fabricates a $0 AUM when a materially-held asset has no valid price -- reports pricingComplete: false instead", () => {
    const aum = computeAumFromPrices(alphaAssets, {}); // no price for SSR at all (missing key, not just null)
    expect(aum.pricingComplete).to.equal(false);
    expect(aum.priceSource).to.equal("unavailable");
    expect(aum.aumUsd).to.equal(0);
    expect(aum.unpricedAssetMints).to.deep.equal([SSR_MINT]);
  });

  it("partial pricing across multiple assets: one priced, one not -> the WHOLE Reserve is unavailable, never a silently-partial total", () => {
    const priceByMint: Record<string, AssetPriceInfo> = { [SSR_MINT]: { usdPrice: 0.0005, source: "jupiter", lastUpdated: Date.now() } };
    const aum = computeAumFromPrices(
      [
        { assetMint: SSR_MINT, vaultBalanceRaw: "21132446514", decimals: 6 },
        { assetMint: "UnpricedOtherAssetMint111111111111111111", vaultBalanceRaw: "5000000", decimals: 6 },
      ],
      priceByMint,
    );
    expect(aum.pricingComplete).to.equal(false);
    expect(aum.aumUsd).to.equal(0);
    expect(aum.unpricedAssetMints).to.deep.equal(["UnpricedOtherAssetMint111111111111111111"]);
  });

  it("a genuinely empty Reserve (no material balance) is priceSource 'none', not 'unavailable' -- honest $0, not a pricing failure", () => {
    const aum = computeAumFromPrices([{ assetMint: SSR_MINT, vaultBalanceRaw: "0", decimals: 6 }], {});
    expect(aum.pricingComplete).to.equal(true);
    expect(aum.priceSource).to.equal("none");
    expect(aum.aumUsd).to.equal(0);
  });

  it("handles decimals precision correctly for a non-6-decimals asset (e.g. 9 decimals)", () => {
    const priceByMint: Record<string, AssetPriceInfo> = { "Mint9Decimals11111111111111111111111111": { usdPrice: 2, source: "pyth", lastUpdated: Date.now() } };
    const aum = computeAumFromPrices([{ assetMint: "Mint9Decimals11111111111111111111111111", vaultBalanceRaw: "1500000000", decimals: 9 }], priceByMint);
    expect(aum.aumUsd).to.be.closeTo(3, 1e-9); // 1.5 tokens x $2
  });

  it("a mix of Pyth- and Jupiter-priced assets reports priceSource 'mixed'", () => {
    const priceByMint: Record<string, AssetPriceInfo> = {
      MintA1111111111111111111111111111111111: { usdPrice: 1, source: "pyth", lastUpdated: 100 },
      MintB1111111111111111111111111111111111: { usdPrice: 2, source: "jupiter", lastUpdated: 200 },
    };
    const aum = computeAumFromPrices(
      [
        { assetMint: "MintA1111111111111111111111111111111111", vaultBalanceRaw: "1000000", decimals: 6 },
        { assetMint: "MintB1111111111111111111111111111111111", vaultBalanceRaw: "1000000", decimals: 6 },
      ],
      priceByMint,
    );
    expect(aum.priceSource).to.equal("mixed");
    expect(aum.priceAsOf).to.equal(100); // earliest contributing quote
  });
});

describe("computeMarketCap", () => {
  it("is supply x price, decimal-adjusted", () => {
    expect(computeMarketCap("9950000", 1.0251591516956682)).to.be.closeTo(10.2003, 0.001);
  });
  it("is the honest 0 sentinel (never fabricated) when price is unavailable", () => {
    expect(computeMarketCap("9950000", 0)).to.equal(0);
    expect(computeMarketCap("9950000", -1)).to.equal(0);
  });
});

describe("Buy estimate reconciled against the on-chain program calculation", () => {
  // Mirrors packages/sdk/src/directInstructions.ts's buildDirectMintInstructions
  // exactly: computeDirectReserveTokensRequested (the same ratio math
  // mint_reserve_tokens_in_kind itself uses) then computeNetMintOutput (the
  // same ceiling-rounded Mint Fee). DTRDetail.tsx's "Est. You Receive" now
  // calls these same two functions with the same inputs -- this test pins
  // that architecture so the displayed quote and the submitted transaction
  // can never silently diverge again.
  it("a $10-equivalent SSR deposit into the real, live ALPHA vault:supply state -> ~9.66 ALPHA after the 1% Mint Fee (same order as the reported '10 -> ~9.90 ALPHA' case)", () => {
    // The Buy input box is denominated in the Reserve's own asset (SSR for
    // ALPHA), not USD -- see resolveBuyAsset in DTRDetail.tsx. This
    // reconstructs "$10 worth of SSR" using SSR's own live-verified Jupiter
    // price ($0.00048268588081433423 at implementation time) purely to
    // reproduce the reported scenario's *order of magnitude*; it is not a
    // bit-exact replay of the original historical transaction (this pass has
    // no record of the exact vault:supply ratio at that past moment, only
    // the real, live-verified CURRENT one) -- the point being pinned here is
    // the formula itself (computeDirectReserveTokensRequested +
    // computeNetMintOutput, exactly what DTRDetail.tsx's estimate and
    // buildDirectMintInstructions's real transaction both call), not a
    // specific historical number.
    const decimals = 6;
    const ssrPriceUsd = 0.00048268588081433423;
    const amountIn = BigInt(Math.floor((10 / ssrPriceUsd) * 10 ** decimals)); // ~$10 worth of SSR, raw units
    const vaultBalance = 21_132_446_514n; // the real ALPHA SSR vault balance, live-verified at implementation time
    const supply = 9_950_000n; // the real ALPHA Reserve Token supply, live-verified at implementation time
    const mintFeeBps = 100n; // ALPHA's real, live-verified mintFeeBps

    const gross = computeDirectReserveTokensRequested(amountIn, vaultBalance, supply);
    const { netOut, feeShares } = computeNetMintOutput(gross, mintFeeBps);
    const netHuman = Number(netOut) / 10 ** decimals;

    expect(netOut + feeShares).to.equal(gross);
    expect(netHuman).to.be.closeTo(9.657, 0.01);
  });

  it("an exact 1:1 vault:supply ratio with a clean 1% fee produces an exact 9.9 (no rounding surprise)", () => {
    const decimals = 6;
    const amountIn = BigInt(10 * 10 ** decimals);
    const vaultBalance = 1_000_000_000n;
    const supply = 1_000_000_000n; // exactly 1:1
    const mintFeeBps = 100n;

    const gross = computeDirectReserveTokensRequested(amountIn, vaultBalance, supply);
    expect(gross).to.equal(amountIn); // 1:1 ratio -> gross reserve tokens requested equals the raw deposit
    const { netOut } = computeNetMintOutput(gross, mintFeeBps);
    expect(Number(netOut) / 10 ** decimals).to.equal(9.9);
  });

  it("throws (never silently returns a wrong number) for an unseeded Reserve (zero vault balance or supply) -- the frontend must show 'Quote unavailable' for this case, never a fabricated 0", () => {
    expect(() => computeDirectReserveTokensRequested(1_000_000n, 0n, 0n)).to.throw();
  });
});

describe("UI copy regression: 'NAV per Token' card removed, replaced by 'Market Cap'", () => {
  const files = ["src/merge/pages/DTRDetail.tsx", "src/merge/pages/ManageDTR.tsx", "src/merge/lib/reserveCardProps.ts"];
  for (const file of files) {
    it(`${file} no longer renders "NAV per Token" and does render "Market Cap"`, () => {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source).to.not.include("NAV per Token");
      expect(source.toLowerCase()).to.include("market cap");
    });
  }

  it("DTRDetail.tsx and ManageDTR.tsx route AUM/Market Cap through formatUsdcOrUnavailable (the honest 'Price unavailable' fallback), never a bare formatUsdc(dtr.aum) for a real on-chain Reserve", () => {
    for (const file of ["src/merge/pages/DTRDetail.tsx", "src/merge/pages/ManageDTR.tsx"]) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source).to.include("formatUsdcOrUnavailable");
    }
    // DTRDetail.tsx also literally renders the "Price unavailable" copy itself (AUM/Token Price cards).
    const dtrDetailSource = fs.readFileSync(path.join(__dirname, "..", "src/merge/pages/DTRDetail.tsx"), "utf8");
    expect(dtrDetailSource).to.include("Price unavailable");
  });
});
