// Offline, pure-logic regression coverage for the 2026-07-31 corrective pass
// covering: Buy percentage buttons using the genuine devUSDC balance (no
// hardcoded 100-token cap), AUM/chart reconciliation (price-history
// accumulation), Reserve categories, deployment idempotency (the
// CreateReserveStepError-carried step/addresses design that replaced a real
// React stale-closure bug), the deployment-in-progress persistence marker,
// and the explicit hidden-Reserve registry (EGAYQQ). Matches this repo's
// existing testing split -- pure logic covered here offline; live-DevNet
// behavior covered separately by scripts/verify_*.ts and
// scripts/find_reserve_by_ticker.ts. See docs/project/PROJECT_STATUS.md.
import { expect } from "chai";
import type { DTR, Trade } from "../src/merge/lib/types";
import { buyAvailableFromDevUsdcBalance, isReservePureDevUsdc, appendPricePoint } from "../src/merge/lib/calculations";
import { RESERVE_CATEGORIES, normalizeReserveCategory } from "../src/merge/lib/types";
import { mergeDiscoveredReserves } from "../src/merge/lib/onChainReserve";
import { isHiddenReserveAddress, HIDDEN_RESERVE_ADDRESSES } from "../packages/sdk/src";
import { CreateReserveStepError, savePendingReserveDeploy, readPendingReserveDeploy, clearPendingReserveDeploy } from "../src/merge/lib/createReserveClient";

function makeDtr(id: string, opts: { assetCount?: number; status?: string; reserve?: string; priceHistory?: DTR["priceHistory"]; trades?: Trade[] } = {}): DTR {
  const reserve = opts.reserve ?? id;
  return {
    id,
    name: id,
    ticker: id.toUpperCase(),
    description: "",
    category: "DevNet Test",
    tags: [],
    logoSeed: id,
    dtrAddress: reserve,
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
    priceHistory: opts.priceHistory ?? [{ t: Date.now(), price: 1 }],
    trades: opts.trades ?? [],
    onChain: {
      programId: "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
      reserveId: id,
      reserve,
      reserveTokenMint: "11111111111111111111111111111111",
      mintAuthority: "11111111111111111111111111111111",
      vaultAuthority: "11111111111111111111111111111111",
      manager: "11111111111111111111111111111111",
      assets: [],
      status: opts.status ?? "active",
      totalTargetWeightBps: 0,
      reserveTokenSupplyRaw: "0",
      vaultBalancesRaw: {},
      assetCount: opts.assetCount,
    },
  };
}

describe("Buy quick-select availability (buyAvailableFromDevUsdcBalance)", () => {
  it("derives Max directly from the real devUSDC balance -- never scaled by Reserve composition", () => {
    // devUSDC is the universal purchasing currency: it is NEVER required to
    // be one of a Reserve's own assets, so availability must never depend on
    // that Reserve's target weights. Max for a 750-devUSDC wallet is exactly
    // 750, for EVERY Reserve, regardless of what that Reserve holds.
    expect(buyAvailableFromDevUsdcBalance(750)).to.equal(750);
    expect(buyAvailableFromDevUsdcBalance(1000)).to.equal(1000);
  });

  it("never falls back to a hardcoded 100 -- always reflects the real balance passed in", () => {
    // The original live-reported bug: a wallet holding ~750 devUSDC saw Max
    // fill exactly 100, traced to a `devUsdcWeightFraction === 0 ? 100 : ...`
    // fallback that conflated "does this Reserve hold devUSDC" with "can I
    // pay with devUSDC" -- a conflation the corrected architecture removes
    // entirely. This function has no composition parameter at all anymore.
    expect(buyAvailableFromDevUsdcBalance(750)).to.not.equal(100);
    expect(buyAvailableFromDevUsdcBalance(750)).to.equal(750);
  });

  it("is exactly proportional -- 25/50/75% of Max always equal 25/50/75% of the real balance", () => {
    const max = buyAvailableFromDevUsdcBalance(2000);
    expect(max * 0.25).to.equal(500);
    expect(max * 0.5).to.equal(1000);
    expect(max * 0.75).to.equal(1500);
  });

  it("never goes negative for a zero or malformed balance", () => {
    expect(buyAvailableFromDevUsdcBalance(0)).to.equal(0);
    expect(buyAvailableFromDevUsdcBalance(-5)).to.equal(0);
  });
});

