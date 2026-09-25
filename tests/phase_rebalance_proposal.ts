// Pure-logic regression coverage for how the Manager Dashboard -> Rebalance
// tab derives and normalises its proposed composition
// (src/merge/lib/rebalanceProposal.ts). No React/RPC, consistent with
// tests/phase_rebalance_slider.ts.
//
// The reported bug: the Proposed Total "readjusting automatically to 200%".
// The old fill-gaps-only seeding kept a weight copied from a stale or
// partial on-chain read and ADDED a later-appearing asset's real weight on
// top. Every case here pins the invariant the tab now guarantees: after any
// on-chain read the proposal is exactly 100% whenever the chain is fully
// visible, and an in-progress edit survives a poll that changes nothing.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_rebalance_proposal.ts
import { expect } from "chai";
import { normalizeProposal, reseedProposal, TOTAL_BPS } from "../src/merge/lib/rebalanceProposal";
import { applySliderWeightChange } from "../src/merge/lib/rebalanceSlider";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SSR = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";
const AAPL = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const TSLA = "XsDoVfqeBukxuZHWZdqRxcHGJHCw8jzXf3cEDZ1zcgb";
const sum = (m: Record<string, number>) => Object.values(m).reduce((s, v) => s + v, 0);

describe("reseedProposal -- the proposal after an on-chain read", () => {
  it("first load of ALPHA (SSR 0 / USDC 100 on-chain) is exactly the on-chain targets", () => {
    const r = reseedProposal({}, [{ mint: SSR, weightBps: 0 }, { mint: USDC, weightBps: 10_000 }], {}, USDC, true);
    expect(r.weights).to.deep.equal({ [SSR]: 0, [USDC]: 10_000 });
    expect(r.chainSeen).to.deep.equal({ [SSR]: 0, [USDC]: 10_000 });
  });

  it("THE 200% BUG: a stale 100% cash-slot seed plus a newly-appearing 100% asset no longer adds up -- the chain wins", () => {
    // Seeded from a snapshot taken before the Manager's rebalance moved
    // everything into AAPLx; the live read then shows AAPLx at 100%.
    const stale = { [SSR]: 0, [USDC]: 10_000 };
    const seen = { [SSR]: 0, [USDC]: 10_000 };
    const r = reseedProposal(stale, [{ mint: SSR, weightBps: 0 }, { mint: USDC, weightBps: 0 }, { mint: AAPL, weightBps: 10_000 }], seen, USDC, true);
    expect(r.weights).to.deep.equal({ [SSR]: 0, [USDC]: 0, [AAPL]: 10_000 });
    expect(sum(r.weights)).to.equal(TOTAL_BPS);
  });

  it("THE 200% BUG, other order: a partial read seeds no slack, and the missing asset then resolves cleanly", () => {
    const partial = reseedProposal({}, [{ mint: USDC, weightBps: 0 }], {}, USDC, /* resolvedFully */ false);
    expect(partial.weights).to.deep.equal({ [USDC]: 0 }); // no invented weight while an asset is unresolved
    const full = reseedProposal(partial.weights, [{ mint: USDC, weightBps: 0 }, { mint: AAPL, weightBps: 10_000 }], partial.chainSeen, USDC, true);
    expect(full.weights).to.deep.equal({ [USDC]: 0, [AAPL]: 10_000 });
  });

  it("an in-progress edit survives a poll that re-reports the same on-chain targets -- sliders never snap back on their own", () => {
    const editing = { [SSR]: 7_000, [USDC]: 3_000 };
    const seen = { [SSR]: 0, [USDC]: 10_000 };
    const r = reseedProposal(editing, [{ mint: SSR, weightBps: 0 }, { mint: USDC, weightBps: 10_000 }], seen, USDC, true);
    expect(r.weights).to.deep.equal(editing);
  });

  it("an in-progress edit also survives a poll that momentarily fails to resolve one asset (presence flapping)", () => {
    const editing = { [SSR]: 7_000, [USDC]: 3_000 };
    const seen = { [SSR]: 0, [USDC]: 10_000 };
    const flap = reseedProposal(editing, [{ mint: USDC, weightBps: 10_000 }], seen, USDC, false);
    expect(flap.weights).to.deep.equal(editing);
    const back = reseedProposal(flap.weights, [{ mint: SSR, weightBps: 0 }, { mint: USDC, weightBps: 10_000 }], flap.chainSeen, USDC, true);
    expect(back.weights).to.deep.equal(editing);
  });

  it("keeps an asset added this session at its proposed weight and re-balances the on-chain rows that really changed around it", () => {
    // Manager added TSLAx at 40% before a peer's rebalance landed on-chain.
    const prev = { [SSR]: 0, [USDC]: 6_000, [TSLA]: 4_000 };
    const seen = { [SSR]: 0, [USDC]: 10_000 };
    const r = reseedProposal(prev, [{ mint: SSR, weightBps: 5_000 }, { mint: USDC, weightBps: 5_000 }], seen, USDC, true);
    expect(r.weights[TSLA]).to.equal(4_000);
    expect(r.weights[SSR]).to.equal(5_000);
    expect(r.weights[USDC]).to.equal(1_000); // the excess came out of the cash slot first
    expect(sum(r.weights)).to.equal(TOTAL_BPS);
  });

  it("always includes the cash slot, at 0%, when the Reserve does not hold it -- so every edit has somewhere to move weight", () => {
    const r = reseedProposal({}, [{ mint: AAPL, weightBps: 5_000 }, { mint: TSLA, weightBps: 5_000 }], {}, USDC, true);
    expect(r.weights).to.deep.equal({ [AAPL]: 5_000, [TSLA]: 5_000, [USDC]: 0 });
  });

  it("an on-chain composition below 100% (slack) fills the cash slot, never a random asset", () => {
    const r = reseedProposal({}, [{ mint: SSR, weightBps: 3_000 }, { mint: USDC, weightBps: 2_000 }], {}, USDC, true);
    expect(r.weights).to.deep.equal({ [SSR]: 3_000, [USDC]: 7_000 });
  });

  it("an asset the Manager took out of the list is pinned at 0 across a re-seed, and its weight goes to the cash slot", () => {
    const r = reseedProposal({}, [{ mint: SSR, weightBps: 5_000 }, { mint: USDC, weightBps: 5_000 }], {}, USDC, true, new Set([SSR]));
    expect(r.weights).to.deep.equal({ [SSR]: 0, [USDC]: 10_000 });
  });

  it("with the chain unresolved the proposal is NOT normalised (Submit is disabled by the page) -- no invented weights", () => {
    const r = reseedProposal({}, [{ mint: SSR, weightBps: 2_500 }], {}, USDC, false);
    expect(r.weights).to.deep.equal({ [SSR]: 2_500, [USDC]: 0 });
  });
});

