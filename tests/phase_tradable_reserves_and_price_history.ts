// Offline, pure-logic regression coverage for this pass's two corrective
// fixes: (1) the shared Reserve-tradability eligibility function (site-wide
// gate for which Reserves are Buy/Sell-capable, per
// packages/sdk/src/tradableAssets.ts, and its wiring into
// mergeDiscoveredReserves), and (2) the Price History range-selector fix
// (calculations.ts's buildLineSeries, now honestly reporting insufficient
// history instead of fabricating a flatline, with genuinely independent
// per-range filtering). The actual on-chain multi-asset Buy/Sell instruction
// builders (packages/sdk/src/zapInstructions.ts) are, like every other
// builder in that file, verified live against DevNet instead of mocked here
// -- see scripts/verify_corrective_pass.ts and this pass's PROJECT_STATUS.md
// entry for the real signatures.
import { expect } from "chai";
import type { DTR } from "../src/merge/lib/types";
import { mergeDiscoveredReserves } from "../src/merge/lib/onChainReserve";
import { buildLineSeries } from "../src/merge/lib/calculations";
import { isReserveTradable, isSupportedAssetMint, SUPPORTED_ASSET_MINTS, DEVNET_FIXTURES, DEVUSDC } from "../packages/sdk/src";

const DEVUSDC_MINT = DEVUSDC.mint;
const MOCK_X = DEVNET_FIXTURES.mints.mintX.address;
const MOCK_Y = DEVNET_FIXTURES.mints.mintY.address;
const MOCK_Z = DEVNET_FIXTURES.mints.mintZ.address;
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const RANDOM_MINT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("Reserve tradability -- isReserveTradable / isSupportedAssetMint (pure)", () => {
  it("recognizes all 4 configured mints as supported", () => {
    expect(isSupportedAssetMint(DEVUSDC_MINT)).to.equal(true);
    expect(isSupportedAssetMint(MOCK_X)).to.equal(true);
    expect(isSupportedAssetMint(MOCK_Y)).to.equal(true);
    expect(isSupportedAssetMint(MOCK_Z)).to.equal(true);
    expect(SUPPORTED_ASSET_MINTS.size).to.equal(4);
  });

  it("does not recognize wrapped SOL or an arbitrary mint as supported", () => {
    expect(isSupportedAssetMint(WRAPPED_SOL)).to.equal(false);
    expect(isSupportedAssetMint(RANDOM_MINT)).to.equal(false);
  });

  it("is tradable for 100% devUSDC", () => {
    expect(isReserveTradable([DEVUSDC_MINT])).to.equal(true);
  });

  it("is tradable for 100% mockX", () => {
    expect(isReserveTradable([MOCK_X])).to.equal(true);
  });

  it("is tradable for a multi-asset mockX/mockY/mockZ composition", () => {
    expect(isReserveTradable([MOCK_X, MOCK_Y, MOCK_Z])).to.equal(true);
  });

  it("is tradable for a mixed devUSDC + mock composition, any order", () => {
    expect(isReserveTradable([DEVUSDC_MINT, MOCK_X])).to.equal(true);
    expect(isReserveTradable([MOCK_Z, DEVUSDC_MINT, MOCK_Y])).to.equal(true);
  });

  it("is NOT tradable if even one asset is wrapped SOL, even alongside otherwise-supported assets", () => {
    expect(isReserveTradable([DEVUSDC_MINT, WRAPPED_SOL])).to.equal(false);
    expect(isReserveTradable([WRAPPED_SOL])).to.equal(false);
  });

  it("is NOT tradable for an unrecognized mint (validated by address, not symbol/ticker)", () => {
    expect(isReserveTradable([RANDOM_MINT])).to.equal(false);
  });

  it("is NOT tradable for an empty asset list -- an unresolved/incomplete Reserve shape, never a supported one", () => {
    expect(isReserveTradable([])).to.equal(false);
  });
});

function makeDtr(id: string, mints: string[], resolvedFully = true): DTR {
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
    composition: mints.map((m, i) => ({ symbol: `A${i}`, name: `A${i}`, weight: 1 / mints.length })),
    unallocatedPct: 0,
    isUserCreated: false,
    priceHistory: [{ t: Date.now(), price: 1 }],
    trades: [],
    onChain: {
      programId: "11111111111111111111111111111111",
      reserveId: "0",
      reserve: id,
      reserveTokenMint: `${id}-rt`,
      mintAuthority: "11111111111111111111111111111111",
      vaultAuthority: "11111111111111111111111111111111",
      manager: "11111111111111111111111111111111",
      assets: mints.map((m, i) => ({ mint: m, symbol: `A${i}`, decimals: 6, weightBps: Math.floor(10000 / mints.length), reserveAsset: `${id}-ra${i}`, vault: `${id}-v${i}`, orderIndex: i })),
      status: "active",
      totalTargetWeightBps: 10000,
      reserveTokenSupplyRaw: "1000000",
      vaultBalancesRaw: {},
      assetCount: mints.length,
      assetsResolvedFully: resolvedFully,
    },
  } as DTR;
}

