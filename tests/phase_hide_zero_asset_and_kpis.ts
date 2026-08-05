// Offline, pure-logic regression coverage for: (1) hiding on-chain Reserves
// created without any underlying asset (see docs/project/DECISION_LOG.md),
// and (2) the real landing-page KPI restoration (Reserve Token Holders, 24h
// Volume). Matches this repo's existing testing split -- pure logic covered
// here offline; the live aggregate read is covered by a one-off sanity
// check against the deployed /api/devnet/landing-stats endpoint instead
// (see PROJECT_STATUS.md).
import { expect } from "chai";
import type { DTR } from "../src/merge/lib/types";
import { mergeDiscoveredReserves } from "../src/merge/lib/onChainReserve";
import { valueAssetLegsUsd, countHoldersFromParsedAccounts, SUPPORTED_ASSET_MINTS, type AssetPricing } from "../packages/sdk/src";

const SUPPORTED_MINTS_ARR = [...SUPPORTED_ASSET_MINTS];

// Genuinely eligible (fully-resolved, supported-mint, active, seeded) by
// default -- so a test overriding one field (assetCount, status) to exercise
// a SPECIFIC exclusion reason doesn't also trip an unrelated, newer
// eligibility check (resolved-vs-registered, seeded supply) by accident.
function makeDtr(id: string, assetCount: number | undefined, status = "active"): DTR {
  const resolvedAssetsCount = assetCount ?? 1;
  const assets =
    assetCount === 0
      ? []
      : Array.from({ length: resolvedAssetsCount }, (_, i) => ({
          mint: SUPPORTED_MINTS_ARR[i % SUPPORTED_MINTS_ARR.length],
          symbol: `A${i}`,
          decimals: 6,
          weightBps: Math.floor(10_000 / resolvedAssetsCount),
          reserveAsset: `ReserveAsset${i}11111111111111111111111111`,
          vault: `Vault${i}1111111111111111111111111111111`,
          orderIndex: i,
        }));
  return {
    id,
    name: id,
    ticker: id.toUpperCase(),
    description: "",
    category: "DevNet Test",
    tags: [],
    logoSeed: id,
    dtrAddress: id,
    managerAddress: "11111111111111111111111111111111",
    delegates: [],
    feeConfig: {
      mintFeePct: 0.5,
      tvlFeePct: 1,
      managerBuyTaxPct: 0,
      managerSellTaxPct: 0,
      creatorFeeDestination: "11111111111111111111111111111111",
      feeRecipients: [],
    },
    tokenPrice: 1,
    nav: 1,
    aum: 0,
    liquidityUsdc: 0,
    change24h: 0,
    change7d: 0,
    holders: 0,
    composition: [],
    unallocatedPct: 0,
    isUserCreated: false,
    priceHistory: [{ t: Date.now(), price: 1 }],
    trades: [],
    onChain: {
      programId: "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
      reserveId: id,
      reserve: id,
      reserveTokenMint: "11111111111111111111111111111111",
      mintAuthority: "11111111111111111111111111111111",
      vaultAuthority: "11111111111111111111111111111111",
      manager: "11111111111111111111111111111111",
      assets,
      status,
      totalTargetWeightBps: 0,
      reserveTokenSupplyRaw: assetCount === 0 ? "0" : "1000000",
      vaultBalancesRaw: {},
      assetCount,
    },
  };
}

describe("Zero-asset Reserve hiding -- mergeDiscoveredReserves", () => {
  it("never includes a freshly-discovered Reserve with assetCount === 0", () => {
    const good = makeDtr("good", 2);
    const bad = makeDtr("bad-created", 0, "created");
    const { dtrs } = mergeDiscoveredReserves([], [good, bad], true);
    expect(dtrs.map((d) => d.id)).to.deep.equal(["good"]);
  });

  it("drops a previously-cached zero-asset Reserve on the next fully-verified discovery pass, even if it's no longer present at all", () => {
    const staleBad = makeDtr("bad-created", 0, "created");
    const freshGood = makeDtr("good", 2);
    const { dtrs } = mergeDiscoveredReserves([staleBad], [freshGood], true);
    expect(dtrs.map((d) => d.id)).to.deep.equal(["good"]);
  });

  it("still excludes a zero-asset Reserve appearing in a fresh (but not-fully-verified) discovery pass", () => {
    const bad = makeDtr("bad-created", 0, "created");
    // The zero-asset filter applies to fresh `discovered` entries regardless
    // of `fullyVerified` -- only the SEPARATE "transient failure, keep the
    // previously-known entry" grace period (the `untouched` branch, for
    // Reserves NOT present in this pass at all) is conditional on
    // `fullyVerified`. A zero-asset Reserve that IS present in this fresh
    // pass is filtered out either way.
    const { dtrs } = mergeDiscoveredReserves([], [bad], false);
    expect(dtrs.find((d) => d.id === "bad-created")).to.equal(undefined);
  });

  it("never affects a Reserve whose assetCount is unresolved (undefined) -- only an explicit 0 is excluded", () => {
    const legacyFixture = makeDtr("legacy", undefined);
    const { dtrs } = mergeDiscoveredReserves([], [legacyFixture], true);
    expect(dtrs.map((d) => d.id)).to.deep.equal(["legacy"]);
  });

  it("does not disturb non-zero-asset Reserves' existing merge behavior (price history/trades carried over)", () => {
    const existing = makeDtr("good", 2);
    existing.trades = [{ id: "t1", t: 1, side: "buy", price: 1, amountUsdc: 1, amountToken: 1 } as never];
    const fresh = makeDtr("good", 2);
    const { dtrs } = mergeDiscoveredReserves([existing], [fresh], true);
    expect(dtrs[0].trades).to.deep.equal(existing.trades);
  });
});

describe("Real 24h volume -- valueAssetLegsUsd (pure money-math)", () => {
  const pricing: Record<string, AssetPricing> = {
    mockX: { decimals: 6, priceUsd: 1 },
    wsol: { decimals: 9, priceUsd: 20 },
  };

  it("sums legs valued at their configured price/decimals", () => {
    const usd = valueAssetLegsUsd(["mockX", "wsol"], ["5000000", "2000000000"], pricing);
    expect(usd).to.be.closeTo(5 * 1 + 2 * 20, 1e-9);
  });

  it("contributes 0 for an unpriced/unknown mint -- never a fabricated value", () => {
    const usd = valueAssetLegsUsd(["unknownMint"], ["999999999"], pricing);
    expect(usd).to.equal(0);
  });

  it("accepts bigint amounts directly, not just strings", () => {
    const usd = valueAssetLegsUsd(["mockX"], [1_000_000n], pricing);
    expect(usd).to.be.closeTo(1, 1e-9);
  });

  it("returns 0 for an empty leg list", () => {
    expect(valueAssetLegsUsd([], [], pricing)).to.equal(0);
  });
});

describe("Real Reserve Token holders -- countHoldersFromParsedAccounts (pure)", () => {
  it("counts only accounts with a genuine positive balance", () => {
    const accounts = [
      { parsed: { info: { tokenAmount: { uiAmount: 1.5 } } } },
      { parsed: { info: { tokenAmount: { uiAmount: 0 } } } },
      { parsed: { info: { tokenAmount: { uiAmount: null } } } },
      { parsed: { info: { tokenAmount: {} } } },
      { parsed: {} },
      {},
    ];
    expect(countHoldersFromParsedAccounts(accounts)).to.equal(1);
  });

  it("returns 0 for an empty account list (a mint nobody holds)", () => {
    expect(countHoldersFromParsedAccounts([])).to.equal(0);
  });
});
