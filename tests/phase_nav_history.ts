// Offline, pure-logic coverage for the Reserve NAV History pass (the fix for
// the "All-time chart is flat and all-time P&L reads +0.00% while an
// underlying asset is up 1300%" report, 2026-09-14): the server-side NAV
// math + recorder throttle (lib/reserve-nav-history/navMath.ts), the served
// payload assembly with its launch anchor (api/mainnet/reserve-nav-history.ts),
// the client-side merge of server history under local points and the
// all-time change (src/merge/lib/calculations.ts), and their wiring through
// mergeDiscoveredReserves. The DB layer and the cron are verified live, not
// mocked here.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_nav_history.ts
import { expect } from "chai";
import {
  computeNavUsd,
  computeEntryNavUsd,
  shouldRecordNavPoint,
  bucketWidthSeconds,
  withAnchor,
  NAV_RECORD_MIN_INTERVAL_MS,
  NAV_RECORD_MIN_SPACING_MS,
  type NavInputReserve,
} from "../lib/reserve-nav-history/navMath";
import { assembleNavHistory } from "../api/mainnet/reserve-nav-history";
import { mergePriceHistories, calcAllTimeChangePct, calcRecentChanges } from "../src/merge/lib/calculations";
import { mergeDiscoveredReserves } from "../src/merge/lib/onChainReserve";
import type { DTR, PricePoint } from "../src/merge/lib/types";

const SOL = "So11111111111111111111111111111111111111112";
const STONK = "STONK1111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// The BETA Reserve from the report, in round numbers: ~13.29 Reserve Tokens
// backed by SOL + STONK, STONK up ~14x since entry.
function betaReserve(): NavInputReserve {
  return {
    reserve: "52eHitfwh7sPNnF9Ft8YHBd4EqY6TkjygVfCEhVdxw9y",
    assetCount: 2,
    resolvedAssetCount: 2,
    reserveTokenSupplyRaw: "13290000", // 13.29 RT (6 decimals)
    assets: [
      { assetMint: SOL, vaultBalanceRaw: "167000000", decimals: 9 }, // 0.167 SOL
      { assetMint: STONK, vaultBalanceRaw: "333700000", decimals: 6 }, // 333.7 STONK
    ],
  };
}

describe("navMath.computeNavUsd / computeEntryNavUsd", () => {
  it("prices holdings at current prices and divides by supply", () => {
    const nav = computeNavUsd(betaReserve(), { [SOL]: 101.52, [STONK]: 0.212 });
    // (0.167 * 101.52 + 333.7 * 0.212) / 13.29
    expect(nav).to.be.closeTo((0.167 * 101.52 + 333.7 * 0.212) / 13.29, 1e-9);
  });

  it("the entry NAV is the same holdings at entry prices -- the launch anchor", () => {
    const entry = computeEntryNavUsd(betaReserve(), { [SOL]: 106.07, [STONK]: 0.01514 });
    expect(entry).to.be.closeTo((0.167 * 106.07 + 333.7 * 0.01514) / 13.29, 1e-9);
    const now = computeNavUsd(betaReserve(), { [SOL]: 101.52, [STONK]: 0.212 })!;
    // A Reserve whose dominant asset is up ~14x is decisively up all-time.
    expect(now / entry! - 1).to.be.greaterThan(1);
  });

  it("returns null (never a partial number) when any held asset is unpriced", () => {
    expect(computeNavUsd(betaReserve(), { [SOL]: 101.52 })).to.equal(null);
    expect(computeNavUsd(betaReserve(), { [SOL]: 101.52, [STONK]: 0 })).to.equal(null);
    expect(computeNavUsd(betaReserve(), { [SOL]: 101.52, [STONK]: Number.NaN })).to.equal(null);
  });

  it("ignores an unpriced asset with a zero balance", () => {
    const r = betaReserve();
    r.assets[1].vaultBalanceRaw = "0";
    expect(computeNavUsd(r, { [SOL]: 100 })).to.be.closeTo((0.167 * 100) / 13.29, 1e-9);
  });

  it("returns null for zero supply or an under-resolved asset set", () => {
    const zero = betaReserve();
    zero.reserveTokenSupplyRaw = "0";
    expect(computeNavUsd(zero, { [SOL]: 100, [STONK]: 1 })).to.equal(null);
    const under = betaReserve();
    under.assetCount = 3;
    expect(computeNavUsd(under, { [SOL]: 100, [STONK]: 1 })).to.equal(null);
  });
});

