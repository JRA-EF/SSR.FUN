// Basket quick-fill helpers (DEC-0203) -- the direct-deposit-split idea for
// Create Reserve: set a few weights by hand, then let a button do the
// arithmetic that makes the column add up.
//
// The reason these are integer-bps and not float arithmetic is the whole
// point of the tests below: three assets split evenly in floats give
// 33.3/33.3/33.3 = 99.9%, the form refuses to submit, and every row still
// *displays* correctly, so the user cannot see which one is wrong.
import { expect } from "chai";
import { TOTAL_BPS, assignRemainder, clearAll, isFullyAllocated, splitEvenly, toBps, toWeight, unallocatedBps } from "../src/merge/lib/basketAllocation";

const pct = (w: number) => +(w * 100).toFixed(4);

describe("basket quick-fill -- conversions", () => {
  it("rounds a fractional weight to bps and back, clamping out-of-range values", () => {
    expect(toBps(0.1)).to.equal(1000);
    expect(toBps(1)).to.equal(TOTAL_BPS);
    expect(toBps(1.5)).to.equal(TOTAL_BPS);
    expect(toBps(-1)).to.equal(0);
    expect(toBps(Number.NaN)).to.equal(0);
    expect(toWeight(2500)).to.equal(0.25);
  });

  it("reports what is left, and never a negative for an over-allocated basket", () => {
    expect(unallocatedBps([0.1, 0.1, 0.1])).to.equal(7000);
    expect(unallocatedBps([])).to.equal(TOTAL_BPS);
    expect(unallocatedBps([0.6, 0.6])).to.equal(0);
  });
});

describe('"Rest" -- give one asset everything unallocated', () => {
  it("THE CASE FROM THE SCREENSHOT: three assets at 10% each, Rest on one takes it to exactly 100%", () => {
    const weights = [0.1, 0.1, 0.1];
    const out = assignRemainder(weights, 2);
    expect(pct(out[0])).to.equal(10);
    expect(pct(out[1])).to.equal(10);
    expect(pct(out[2])).to.equal(80); // 10 + the 70 that was unallocated
    expect(isFullyAllocated(out)).to.equal(true);
    expect(weights).to.deep.equal([0.1, 0.1, 0.1]); // input untouched
  });

  it("adds to what the asset already has rather than replacing it", () => {
    const out = assignRemainder([0.25, 0.25], 0);
    expect(pct(out[0])).to.equal(75);
    expect(pct(out[1])).to.equal(25);
  });

  it("is a no-op when the basket is already full -- never silently re-rounds the other rows", () => {
    const full = [0.5, 0.5];
    expect(assignRemainder(full, 0)).to.equal(full);
  });

  it("ignores an out-of-range index instead of corrupting the basket", () => {
    const w = [0.1];
    expect(assignRemainder(w, 5)).to.equal(w);
    expect(assignRemainder(w, -1)).to.equal(w);
  });
});

describe('"Split evenly" -- equal shares that actually sum to 100%', () => {
  it("THE FLOAT TRAP: three assets sum to exactly 100%, not 99.9%", () => {
    const out = splitEvenly(3);
    expect(isFullyAllocated(out)).to.equal(true);
    // The leftover basis point goes to the first row, visibly, rather than
    // being dropped: 33.34 / 33.33 / 33.33.
    expect(out.map(pct)).to.deep.equal([33.34, 33.33, 33.33]);
  });

  it("sums to exactly 100% for every basket size the picker allows", () => {
    for (let n = 1; n <= 12; n++) {
      const out = splitEvenly(n);
      expect(out.length, `n=${n}`).to.equal(n);
      expect(isFullyAllocated(out), `n=${n} sums to 100%`).to.equal(true);
    }
  });

  it("a single asset takes the whole basket; zero assets produce nothing", () => {
    expect(splitEvenly(1).map(pct)).to.deep.equal([100]);
    expect(splitEvenly(0)).to.deep.equal([]);
    expect(splitEvenly(-3)).to.deep.equal([]);
  });

  it("never gives any asset a share differing from another by more than one basis point", () => {
    const out = splitEvenly(7).map(toBps);
    expect(Math.max(...out) - Math.min(...out)).to.be.at.most(1);
  });
});

describe('"Clear"', () => {
  it("zeroes every asset, leaving the whole basket unallocated in USDC", () => {
    const out = clearAll(3);
    expect(out).to.deep.equal([0, 0, 0]);
    expect(unallocatedBps(out)).to.equal(TOTAL_BPS);
    expect(isFullyAllocated(out)).to.equal(false);
  });
});
