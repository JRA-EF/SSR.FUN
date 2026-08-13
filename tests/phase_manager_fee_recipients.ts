// Offline, pure-logic regression coverage for DEC-0094 (SSR.fun
// Protocol/Manager fee-split formula + up to 10 Manager fee recipients).
// Matches this repo's existing testing split -- pure logic covered here
// offline; the live on-chain evidence (real DevNet signatures, before/after
// balances) is recorded in docs/protocol/DEVNET_FEE_RECIPIENTS_CHECKLIST_*.md
// and this pass's docs/project/DECISION_LOG.md entry instead.
import { expect } from "chai";
import {
  computeEffectiveFeeSplit,
  splitTotalFee,
  apportionToRecipients,
  validateFeeRecipientInputs,
  PROTOCOL_MIN_MINT_FEE_BPS,
  PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS,
  MAX_FEE_RECIPIENTS,
  type FeeRecipientAllocation,
} from "../packages/sdk/src/feeMath";
import { mulDivCeil, BPS_DENOMINATOR } from "../packages/sdk/src/calculations";

// The task's own table, applied independently to Mint and TVL (both floors are 0.5% today).
const TASK_TABLE: { configuredPct: number; protocolPct: number; managerPct: number; effectiveTotalPct: number }[] = [
  { configuredPct: 0, protocolPct: 0.5, managerPct: 0, effectiveTotalPct: 0.5 },
  { configuredPct: 0.5, protocolPct: 0.5, managerPct: 0, effectiveTotalPct: 0.5 },
  { configuredPct: 1, protocolPct: 0.5, managerPct: 0.5, effectiveTotalPct: 1 },
  { configuredPct: 2, protocolPct: 1, managerPct: 1, effectiveTotalPct: 2 },
  { configuredPct: 5, protocolPct: 2.5, managerPct: 2.5, effectiveTotalPct: 5 },
];

function pctToBps(pct: number): bigint {
  return BigInt(Math.round(pct * 100));
}

describe("computeEffectiveFeeSplit (packages/sdk/src/feeMath.ts) -- DEC-0094 formula", () => {
  for (const floorName of ["mint", "tvl"] as const) {
    const floorBps = floorName === "mint" ? PROTOCOL_MIN_MINT_FEE_BPS : PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS;

    describe(`applied to the ${floorName} fee (floor ${floorBps} bps)`, () => {
      for (const row of TASK_TABLE) {
        it(`configured ${row.configuredPct}% -> Protocol ${row.protocolPct}% / Manager ${row.managerPct}% / effective total ${row.effectiveTotalPct}%`, () => {
          const split = computeEffectiveFeeSplit(pctToBps(row.configuredPct), floorBps);
          expect(split.protocolBps).to.equal(pctToBps(row.protocolPct));
          expect(split.managerBps).to.equal(pctToBps(row.managerPct));
          expect(split.effectiveTotalBps).to.equal(pctToBps(row.effectiveTotalPct));
        });
      }

      it("effective total never falls below the Protocol minimum, for any configured rate from 0 to 10%", () => {
        for (let bps = 0n; bps <= 1000n; bps += 7n) {
          const split = computeEffectiveFeeSplit(bps, floorBps);
          expect(split.effectiveTotalBps).to.be.at.least(floorBps);
          expect(split.protocolBps).to.be.at.least(floorBps);
          expect(split.protocolBps + split.managerBps).to.equal(split.effectiveTotalBps);
        }
      });

      it("effective total never falls below the configured rate (the floor can only raise it, never lower it)", () => {
        for (let bps = 0n; bps <= 1000n; bps += 3n) {
          const split = computeEffectiveFeeSplit(bps, floorBps);
          expect(split.effectiveTotalBps).to.be.at.least(bps);
        }
      });
    });
  }
});