describe("navMath.shouldRecordNavPoint (recorder throttle)", () => {
  const t0 = 1_800_000_000_000;
  it("always records the first observation, never an invalid one", () => {
    expect(shouldRecordNavPoint(null, 6.92, t0)).to.equal(true);
    expect(shouldRecordNavPoint(null, 0, t0)).to.equal(false);
    expect(shouldRecordNavPoint(null, Number.NaN, t0)).to.equal(false);
  });
  it("never records twice inside the minimum spacing, however big the move", () => {
    expect(shouldRecordNavPoint({ t: t0, nav: 6.92 }, 9.0, t0 + NAV_RECORD_MIN_SPACING_MS - 1)).to.equal(false);
  });
  it("records a >=0.5% move once the spacing has elapsed, but not a smaller one", () => {
    const later = t0 + NAV_RECORD_MIN_SPACING_MS;
    expect(shouldRecordNavPoint({ t: t0, nav: 6.92 }, 6.92 * 1.006, later)).to.equal(true);
    expect(shouldRecordNavPoint({ t: t0, nav: 6.92 }, 6.92 * 0.994, later)).to.equal(true);
    expect(shouldRecordNavPoint({ t: t0, nav: 6.92 }, 6.92 * 1.001, later)).to.equal(false);
  });
  it("records an unchanged NAV once the quiet interval has elapsed", () => {
    expect(shouldRecordNavPoint({ t: t0, nav: 6.92 }, 6.92, t0 + NAV_RECORD_MIN_INTERVAL_MS - 1)).to.equal(false);
    expect(shouldRecordNavPoint({ t: t0, nav: 6.92 }, 6.92, t0 + NAV_RECORD_MIN_INTERVAL_MS)).to.equal(true);
  });
});

describe("navMath.bucketWidthSeconds / withAnchor", () => {
  it("downsamples a span to at most maxPoints buckets, never below 1s", () => {
    expect(bucketWidthSeconds(30 * 24 * 3600 * 1000, 600)).to.equal(Math.ceil((30 * 24 * 3600) / 600));
    expect(bucketWidthSeconds(1000, 600)).to.equal(1);
    expect(bucketWidthSeconds(1000, 0)).to.equal(1);
  });
  it("prepends the anchor only when it predates the first recorded point", () => {
    const pts = [
      { t: 200, nav: 2 },
      { t: 300, nav: 3 },
    ];
    expect(withAnchor(pts, { t: 100, nav: 1 })).to.deep.equal([{ t: 100, nav: 1 }, ...pts]);
    expect(withAnchor(pts, { t: 250, nav: 1 })).to.deep.equal(pts);
    expect(withAnchor([], { t: 100, nav: 1 })).to.deep.equal([{ t: 100, nav: 1 }]);
    expect(withAnchor(pts, null)).to.deep.equal(pts);
    expect(withAnchor(pts, { t: 100, nav: 0 })).to.deep.equal(pts);
  });
});