describe("Reserve tradability -- wired into mergeDiscoveredReserves (single shared gate)", () => {
  it("keeps a freshly-discovered, fully-resolved, all-supported-asset Reserve", () => {
    const fresh = [makeDtr("r1", [DEVUSDC_MINT, MOCK_X])];
    const merged = mergeDiscoveredReserves([], fresh, true);
    expect(merged.map((d) => d.id)).to.deep.equal(["r1"]);
  });

  it("excludes a freshly-discovered, fully-resolved Reserve holding wrapped SOL", () => {
    const fresh = [makeDtr("r-sol", [DEVUSDC_MINT, WRAPPED_SOL])];
    const merged = mergeDiscoveredReserves([], fresh, true);
    expect(merged).to.deep.equal([]);
  });

  it("does NOT exclude an under-resolved Reserve on composition alone -- avoids hiding a genuinely tradable Reserve on a transient resolution gap", () => {
    const partial = [makeDtr("r-partial", [WRAPPED_SOL], /* resolvedFully */ false)];
    const merged = mergeDiscoveredReserves([], partial, true);
    expect(merged.map((d) => d.id)).to.deep.equal(["r-partial"]);
  });

  it("drops a previously-known ineligible Reserve on the next fully-verified pass even if it's simply absent from fresh results", () => {
    const existing = [makeDtr("r-sol", [DEVUSDC_MINT, WRAPPED_SOL])];
    const merged = mergeDiscoveredReserves(existing, [], true);
    expect(merged).to.deep.equal([]);
  });
});