describe("splitTotalFee (packages/sdk/src/feeMath.ts) -- exact protocol/manager split of an already-assessed total", () => {
  it("splits a total exactly, manager floor-rounded, protocol as the exact remainder, for an odd total", () => {
    const split = computeEffectiveFeeSplit(pctToBps(5), PROTOCOL_MIN_MINT_FEE_BPS); // 250/250
    const { protocolTotal, managerTotal } = splitTotalFee(985_341n, split.protocolBps, split.managerBps);
    expect(protocolTotal + managerTotal).to.equal(985_341n);
    expect(managerTotal).to.equal(492_670n); // floor(985341 * 250 / 500)
    expect(protocolTotal).to.equal(492_671n);
  });

  it("divides by the EFFECTIVE total bps, not BPS_DENOMINATOR -- the DEC-0094 divisor correction", () => {
    // configured=200bps -> protocol=100, manager=100 (sum=200, NOT 10000).
    const split = computeEffectiveFeeSplit(200n, PROTOCOL_MIN_MINT_FEE_BPS);
    expect(split.protocolBps + split.managerBps).to.equal(200n);
    const total = mulDivCeil(1_000_000n, split.effectiveTotalBps, BPS_DENOMINATOR); // 20,000
    const { protocolTotal, managerTotal } = splitTotalFee(total, split.protocolBps, split.managerBps);
    expect(protocolTotal).to.equal(managerTotal); // 100/100 is an even split
    expect(protocolTotal + managerTotal).to.equal(total);
  });

  it("is exact across a sweep of totals and configured rates", () => {
    for (const configuredPct of [0, 0.25, 0.5, 1, 1.5, 2, 3.33, 5]) {
      const split = computeEffectiveFeeSplit(pctToBps(configuredPct), PROTOCOL_MIN_MINT_FEE_BPS);
      for (const total of [0n, 1n, 7n, 999n, 1_000_000n, 123_456_789n]) {
        const { protocolTotal, managerTotal } = splitTotalFee(total, split.protocolBps, split.managerBps);
        expect(protocolTotal + managerTotal).to.equal(total);
        expect(protocolTotal).to.be.at.least(0n);
        expect(managerTotal).to.be.at.least(0n);
      }
    }
  });
});

function recipients(bpsList: number[]): FeeRecipientAllocation[] {
  return bpsList.map((allocationBps, i) => ({ wallet: `wallet-${i}`, allocationBps: BigInt(allocationBps) }));
}

describe("apportionToRecipients (packages/sdk/src/feeMath.ts) -- largest-remainder apportionment", () => {
  it("1 recipient at 100% gets the entire manager total", () => {
    const increments = apportionToRecipients(777_777n, recipients([10_000]));
    expect(increments).to.deep.equal([777_777n]);
  });

  it("2 recipients at an even 50/50 split", () => {
    const increments = apportionToRecipients(1_000_000n, recipients([5_000, 5_000]));
    expect(increments).to.deep.equal([500_000n, 500_000n]);
    expect(increments[0] + increments[1]).to.equal(1_000_000n);
  });

  it("3 recipients (34/33/33) with an indivisible total -- remainder goes to the largest-fraction recipient(s), never lost", () => {
    const increments = apportionToRecipients(100n, recipients([3_400, 3_300, 3_300]));
    expect(increments.reduce((a, b) => a + b, 0n)).to.equal(100n);
    // 100*3400/10000=34, 100*3300/10000=33 (x2) -> floors sum to 100 exactly already, no leftover to distribute.
    expect(increments).to.deep.equal([34n, 33n, 33n]);
  });

  it("10 recipients (MAX_FEE_RECIPIENTS) at 10% each, exact sum with a non-multiple-of-10 total", () => {
    expect(MAX_FEE_RECIPIENTS).to.equal(10);
    const bpsList = new Array(10).fill(1_000);
    const increments = apportionToRecipients(1_000_003n, recipients(bpsList));
    expect(increments.length).to.equal(10);
    expect(increments.reduce((a, b) => a + b, 0n)).to.equal(1_000_003n);
    // 1,000,003 / 10 = 100,000 remainder 3 -- exactly 3 recipients get +1.
    const plusOneCount = increments.filter((x) => x === 100_001n).length;
    expect(plusOneCount).to.equal(3);
    const baseCount = increments.filter((x) => x === 100_000n).length;
    expect(baseCount).to.equal(7);
  });

  it("uneven allocations (60/25/15) sum exactly for an arbitrary total", () => {
    const increments = apportionToRecipients(999_997n, recipients([6_000, 2_500, 1_500]));
    expect(increments.reduce((a, b) => a + b, 0n)).to.equal(999_997n);
  });

  it("zero manager total yields zero for every recipient", () => {
    const increments = apportionToRecipients(0n, recipients([5_000, 3_000, 2_000]));
    expect(increments).to.deep.equal([0n, 0n, 0n]);
  });

  it("exhaustive sweep: 1 through 10 recipients, many totals, always sums exactly with no negative increment", () => {
    for (let count = 1; count <= 10; count++) {
      const base = Math.floor(10_000 / count);
      const bpsList = new Array(count).fill(base);
      bpsList[0] += 10_000 - bpsList.reduce((a: number, b: number) => a + b, 0);
      const recipientAllocations = recipients(bpsList);
      for (const total of [0n, 1n, 7n, 100n, 999n, 1_000_000n, 123_456_789n]) {
        const increments = apportionToRecipients(total, recipientAllocations);
        expect(increments.reduce((a, b) => a + b, 0n)).to.equal(total);
        for (const inc of increments) expect(inc).to.be.at.least(0n);
      }
    }
  });
});