describe("api/mainnet/reserve-nav-history assembleNavHistory", () => {
  const reserve = betaReserve();
  const entry = new Map([[reserve.reserve, { prices: { [SOL]: 106.07, [STONK]: 0.01514 }, capturedAt: 1_000 }]]);

  it("serves the launch anchor alone for a Reserve nothing has been recorded for yet (recordedFrom null)", () => {
    const out = assembleNavHistory([], [reserve], entry);
    const s = out[reserve.reserve];
    expect(s.recordedFrom).to.equal(null);
    expect(s.points).to.have.length(1);
    expect(s.points[0].t).to.equal(1_000);
    expect(s.points[0].price).to.be.closeTo((0.167 * 106.07 + 333.7 * 0.01514) / 13.29, 1e-9);
  });

  it("prefixes recorded points with the anchor and reports where recording began", () => {
    const recorded = [{ reserve: reserve.reserve, recordedFrom: 5_000, points: [{ t: 5_000, nav: 6.9 }, { t: 6_000, nav: 6.92 }] }];
    const s = assembleNavHistory(recorded, [reserve], entry)[reserve.reserve];
    expect(s.recordedFrom).to.equal(5_000);
    expect(s.points.map((p) => p.t)).to.deep.equal([1_000, 5_000, 6_000]);
    expect(s.points[2].price).to.equal(6.92);
  });

  it("serves recorded points without an anchor when entry prices are incomplete, and omits a Reserve with nothing at all", () => {
    const partial = new Map([[reserve.reserve, { prices: { [SOL]: 106.07 }, capturedAt: 1_000 }]]);
    const recorded = [{ reserve: reserve.reserve, recordedFrom: 5_000, points: [{ t: 5_000, nav: 6.9 }] }];
    expect(assembleNavHistory(recorded, [reserve], partial)[reserve.reserve].points.map((p) => p.t)).to.deep.equal([5_000]);
    expect(assembleNavHistory([], [reserve], partial)).to.deep.equal({});
  });
});

describe("calculations.mergePriceHistories / calcAllTimeChangePct", () => {
  const server: PricePoint[] = [
    { t: 1_000, price: 2.2 },
    { t: 5_000, price: 6.9 },
  ];
  it("keeps every server point and appends only NEWER local points", () => {
    const local: PricePoint[] = [
      { t: 900, price: 6.85 }, // this browser's own earlier observation -- superseded by the server's past
      { t: 5_000, price: 6.9 }, // same instant as the last server point -- dropped, not duplicated
      { t: 7_000, price: 6.92 },
    ];
    expect(mergePriceHistories(server, local)).to.deep.equal([...server, { t: 7_000, price: 6.92 }]);
  });
  it("drops non-positive placeholder points and keeps timestamps strictly increasing", () => {
    expect(mergePriceHistories([{ t: 1, price: 0 }, ...server, { t: 5_000, price: 7 }], [{ t: 8_000, price: 0 }])).to.deep.equal(server);
  });
  it("falls back to the local history when the server has nothing", () => {
    const local = [{ t: 7_000, price: 6.92 }];
    expect(mergePriceHistories([], local)).to.deep.equal(local);
  });
  it("all-time change measures from the earliest valid point; null without a base or a current price", () => {
    expect(calcAllTimeChangePct(server, 6.92)).to.be.closeTo(((6.92 - 2.2) / 2.2) * 100, 1e-9);
    expect(calcAllTimeChangePct([{ t: 1, price: 0 }, ...server], 6.92)).to.be.closeTo(((6.92 - 2.2) / 2.2) * 100, 1e-9);
    expect(calcAllTimeChangePct([], 6.92)).to.equal(null);
    expect(calcAllTimeChangePct(server, 0)).to.equal(null);
    expect(calcAllTimeChangePct(server, null)).to.equal(null);
  });
  it("24h/7d changes still measure from inside their own windows, not from the launch anchor", () => {
    const now = 30 * 24 * 3600 * 1000;
    const history: PricePoint[] = [
      { t: 0, price: 1 }, // launch anchor a month ago
      { t: now - 6 * 24 * 3600 * 1000, price: 2 },
      { t: now - 12 * 3600 * 1000, price: 4 },
    ];
    const { change24h, change7d } = calcRecentChanges(history, 8, now);
    expect(change24h).to.be.closeTo(100, 1e-9);
    expect(change7d).to.be.closeTo(300, 1e-9);
  });
});

