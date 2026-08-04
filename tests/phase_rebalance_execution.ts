// Pure-logic regression coverage for Phase 3 (on-chain rebalance execution)
// of the 2026-08-04 "complete the end-to-end SSR DevNet economy" corrective
// pass -- see docs/project/DECISION_LOG.md. The new execute_rebalance_leg
// Anchor instruction itself is NOT exercised here (cargo/anchor/solana are
// not on PATH in this environment, so it has never been built or deployed --
// see this pass's final report); this covers what CAN be verified offline:
// computeRebalancePlan, the pure client-side planner.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_rebalance_execution.ts
import { expect } from "chai";
import { computeRebalancePlan } from "../packages/sdk/src/rebalanceExecutionInstructions";

const MINT_A = "2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu"; // mockX
const MINT_B = "9ERxFYyuNTMjsduY24MCp1bvUDz7PkhoycjBx76Zh8Lv"; // mockY
const MINT_C = "GqNfJAmAMBVrYbJ3az38kBBrz8vyYdoFpwYmRBJd6zoS"; // mockZ

const PRICES = { [MINT_A]: 1, [MINT_B]: 1, [MINT_C]: 1 };

describe("computeRebalancePlan (packages/sdk/src/rebalanceExecutionInstructions.ts)", () => {
  it("plans zero legs when the Reserve is already exactly at its target weights", () => {
    const assets = [
      { mint: MINT_A, vaultBalanceRaw: "600000000", decimals: 6 }, // 600 units @ $1 = $600
      { mint: MINT_B, vaultBalanceRaw: "400000000", decimals: 6 }, // 400 units @ $1 = $400
    ];
    const plan = computeRebalancePlan(assets, [6000, 4000], PRICES); // 60/40, exactly matching
    expect(plan).to.deep.equal([]);
  });

  it("plans a single leg moving the overweight asset toward the underweight one, sized to the USD deviation", () => {
    const assets = [
      { mint: MINT_A, vaultBalanceRaw: "800000000", decimals: 6 }, // $800 -- overweight vs 50% target ($500)
      { mint: MINT_B, vaultBalanceRaw: "200000000", decimals: 6 }, // $200 -- underweight vs 50% target ($500)
    ];
    const plan = computeRebalancePlan(assets, [5000, 5000], PRICES);
    expect(plan.length).to.equal(1);
    expect(plan[0].mintSell).to.equal(MINT_A);
    expect(plan[0].mintBuy).to.equal(MINT_B);
    expect(plan[0].usdValue).to.be.closeTo(300, 1e-9); // moves exactly the $300 deviation
  });

  it("plans multiple legs for a 3-asset Reserve, always pairing the most-overweight with the most-underweight", () => {
    const assets = [
      { mint: MINT_A, vaultBalanceRaw: "900000000", decimals: 6 }, // $900 vs 33.3% target (~$400) -- most overweight
      { mint: MINT_B, vaultBalanceRaw: "300000000", decimals: 6 }, // $300 vs 33.3% target (~$400) -- roughly on target
      { mint: MINT_C, vaultBalanceRaw: "0", decimals: 9 }, // $0 vs 33.3% target (~$400) -- most underweight
    ];
    const plan = computeRebalancePlan(assets, [3334, 3333, 3333], PRICES);
    expect(plan.length).to.be.greaterThan(0);
    // Every leg must sell from the (currently) most-overweight asset toward
    // the (currently) most-underweight one -- the very first leg planned
    // must sell mockX (most overweight) and buy mockZ (most underweight).
    expect(plan[0].mintSell).to.equal(MINT_A);
    expect(plan[0].mintBuy).to.equal(MINT_C);
  });

  it("never plans a leg smaller than the given USD tolerance -- avoids proposing dust-sized trades", () => {
    const assets = [
      { mint: MINT_A, vaultBalanceRaw: "500001000", decimals: 6 }, // $500.001, a hair overweight
      { mint: MINT_B, vaultBalanceRaw: "499999000", decimals: 6 }, // $499.999, a hair underweight
    ];
    const plan = computeRebalancePlan(assets, [5000, 5000], PRICES, 0.01);
    expect(plan).to.deep.equal([]);
  });

  it("throws if assets and targetWeightsBps have mismatched lengths -- never silently ignores a caller error", () => {
    const assets = [{ mint: MINT_A, vaultBalanceRaw: "1000000", decimals: 6 }];
    expect(() => computeRebalancePlan(assets, [5000, 5000], PRICES)).to.throw();
  });

  it("throws for a mint with no configured test price, rather than silently treating it as worthless", () => {
    const assets = [{ mint: "UnknownMint11111111111111111111111111111", vaultBalanceRaw: "1000000", decimals: 6 }];
    expect(() => computeRebalancePlan(assets, [10000], PRICES)).to.throw();
  });

  it("handles a zero-total-AUM Reserve without dividing by zero or crashing", () => {
    const assets = [
      { mint: MINT_A, vaultBalanceRaw: "0", decimals: 6 },
      { mint: MINT_B, vaultBalanceRaw: "0", decimals: 6 },
    ];
    const plan = computeRebalancePlan(assets, [5000, 5000], PRICES);
    expect(plan).to.deep.equal([]);
  });
});