describe("validateFeeRecipientInputs (packages/sdk/src/feeMath.ts) -- client-side mirror of the on-chain validation", () => {
  it("accepts 1 recipient at 100%", () => {
    expect(() => validateFeeRecipientInputs([{ wallet: "A", allocationBps: 10_000 }])).to.not.throw();
  });

  it("accepts 10 recipients (the maximum) summing to exactly 100%", () => {
    const list = new Array(10).fill(0).map((_, i) => ({ wallet: `wallet-${i}`, allocationBps: 1_000 }));
    expect(() => validateFeeRecipientInputs(list)).to.not.throw();
  });

  it("rejects an 11th recipient", () => {
    const list = new Array(11).fill(0).map((_, i) => ({ wallet: `wallet-${i}`, allocationBps: Math.floor(10_000 / 11) }));
    expect(() => validateFeeRecipientInputs(list)).to.throw(/between 1 and 10/);
  });

  it("rejects zero recipients", () => {
    expect(() => validateFeeRecipientInputs([])).to.throw(/between 1 and 10/);
  });

  it("rejects a duplicate wallet", () => {
    expect(() =>
      validateFeeRecipientInputs([
        { wallet: "A", allocationBps: 5_000 },
        { wallet: "A", allocationBps: 5_000 },
      ]),
    ).to.throw(/duplicate/i);
  });

  it("rejects a zero-value allocation", () => {
    expect(() =>
      validateFeeRecipientInputs([
        { wallet: "A", allocationBps: 10_000 },
        { wallet: "B", allocationBps: 0 },
      ]),
    ).to.throw(/zero/i);
  });

  it("rejects the default/zero address", () => {
    expect(() => validateFeeRecipientInputs([{ wallet: "11111111111111111111111111111111", allocationBps: 10_000 }])).to.throw(/zero address/i);
  });

  it("rejects allocations summing below 100%", () => {
    expect(() =>
      validateFeeRecipientInputs([
        { wallet: "A", allocationBps: 4_000 },
        { wallet: "B", allocationBps: 4_000 },
      ]),
    ).to.throw(/10,000/);
  });

  it("rejects allocations summing above 100%", () => {
    expect(() =>
      validateFeeRecipientInputs([
        { wallet: "A", allocationBps: 6_000 },
        { wallet: "B", allocationBps: 6_000 },
      ]),
    ).to.throw(/10,000/);
  });
});

describe("Full chain: mint fee assessed -> protocol/manager split -> recipient apportionment, exact end to end (DEC-0094)", () => {
  it("protocol credit plus every recipient credit always equals the total fee assessed", () => {
    const recipientBpsSets = [[10_000], [6_000, 4_000], [3_400, 3_300, 3_300], new Array(10).fill(1_000)];
    for (const bpsList of recipientBpsSets) {
      const recipientAllocations = recipients(bpsList);
      for (const configuredPct of [0, 0.5, 1, 2, 5]) {
        const split = computeEffectiveFeeSplit(pctToBps(configuredPct), PROTOCOL_MIN_MINT_FEE_BPS);
        for (const reserveTokensRequested of [1n, 3n, 1_000n, 987_654n, 999_999_999n]) {
          const totalFeeShares = mulDivCeil(reserveTokensRequested, split.effectiveTotalBps, BPS_DENOMINATOR);
          const { protocolTotal, managerTotal } = splitTotalFee(totalFeeShares, split.protocolBps, split.managerBps);
          const increments = apportionToRecipients(managerTotal, recipientAllocations);
          const recipientSum = increments.reduce((a, b) => a + b, 0n);
          expect(recipientSum).to.equal(managerTotal);
          expect(protocolTotal + recipientSum).to.equal(totalFeeShares);
        }
      }
    }
  });
});
