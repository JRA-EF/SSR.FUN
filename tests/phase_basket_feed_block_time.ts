import { expect } from "chai";
import { recentBlockTime } from "../lib/mainnet/basketFeed";

describe("Basket feed chain time (2026-11-16: 'Block not available' for the newest confirmed slot)", () => {
  const conn = (answer: (slot: number) => number | null, asked: number[]) =>
    ({ getBlockTime: async (slot: number) => { asked.push(slot); const t = answer(slot); if (t === -1) throw new Error(`failed to get block time for slot ${slot}: Block not available for slot ${slot}`); return t; } });

  it("uses the newest slot's time when the block is served", async () => {
    const asked: number[] = [];
    expect(await recentBlockTime(conn(() => 1_794_000_000, asked), 500)).to.equal(1_794_000_000);
    expect(asked).to.deep.equal([500]);
  });
  it("steps back to an older slot when the newest block is not available yet", async () => {
    const asked: number[] = [];
    expect(await recentBlockTime(conn((s) => (s === 500 ? -1 : 1_794_000_000 - (500 - s)), asked), 500)).to.equal(1_794_000_000 - 4);
    expect(asked).to.deep.equal([500, 496]);
  });
  it("steps past a skipped slot (null) the same way", async () => {
    const asked: number[] = [];
    expect(await recentBlockTime(conn((s) => (s > 484 ? null : 1_793_999_990), asked), 500)).to.equal(1_793_999_990);
    expect(asked).to.deep.equal([500, 496, 484]);
  });
  it("falls back to the wall clock only when no slot answers", async () => {
    const before = Math.floor(Date.now() / 1000);
    const t = await recentBlockTime(conn(() => -1, []), 500);
    expect(t).to.be.within(before, before + 2);
  });
});
