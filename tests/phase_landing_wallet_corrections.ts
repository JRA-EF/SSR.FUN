// Offline, pure-logic regression coverage for the landing-page/wallet/
// DevNet-token-model correction pass (Featured Reserve re-sourcing, the
// removed Portfolio mockX/Y/Z faucet button, and the wallet panel's balance
// read). Matches this repo's existing testing split -- pure logic covered
// here offline; DOM-only behavior (wallet panel opens instead of
// disconnecting, CTA copy, How It Works rendering) has no component-test
// framework in this repo and is verified manually via the dev server
// instead (see docs/project/PROJECT_STATUS.md for that pass's record).
import { expect } from "chai";
import type { DTR } from "../src/merge/lib/types";
import { buildReserveCardProps, selectFeaturedReserves } from "../src/merge/lib/reserveCardProps";
import { DEVNET_FIXTURES, DEVUSDC } from "../packages/sdk/src";

function makeDtr(overrides: Partial<DTR> & { id: string }): DTR {
  return {
    id: overrides.id,
    name: overrides.id,
    ticker: overrides.id.toUpperCase(),
    description: "",
    category: "DevNet Test",
    tags: [],
    logoSeed: overrides.id,
    dtrAddress: "AAA",
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
    onChain: undefined,
    ...overrides,
  };
}

function makeOnChainDtr(id: string, aum: number): DTR {
  return makeDtr({
    id,
    aum,
    onChain: {
      programId: "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
      reserveId: "0",
      reserve: "AAA",
      reserveTokenMint: "11111111111111111111111111111111",
      mintAuthority: "11111111111111111111111111111111",
      vaultAuthority: "11111111111111111111111111111111",
      manager: "11111111111111111111111111111111",
      assets: [],
      status: "active",
      totalTargetWeightBps: 10_000,
      reserveTokenSupplyRaw: "0",
      vaultBalancesRaw: {},
    },
  });
}

describe("Landing-page correction -- Featured Reserve sourcing (selectFeaturedReserves)", () => {
  it("never selects a simulated/non-onChain DTR, even one with a far larger AUM", () => {
    const simulatedBig = makeDtr({ id: "sim-big", aum: 1_000_000, onChain: undefined });
    const genuineSmall = makeOnChainDtr("real-small", 500);
    const selected = selectFeaturedReserves([simulatedBig, genuineSmall]);
    expect(selected.map((d) => d.id)).to.deep.equal(["real-small"]);
  });

  it("orders genuine on-chain Reserves by AUM descending", () => {
    const a = makeOnChainDtr("a", 100);
    const b = makeOnChainDtr("b", 900);
    const c = makeOnChainDtr("c", 500);
    const selected = selectFeaturedReserves([a, b, c]);
    expect(selected.map((d) => d.id)).to.deep.equal(["b", "c", "a"]);
  });

  it("slices to the requested count", () => {
    const dtrs = [1, 2, 3, 4, 5].map((n) => makeOnChainDtr(`d${n}`, n));
    expect(selectFeaturedReserves(dtrs, 3)).to.have.length(3);
  });

  it("returns an empty list (never a fictional fallback) when nothing is genuinely on-chain", () => {
    const dtrs = [makeDtr({ id: "sim1", aum: 10 }), makeDtr({ id: "sim2", aum: 20 })];
    expect(selectFeaturedReserves(dtrs)).to.deep.equal([]);
  });
});

describe("Landing-page correction -- shared card props (buildReserveCardProps)", () => {
  it("computes a positive premium/discount sign when token price trades above NAV", () => {
    const dtr = makeOnChainDtr("premium-case", 1000);
    dtr.tokenPrice = 1.1;
    dtr.nav = 1.0;
    const props = buildReserveCardProps(dtr);
    const prem = props.metrics.find((m) => m.key === "prem")!;
    expect(prem.tone).to.equal("up");
    expect(prem.value.startsWith("+")).to.equal(true);
  });

  it("orders topAssets by weight descending and caps at 3", () => {
    const dtr = makeOnChainDtr("weighted", 1000);
    dtr.composition = [
      { symbol: "A", name: "A", weight: 0.1 },
      { symbol: "B", name: "B", weight: 0.5 },
      { symbol: "C", name: "C", weight: 0.2 },
      { symbol: "D", name: "D", weight: 0.2 },
    ];
    const props = buildReserveCardProps(dtr);
    expect(props.topAssets).to.have.length(3);
    expect(props.topAssets[0]).to.equal("B");
  });

  it("labels a genuine on-chain Reserve distinctly from a simulated one", () => {
    const onChain = buildReserveCardProps(makeOnChainDtr("real", 1));
    const simulated = buildReserveCardProps(makeDtr({ id: "sim", aum: 1, onChain: undefined }));
    expect(onChain.sourceBadge.tone).to.equal("onchain");
    expect(simulated.sourceBadge.tone).to.equal("simulated");
  });
});

describe("DevNet token model -- faucet/Reserve-Asset scope", () => {
  it("still registers mockX/Y/Z as genuine, selectable Reserve Assets (Create + vault seeding), not removed alongside the Portfolio faucet button", () => {
    const symbols = Object.values(DEVNET_FIXTURES.mints).map((m) => m.symbol.toLowerCase());
    expect(symbols.some((s) => s.includes("mockx"))).to.equal(true);
    expect(symbols.some((s) => s.includes("mocky"))).to.equal(true);
    expect(symbols.some((s) => s.includes("mockz"))).to.equal(true);
  });

  it("devUSDC is a distinct mint from every mockX/Y/Z fixture (never conflated as the same asset)", () => {
    const fixtureMints = new Set(Object.values(DEVNET_FIXTURES.mints).map((m) => m.address));
    expect(fixtureMints.has(DEVUSDC.mint)).to.equal(false);
  });
});