describe("Price History -- buildLineSeries (pure, centralized fallback helper shared by DTRDetail's chart and Featured's sparkline)", () => {
  const now = 1_000_000_000_000; // fixed reference instant
  const DAY = 24 * 60 * 60 * 1000;

  it("reports unavailable (never a fabricated $0 line) for a Reserve with 0 price points AND no valid current NAV", () => {
    const result = buildLineSeries([], "24h", null, now);
    expect(result.unavailable).to.equal(true);
    expect(result.isFallback).to.equal(false);
    expect(result.points).to.deep.equal([]);
  });

  it("reports unavailable when the current NAV is 0, negative, or non-finite -- never treats those as a genuine value", () => {
    for (const badNav of [0, -1, NaN, Infinity]) {
      const result = buildLineSeries([], "24h", badNav, now);
      expect(result.unavailable, `nav ${badNav}`).to.equal(true);
      expect(result.points, `nav ${badNav}`).to.deep.equal([]);
    }
  });

  it("generates a client-side flatline anchored to the current NAV for a Reserve with 0 real price points, for EVERY range, spanning the exact selected window", () => {
    for (const tf of ["1s", "1m", "5m", "1h", "4h", "24h", "7d", "30d", "1y", "All"] as const) {
      const result = buildLineSeries([], tf, 1.23, now);
      expect(result.unavailable, `timeframe ${tf}`).to.equal(false);
      expect(result.isFallback, `timeframe ${tf}`).to.equal(true);
      expect(result.points.length, `timeframe ${tf}`).to.be.greaterThan(2);
      expect(result.points.every((p) => p.price === 1.23), `timeframe ${tf}`).to.equal(true);
      expect(result.points[result.points.length - 1].t, `timeframe ${tf}`).to.equal(now);
    }
  });

  it("the default 7d fallback spans exactly 7 days before now to now", () => {
    const result = buildLineSeries([], "7d", 1.0, now);
    expect(result.points[0].t).to.equal(now - 7 * DAY);
    expect(result.points[result.points.length - 1].t).to.equal(now);
  });

  it("extends a single genuine observation's own value backward across the whole range, rather than substituting the current NAV", () => {
    const history = [{ t: now - 1000, price: 2.5 }];
    const result = buildLineSeries(history, "7d", 9.99, now); // current NAV deliberately different from the one real point
    expect(result.unavailable).to.equal(false);
    expect(result.isFallback).to.equal(true);
    expect(result.points.every((p) => p.price === 2.5)).to.equal(true);
  });

  it("still flatlines the single real observation's value even with no current NAV available", () => {
    const history = [{ t: now - 1000, price: 3.3 }];
    const result = buildLineSeries(history, "24h", null, now);
    expect(result.unavailable).to.equal(false);
    expect(result.isFallback).to.equal(true);
    expect(result.points.every((p) => p.price === 3.3)).to.equal(true);
  });

  it("with 2+ real points, different ranges produce genuinely different windows -- not the same dataset stretched across every range", () => {
    const history = [
      { t: now - 400 * DAY, price: 1.0 },
      { t: now - 200 * DAY, price: 1.1 },
      { t: now - 10 * DAY, price: 1.2 },
      { t: now - 2 * DAY, price: 1.3 },
      { t: now - 12 * 60 * 60 * 1000, price: 1.4 },
      { t: now - 30 * 1000, price: 1.5 },
    ];
    const oneHour = buildLineSeries(history, "1h", null, now);
    const sevenDay = buildLineSeries(history, "7d", null, now);
    const oneYear = buildLineSeries(history, "1y", null, now);
    expect(oneHour.isFallback).to.equal(false);
    expect(sevenDay.isFallback).to.equal(false);
    expect(oneYear.isFallback).to.equal(false);
    // Genuinely different point counts/content per range -- proves real
    // per-range filtering, not one dataset reused for every button.
    expect(oneHour.points.length).to.not.equal(sevenDay.points.length);
    expect(sevenDay.points.length).to.not.equal(oneYear.points.length);
    expect(oneHour.points[oneHour.points.length - 1].price).to.equal(1.5);
    // 1h's own window only reaches back 1 hour, so its earliest point must
    // be within that window (or a lead-in exactly at the window start) --
    // never the Reserve's oldest (400-day-old) observation.
    expect(oneHour.points[0].t).to.be.greaterThanOrEqual(now - 2 * 60 * 60 * 1000);
    // 1y's window reaches back 365 days, so it must include the 400-day-old
    // point's real price as its lead-in anchor, unlike 1h/7d.
    expect(oneYear.points[0].price).to.equal(1.0);
  });

  it("appends the current genuine NAV as the latest point when it's newer than the last real observation, without altering any real historical point", () => {
    const history = [
      { t: now - 100_000, price: 1.0 },
      { t: now - 50_000, price: 1.1 },
    ];
    const result = buildLineSeries(history, "1h", 1.25, now);
    expect(result.isFallback).to.equal(false);
    expect(result.points[result.points.length - 1]).to.deep.equal({ t: now, price: 1.25 });
    // The real historical points are untouched.
    expect(result.points.find((p) => p.t === now - 100_000)?.price).to.equal(1.0);
    expect(result.points.find((p) => p.t === now - 50_000)?.price).to.equal(1.1);
  });

  it("flatlines a quiet window at the last REAL observed price, not an invented one", () => {
    const history = [
      { t: now - 10_000, price: 2.5 },
      { t: now - 5_000, price: 2.5 },
    ];
    const result = buildLineSeries(history, "1s", null, now); // window: last 60s, no point strictly newer than -5000ms... both are within 60s actually
    expect(result.isFallback).to.equal(false);
    expect(result.points.every((p) => p.price === 2.5)).to.equal(true);
  });

  it("two independent calls (simulating two chart instances / two different Reserves) never share state or influence each other", () => {
    const historyA = [
      { t: now - 100_000, price: 1.0 },
      { t: now - 1_000, price: 1.05 },
    ];
    const historyB = [{ t: now - 500, price: 9.9 }]; // fewer than 2 real points -- fallback path

    const a1 = buildLineSeries(historyA, "1h", null, now);
    const b1 = buildLineSeries(historyB, "1h", 9.9, now);
    const a2 = buildLineSeries(historyA, "24h", null, now);
    const b2 = buildLineSeries(historyB, "24h", 9.9, now);

    expect(a1.isFallback).to.equal(false);
    expect(b1.isFallback).to.equal(true);
    expect(a2.isFallback).to.equal(false);
    expect(b2.isFallback).to.equal(true);
    // Interleaving calls for two different "instances" must not cross-
    // contaminate: A's results are identical regardless of B being called
    // in between, and vice versa.
    expect(buildLineSeries(historyA, "1h", null, now)).to.deep.equal(a1);
    expect(buildLineSeries(historyB, "1h", 9.9, now)).to.deep.equal(b1);
  });
});