function makeDtr(id: string, reserve: string, nav: number, priceHistory: PricePoint[]): DTR {
  return {
    id,
    name: id,
    ticker: id.toUpperCase(),
    description: "",
    category: "Mainnet",
    tags: [],
    logoSeed: id,
    dtrAddress: reserve,
    managerAddress: "11111111111111111111111111111111",
    delegates: [],
    feeConfig: { mintFeePct: 0.5, tvlFeePct: 1, managerBuyTaxPct: 0, managerSellTaxPct: 0, creatorFeeDestination: "11111111111111111111111111111111", feeRecipients: [] },
    tokenPrice: nav,
    nav,
    aum: 0,
    liquidityUsdc: 0,
    change24h: 0,
    change7d: 0,
    holders: 0,
    composition: [{ symbol: "USDC", name: "USDC", weight: 1 }],
    unallocatedPct: 0,
    isUserCreated: false,
    priceHistory,
    trades: [],
    onChain: {
      programId: "11111111111111111111111111111111",
      reserveId: "0",
      reserve,
      reserveTokenMint: `${id}-rt`,
      mintAuthority: "11111111111111111111111111111111",
      vaultAuthority: "11111111111111111111111111111111",
      manager: "11111111111111111111111111111111",
      assets: [{ mint: USDC, symbol: "USDC", decimals: 6, weightBps: 10000, reserveAsset: `${id}-ra`, vault: `${id}-v`, orderIndex: 0 }],
      status: "active",
      totalTargetWeightBps: 10000,
      reserveTokenSupplyRaw: "1000000",
      vaultBalancesRaw: {},
      assetCount: 1,
      assetsResolvedFully: true,
    },
  } as DTR;
}

describe("mergeDiscoveredReserves -- server history wiring", () => {
  const RESERVE = "52eHitfwh7sPNnF9Ft8YHBd4EqY6TkjygVfCEhVdxw9y";
  const serverHistory = { [RESERVE]: { points: [{ t: 1_000, price: 2.2 }, { t: 5_000, price: 6.9 }], recordedFrom: 5_000 } };

  it("a fresh discovery with server history starts from the anchor, not from this browser's first sighting", () => {
    const fresh = makeDtr("beta", RESERVE, 6.92, [{ t: Date.now(), price: 6.92 }]);
    const { dtrs } = mergeDiscoveredReserves([], [fresh], true, serverHistory);
    expect(dtrs[0].priceHistory[0]).to.deep.equal({ t: 1_000, price: 2.2 });
    expect(dtrs[0].priceHistoryRecordedFrom).to.equal(5_000);
    expect(calcAllTimeChangePct(dtrs[0].priceHistory, dtrs[0].nav)).to.be.closeTo(((6.92 - 2.2) / 2.2) * 100, 1e-9);
  });

  it("a later pass without server history keeps the merged history and the recorded-from marker", () => {
    const fresh = makeDtr("beta", RESERVE, 6.92, [{ t: Date.now(), price: 6.92 }]);
    const first = mergeDiscoveredReserves([], [fresh], true, serverHistory).dtrs;
    const second = mergeDiscoveredReserves(first, [makeDtr("beta", RESERVE, 6.95, [{ t: Date.now(), price: 6.95 }])], true).dtrs;
    expect(second[0].priceHistory[0]).to.deep.equal({ t: 1_000, price: 2.2 });
    expect(second[0].priceHistoryRecordedFrom).to.equal(5_000);
  });

  it("without any server history (DevNet, tests) behaviour is unchanged: the marker stays undefined", () => {
    const fresh = makeDtr("beta", RESERVE, 6.92, [{ t: Date.now(), price: 6.92 }]);
    const { dtrs } = mergeDiscoveredReserves([], [fresh], true);
    expect(dtrs[0].priceHistoryRecordedFrom).to.equal(undefined);
    expect(dtrs[0].priceHistory).to.have.length(1);
  });
});