describe("normalizeProposal -- exactly 10,000 bps, integer, cash slot first", () => {
  it("returns the same array when already 100%", () => {
    const rows = [{ mint: SSR, weightBps: 4_000 }, { mint: USDC, weightBps: 6_000 }];
    expect(normalizeProposal(rows, USDC)).to.equal(rows);
  });

  it("an excess above the cash slot's balance is then taken proportionally from the others", () => {
    const rows = [{ mint: SSR, weightBps: 10_000 }, { mint: AAPL, weightBps: 10_000 }, { mint: USDC, weightBps: 1_000 }];
    const r = normalizeProposal(rows, USDC);
    expect(r.map((a) => a.weightBps)).to.deep.equal([5_000, 5_000, 0]);
  });

  it("a shortfall with a frozen cash slot is spread across the unfrozen assets, equally when they are all zero", () => {
    const rows = [{ mint: SSR, weightBps: 0 }, { mint: AAPL, weightBps: 0 }, { mint: USDC, weightBps: 0 }];
    const r = normalizeProposal(rows, USDC, new Set([USDC]));
    expect(r.map((a) => a.weightBps)).to.deep.equal([5_000, 5_000, 0]);
  });

  it("never drifts off 10,000 on awkward splits (integer rounding is settled one bps at a time)", () => {
    const rows = [{ mint: SSR, weightBps: 3_333 }, { mint: AAPL, weightBps: 3_333 }, { mint: TSLA, weightBps: 3_333 }, { mint: USDC, weightBps: 3_333 }];
    const r = normalizeProposal(rows, USDC);
    expect(r.reduce((s, a) => s + a.weightBps, 0)).to.equal(TOTAL_BPS);
    expect(r.every((a) => a.weightBps >= 0)).to.equal(true);
  });
});

describe("taking an asset out of the list (trash icon) reuses the slider model", () => {
  it("removing a non-cash asset hands its whole weight to the cash slot and leaves the other assets untouched", () => {
    const rows = [{ mint: SSR, weightBps: 3_000 }, { mint: AAPL, weightBps: 3_000 }, { mint: USDC, weightBps: 4_000 }];
    const r = applySliderWeightChange(rows, AAPL, 0, USDC);
    expect(r.map((a) => a.weightBps)).to.deep.equal([3_000, 0, 7_000]);
  });

  it("removing the cash slot itself spreads its weight across the other assets in proportion", () => {
    const rows = [{ mint: SSR, weightBps: 1_000 }, { mint: AAPL, weightBps: 3_000 }, { mint: USDC, weightBps: 6_000 }];
    const r = applySliderWeightChange(rows, USDC, 0, USDC);
    expect(r.map((a) => a.weightBps)).to.deep.equal([2_500, 7_500, 0]);
  });

  it("a removed asset never regains weight from later slider edits once the page leaves it out of the model", () => {
    const rows = [{ mint: AAPL, weightBps: 0 }, { mint: USDC, weightBps: 10_000 }];
    const r = applySliderWeightChange(rows, USDC, 4_000, USDC);
    expect(r.map((a) => a.weightBps)).to.deep.equal([6_000, 4_000]);
  });
});
