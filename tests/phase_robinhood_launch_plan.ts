// The Robinhood Chain launch arithmetic (src/merge/lib/evmLaunchPlan.ts):
// weights + one USDG amount -> legs that sum exactly to the seed, 1:1
// initial shares, the Folio's fee-recipient list in the shape the contract
// requires, and the effective protocol/manager split. All offline.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_robinhood_launch_plan.ts
import { expect } from "chai";
import {
  D18,
  coManagersForChain,
  effectiveFeeSplit,
  estimateLaunchGas,
  feeRecipientsForChain,
  fmtUsdg,
  launchSteps,
  minOutAfterSlippage,
  parseUsdgAmount,
  percentToD18,
  planLaunch,
  priceImpactBps,
  type PlannedAsset,
} from "../src/merge/lib/evmLaunchPlan";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const POOL = { address: "0x125B0a9A5C091e2010b739422d0D8727D3A74E8F" as const, fee: 3000, quote: "USDG" as const };
const AAPL: PlannedAsset = { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", decimals: 18, weight: 0.6, pool: POOL };
const FIH: PlannedAsset = { address: "0x4b3A3FF4Ec9D289727e24A8152F406Bada44264D", symbol: "FIH", decimals: 18, weight: 0.3, pool: { address: "0x6c402550eB35Ef0cE7E442654E5431C6d15A1d13", fee: 10000, quote: "WETH" } };
const CASH: PlannedAsset = { address: USDG, symbol: "USDG", decimals: 6, weight: 0.1, pool: null };

describe("planLaunch -- one USDG amount, weights, legs that add up", () => {
  it("splits the seed by weight in bps and the legs sum to exactly the seed", () => {
    const plan = planLaunch([AAPL, FIH, CASH], parseUsdgAmount("10", 6), USDG, 6);
    expect(plan.legs.map((l) => [l.asset.symbol, l.kind, l.usdgRaw.toString()])).to.deep.equal([
      ["AAPL", "swap", "6000000"],
      ["FIH", "swap", "3000000"],
      ["USDG", "usdg", "1000000"],
    ]);
    expect(plan.legs.reduce((s, l) => s + l.usdgRaw, 0n)).to.equal(plan.seedUsdgRaw);
    expect(plan.swapUsdgRaw).to.equal(9_000_000n);
    expect(plan.directUsdgRaw).to.equal(1_000_000n);
  });

  it("mints initial shares 1:1 with the USDG put in (18 decimals from 6)", () => {
    const plan = planLaunch([AAPL, { ...CASH, weight: 0.4 }], parseUsdgAmount("12.5", 6), USDG, 6);
    expect(plan.initialShares).to.equal(12_500_000n * 10n ** 12n);
    expect(plan.initialShares).to.equal(125n * 10n ** 17n);
  });

  it("an unallocated remainder becomes (or tops up) the USDG cash leg, so the column still sums to the seed", () => {
    const plan = planLaunch([{ ...AAPL, weight: 0.25 }, { ...FIH, weight: 0.25 }], parseUsdgAmount("100", 6), USDG, 6);
    const cash = plan.legs.find((l) => l.kind === "usdg")!;
    expect(cash.usdgRaw).to.equal(50_000_000n);
    expect(cash.bps).to.equal(5000);
    expect(plan.legs.reduce((s, l) => s + l.usdgRaw, 0n)).to.equal(100_000_000n);
    // Rounding dust from an odd split lands on the cash leg, never lost.
    const odd = planLaunch([{ ...AAPL, weight: 1 / 3 }, { ...FIH, weight: 1 / 3 }, { ...CASH, weight: 1 / 3 }], 1_000_001n, USDG, 6);
    expect(odd.legs.reduce((s, l) => s + l.usdgRaw, 0n)).to.equal(1_000_001n);
  });

  it("refuses weights over 100%, duplicates, a zero seed, and a non-cash asset without a pool", () => {
    expect(() => planLaunch([{ ...AAPL, weight: 0.7 }, { ...FIH, weight: 0.4 }], 1_000_000n, USDG, 6)).to.throw(/exceed 100%/);
    expect(() => planLaunch([{ ...AAPL, weight: 0.3 }, { ...AAPL, weight: 0.3 }], 1_000_000n, USDG, 6)).to.throw(/listed twice/);
    expect(() => planLaunch([AAPL], 0n, USDG, 6)).to.throw(/greater than zero/);
    expect(() => planLaunch([{ ...AAPL, pool: null }], 1_000_000n, USDG, 6)).to.throw(/no Uniswap pool/);
    expect(() => parseUsdgAmount("abc", 6)).to.throw(/greater than zero/);
  });

  it("lists the wallet prompts in launch order, swaps before factory approvals before deploy", () => {
    const steps = launchSteps(planLaunch([AAPL, CASH], parseUsdgAmount("10", 6), USDG, 6));
    expect(steps[0]).to.match(/^Approve 6 USDG for the Uniswap router/);
    expect(steps[1]).to.match(/^Swap 6 USDG for AAPL/);
    expect(steps[2]).to.match(/^Approve AAPL for the SSR factory/);
    expect(steps[3]).to.match(/^Approve USDG for the SSR factory/);
    expect(steps[4]).to.match(/^Deploy the reserve/);
    expect(estimateLaunchGas(2, 1)).to.be.greaterThan(1_600_000n);
  });

  it("formats raw USDG without trailing zeros", () => {
    expect(fmtUsdg(6_000_000n, 6)).to.equal("6");
    expect(fmtUsdg(1_234_560n, 6)).to.equal("1.23456");
    expect(fmtUsdg(5n, 6)).to.equal("0.000005");
  });
});

describe("fees -- D18 conversions and the effective protocol/manager split", () => {
  it("percentToD18 / effectiveFeeSplit mirror SSRLib.computeMintFees (50% to the DAO, 0.5% floor)", () => {
    const num = 1n, den = 2n, floor = 5n * 10n ** 15n;
    expect(percentToD18(1)).to.equal(10n ** 16n);
    expect(percentToD18(0.5)).to.equal(5n * 10n ** 15n);
    // 2%: DAO 1%, manager 1%.
    expect(effectiveFeeSplit(percentToD18(2), num, den, floor)).to.deep.equal({ totalD18: 2n * 10n ** 16n, protocolD18: 10n ** 16n, managerD18: 10n ** 16n });
    // 0.5%: the floor binds -- the DAO takes all of it.
    expect(effectiveFeeSplit(percentToD18(0.5), num, den, floor)).to.deep.equal({ totalD18: floor, protocolD18: floor, managerD18: 0n });
    // 0%: the chain still charges the floor, to the DAO.
    expect(effectiveFeeSplit(0n, num, den, floor)).to.deep.equal({ totalD18: floor, protocolD18: floor, managerD18: 0n });
  });

  it("feeRecipientsForChain: primary takes the remainder, addresses strictly ascending, portions sum to 1e18", () => {
    const primary = "0xBBBBbbbbBBbBBbbBBbBBBbBBBBBBbbbBBbbbbBBb";
    const list = feeRecipientsForChain(primary, [
      { address: "0xcccccccccccccccccccccccccccccccccccccccc", pct: 25 },
      { address: "0x1111111111111111111111111111111111111111", pct: 10 },
    ]);
    expect(list.map((r) => r.recipient)).to.deep.equal(["0x1111111111111111111111111111111111111111", primary.toLowerCase(), "0xcccccccccccccccccccccccccccccccccccccccc"]);
    expect(list.map((r) => r.portion)).to.deep.equal([10n ** 17n, 65n * 10n ** 16n, 25n * 10n ** 16n]);
    expect(list.reduce((s, r) => s + r.portion, 0n)).to.equal(D18);
    for (let i = 1; i < list.length; i++) expect(BigInt(list[i].recipient) > BigInt(list[i - 1].recipient)).to.equal(true);
  });

  it("feeRecipientsForChain: a primary that is also an additional recipient is merged; 100% to others drops the primary; over 100% is refused", () => {
    const primary = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const merged = feeRecipientsForChain(primary, [{ address: primary.toUpperCase().replace("0X", "0x"), pct: 30 }]);
    expect(merged).to.deep.equal([{ recipient: primary, portion: D18 }]);
    const all = feeRecipientsForChain(primary, [{ address: "0xcccccccccccccccccccccccccccccccccccccccc", pct: 100 }]);
    expect(all).to.deep.equal([{ recipient: "0xcccccccccccccccccccccccccccccccccccccccc", portion: D18 }]);
    expect(() => feeRecipientsForChain(primary, [{ address: "0xcccccccccccccccccccccccccccccccccccccccc", pct: 101 }])).to.throw(/exceed 100%/);
    expect(() => feeRecipientsForChain("not-an-address", [])).to.throw(/valid 0x address/);
    expect(() => feeRecipientsForChain(primary, [{ address: "0x12", pct: 1 }])).to.throw(/not a valid 0x address/);
    expect(() => feeRecipientsForChain(primary, [{ address: "0xcccccccccccccccccccccccccccccccccccccccc", pct: 0 }])).to.throw(/greater than 0%/);
  });

  it("coManagersForChain: unique, valid, never the owner", () => {
    const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(coManagersForChain(owner, [owner, "0xcccccccccccccccccccccccccccccccccccccccc", "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"])).to.deep.equal(["0xcccccccccccccccccccccccccccccccccccccccc"]);
    expect(() => coManagersForChain(owner, ["nope"])).to.throw(/not a valid 0x address/);
  });
});

describe("swap protection", () => {
  it("minOutAfterSlippage takes 1% off the quote by default; priceImpactBps measures the shortfall against spot", () => {
    expect(minOutAfterSlippage(1_000_000n)).to.equal(990_000n);
    expect(minOutAfterSlippage(1_000_000n, 50)).to.equal(995_000n);
    expect(priceImpactBps(970n, 1000n)).to.equal(300);
    expect(priceImpactBps(1000n, 1000n)).to.equal(0);
    expect(priceImpactBps(1100n, 1000n)).to.equal(0);
    expect(priceImpactBps(5n, 0n)).to.equal(0);
  });
});

describe("the dollar's decimals come from the chain, not from a constant", () => {
  // Regression. USDG_DECIMALS was a module constant of 6. BNB's USDT and USDC
  // are both 18, so on that chain a 1,000-dollar seed parsed to 1e9 raw -- a
  // billionth of a dollar -- while still minting 1,000 shares, and the
  // price-impact guard's arithmetic was off by 1e12. Found on a BNB fork,
  // 2026-10-05; see docs/project/MULTICHAIN_RESERVES.md.
  const USDT18 = "0x55d398326f99059fF775485246999027B3197955" as const;
  const CASH18: PlannedAsset = { address: USDT18, symbol: "USDT", decimals: 18, weight: 0.1, pool: null };

  it("parses a seed at the chain's own precision, not always 6", () => {
    expect(parseUsdgAmount("1000", 6).toString()).to.equal("1000000000");
    expect(parseUsdgAmount("1000", 18).toString()).to.equal("1000000000000000000000");
    // 15 fractional digits, padded to 18 -- exact. The old float path
    // (Math.round(n * 10 ** 18)) could not represent this without drift.
    expect(parseUsdgAmount("1234.567891234567891", 18).toString()).to.equal("1234567891234567891000");
  });

  it("truncates beyond the token's precision instead of inventing digits", () => {
    expect(parseUsdgAmount("1.2345678", 6).toString()).to.equal("1234567");
  });

  it("mints one share per dollar on an 18-decimal chain, not 1e12 too many", () => {
    const seed = parseUsdgAmount("1000", 18);
    const plan = planLaunch([{ ...AAPL, weight: 0.9 }, CASH18], seed, USDT18, 18);
    expect(plan.seedUsdgRaw.toString(), "the seed is a real 1,000 dollars").to.equal("1000000000000000000000");
    expect(plan.initialShares.toString(), "1,000 shares at 18dp").to.equal("1000000000000000000000");
    expect(plan.usdDecimals).to.equal(18);
    // The legs must still sum to exactly the seed.
    expect(plan.legs.reduce((t, l) => t + l.usdgRaw, 0n)).to.equal(seed);
  });

  it("still mints one share per dollar on a 6-decimal chain", () => {
    const plan = planLaunch([{ ...AAPL, weight: 0.9 }, CASH], parseUsdgAmount("1000", 6), USDG, 6);
    expect(plan.initialShares.toString()).to.equal("1000000000000000000000");
  });

  it("formats balances at the chain's precision", () => {
    expect(fmtUsdg(1_000_000_000n, 6)).to.equal("1000");
    expect(fmtUsdg(1000n * 10n ** 18n, 18)).to.equal("1000");
  });

  it("refuses a dollar whose decimals the share maths cannot express", () => {
    expect(() => planLaunch([AAPL], 1n, USDG, 24)).to.throw(/cannot express/);
  });
});