describe("Genuine Buy/Sell support gate (isReservePureDevUsdc)", () => {
  const DEVUSDC = "Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k";
  const MOCKX = "2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu";

  it("is true for a Reserve backed 100% by devUSDC (the only genuine, fabrication-free composition today)", () => {
    expect(isReservePureDevUsdc([DEVUSDC], DEVUSDC)).to.equal(true);
  });

  it("is false for any Reserve holding even one non-devUSDC asset -- no hidden funding is ever allowed through", () => {
    expect(isReservePureDevUsdc([DEVUSDC, MOCKX], DEVUSDC)).to.equal(false);
    expect(isReservePureDevUsdc([MOCKX], DEVUSDC)).to.equal(false);
  });

  it("is false for a Reserve with no resolved assets at all -- never treated as vacuously 'pure'", () => {
    expect(isReservePureDevUsdc([], DEVUSDC)).to.equal(false);
  });

  it("devUSDC itself is never required to be a Reserve Asset for a wallet to spend it -- the gate is about the RESERVE's composition, not the wallet's holdings", () => {
    // A wallet's ability to spend devUSDC (buyAvailableFromDevUsdcBalance)
    // and a Reserve's ability to genuinely accept it (isReservePureDevUsdc)
    // are deliberately independent checks -- confirmed here by exercising
    // both with no shared state or coupling.
    const walletMax = buyAvailableFromDevUsdcBalance(500);
    const reserveSupported = isReservePureDevUsdc([MOCKX], DEVUSDC);
    expect(walletMax).to.equal(500);
    expect(reserveSupported).to.equal(false);
  });
});

describe("Chart/price-history accumulation (appendPricePoint)", () => {
  it("appends a new chronological point rather than replacing the series", () => {
    const start = [{ t: 1000, price: 1 }];
    const next = appendPricePoint(start, 1, 2000);
    expect(next).to.have.length(2);
    expect(next[0]).to.deep.equal({ t: 1000, price: 1 });
    expect(next[1]).to.deep.equal({ t: 2000, price: 1 });
  });

  it("logs a genuinely unchanged price truthfully (proportional-backing NAV staying $1.00 is not a bug)", () => {
    // A Reserve backed 1:1 by devUSDC genuinely keeps NAV at $1.00 after a
    // Buy -- appendPricePoint must record that real, unchanged value, not
    // synthesize movement to make the chart animate.
    const series = appendPricePoint(appendPricePoint([{ t: 1, price: 1 }], 1, 2), 1, 3);
    expect(series.map((p) => p.price)).to.deep.equal([1, 1, 1]);
  });

  it("guarantees strictly increasing timestamps even for same-millisecond trades", () => {
    const series = appendPricePoint([{ t: 5000, price: 1 }], 1.01, 5000);
    expect(series[series.length - 1].t).to.be.greaterThan(5000);
  });

  it("never produces a non-chronological (reversed) series", () => {
    let series = [{ t: 0, price: 1 }];
    for (let i = 0; i < 20; i++) series = appendPricePoint(series, 1 + i * 0.001, Date.now());
    for (let i = 1; i < series.length; i++) expect(series[i].t).to.be.greaterThan(series[i - 1].t);
  });
});

describe("Reserve categories", () => {
  it("exposes the exact 15 canonical categories from the corrective pass spec", () => {
    expect([...RESERVE_CATEGORIES]).to.deep.equal([
      "DeFi", "Layer 1", "Layer 2", "AI", "DePIN", "Gaming", "Meme", "RWA",
      "Stablecoins", "Infrastructure", "Privacy", "Social", "Ecosystem", "Index", "Custom",
    ]);
  });

  it("normalizes a missing/empty category to an honest 'Uncategorized' label", () => {
    expect(normalizeReserveCategory(undefined)).to.equal("Uncategorized");
    expect(normalizeReserveCategory(null)).to.equal("Uncategorized");
    expect(normalizeReserveCategory("")).to.equal("Uncategorized");
    expect(normalizeReserveCategory("   ")).to.equal("Uncategorized");
  });

  it("never overwrites an existing legacy/non-canonical category -- passes it through verbatim", () => {
    expect(normalizeReserveCategory("DevNet Fixture")).to.equal("DevNet Fixture");
    expect(normalizeReserveCategory("DeFi")).to.equal("DeFi");
  });
});

describe("Hidden Reserve registry (EGAYQQ)", () => {
  const EGAYQQ_ADDRESS = "GNAvLuTNmccXx5bSAVQeqPSncay7kBNjjHZFKFvKUbo2";

  it("contains exactly the confirmed EGAYQQ Reserve address, verified live via scripts/find_reserve_by_ticker.ts", () => {
    expect(isHiddenReserveAddress(EGAYQQ_ADDRESS)).to.equal(true);
    expect(HIDDEN_RESERVE_ADDRESSES.size).to.equal(1);
  });

  it("does not hide a different Reserve merely for sharing a similar structural state (assetsInitializing, low assetCount)", () => {
    expect(isHiddenReserveAddress("SomeOtherAssetsInitializingReserveAddress11111111")).to.equal(false);
  });

  it("mergeDiscoveredReserves excludes the hidden address even though its assetCount is nonzero (unlike the assetCount===0 filter)", () => {
    const hidden = makeDtr("ozeegay", { assetCount: 1, status: "assetsInitializing", reserve: EGAYQQ_ADDRESS });
    const good = makeDtr("good", { assetCount: 2 });
    const merged = mergeDiscoveredReserves([], [hidden, good], true);
    expect(merged.map((d) => d.id)).to.deep.equal(["good"]);
  });

  it("does not exclude a similarly-shaped Reserve at a DIFFERENT address", () => {
    const notHidden = makeDtr("ozeegay-lookalike", { assetCount: 1, status: "assetsInitializing", reserve: "SomeOtherAssetsInitializingReserveAddress11111111" });
    const merged = mergeDiscoveredReserves([], [notHidden], true);
    expect(merged.map((d) => d.id)).to.deep.equal(["ozeegay-lookalike"]);
  });
});

describe("Deployment reconciliation (CreateReserveStepError)", () => {
  it("carries the exact failing step and derived addresses -- fixes a real React stale-closure bug", () => {
    // The prior implementation read React's `createStep` state from inside
    // an async function's catch block, which always saw the value from
    // BEFORE the submission started (state updates never mutate a running
    // closure's local binding) -- so every failure reported as "(setup)"
    // regardless of which step actually failed, and the "already created
    // on-chain, don't retry" branch could never trigger. Carrying `step` on
    // the thrown error itself sidesteps the closure entirely.
    const addr = { reserveId: 42n, reserve: "R" as never, reserveTokenMint: "M" as never, mintAuthority: "A" as never, vaultAuthority: "V" as never, protocolConfig: "P" as never };
    const err = new CreateReserveStepError("Blockhash not found", "create-and-register", addr);
    expect(err.step).to.equal("create-and-register");
    expect(err.addresses).to.equal(addr);
    expect(err.message).to.equal("Blockhash not found");
  });
});

describe("Deployment-in-progress persistence (survives a reload mid-flight)", () => {
  // ts-mocha runs under plain Node, which has no `localStorage` global --
  // shim a minimal in-memory version for this test file only so the real
  // save/read/clear round-trip logic (not just its try/catch fallback) gets
  // genuine coverage.
  before(() => {
    const store = new Map<string, string>();
    (global as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as Storage;
  });

  afterEach(() => clearPendingReserveDeploy());

  const SAMPLE_ASSETS = [{ mint: "MintX", decimals: 6, seedWeightFraction: 1 }];

  it("round-trips a saved marker for the matching wallet", () => {
    savePendingReserveDeploy({ wallet: "WalletA", reserve: "ReserveA", reserveId: "1", name: "Test", ticker: "TST", startedAt: Date.now(), assets: SAMPLE_ASSETS, seedTotalUsd: 10 });
    const read = readPendingReserveDeploy("WalletA");
    expect(read?.reserve).to.equal("ReserveA");
    expect(read?.assets).to.deep.equal(SAMPLE_ASSETS);
  });

  it("never returns a marker for a different wallet", () => {
    savePendingReserveDeploy({ wallet: "WalletA", reserve: "ReserveA", reserveId: "1", name: "Test", ticker: "TST", startedAt: Date.now(), assets: SAMPLE_ASSETS, seedTotalUsd: 10 });
    expect(readPendingReserveDeploy("WalletB")).to.equal(null);
  });

  it("has NO time-based expiry -- a real half-built Reserve stays resumable no matter how old the marker is (see createReserveResume.ts's isPendingDeployStale doc comment for why an earlier 10-minute cutoff was removed)", () => {
    savePendingReserveDeploy({
      wallet: "WalletA",
      reserve: "ReserveA",
      reserveId: "1",
      name: "Test",
      ticker: "TST",
      startedAt: Date.now() - 7 * 24 * 60 * 60 * 1000, // a week old
      assets: SAMPLE_ASSETS,
      seedTotalUsd: 10,
    });
    expect(readPendingReserveDeploy("WalletA")?.reserve).to.equal("ReserveA");
  });

  it("treats a marker written by a pre-resumability version of this app (no assets array) as absent rather than resumable", () => {
    savePendingReserveDeploy({ wallet: "WalletA", reserve: "ReserveA", reserveId: "1", name: "Test", ticker: "TST", startedAt: Date.now() } as never);
    expect(readPendingReserveDeploy("WalletA")).to.equal(null);
  });

  it("clearPendingReserveDeploy removes it", () => {
    savePendingReserveDeploy({ wallet: "WalletA", reserve: "ReserveA", reserveId: "1", name: "Test", ticker: "TST", startedAt: Date.now(), assets: SAMPLE_ASSETS, seedTotalUsd: 10 });
    clearPendingReserveDeploy();
    expect(readPendingReserveDeploy("WalletA")).to.equal(null);
  });
});
