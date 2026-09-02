import { expect } from "chai";
import { checkDurableRateWindow, type RateLimitQuery } from "../lib/rate-limit/durableRateWindow";

/**
 * A faithful in-memory stand-in for the atomic SQL statement in
 * durableRateWindow.ts: one shared map, fixed-window reset, count++ -- the
 * exact semantics the ON CONFLICT upsert implements. Because it is a single
 * synchronous map mutation it also models the atomicity the real statement
 * gets from row-locking: interleaved calls see each other's increments.
 */
function makeFakeSql(store = new Map<string, { window_start: number; count: number }>()): RateLimitQuery {
  return async (strings, ...values) => {
    // positional args in the query, in order: key, now, now, windowMs, now, windowMs
    const key = values[0] as string;
    const now = values[1] as number;
    const windowMs = values[3] as number;
    const cur = store.get(key);
    if (!cur || now - cur.window_start >= windowMs) {
      store.set(key, { window_start: now, count: 1 });
    } else {
      cur.count += 1;
    }
    const row = store.get(key)!;
    return [{ count: row.count, window_start: row.window_start }];
  };
}

describe("checkDurableRateWindow -- durable cross-instance limiter", () => {
  it("admits exactly maxCount requests inside one window, then blocks", async () => {
    const sql = makeFakeSql();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await checkDurableRateWindow(sql, "send:global", 1000, 3, 1_000_000);
      results.push(r.allowed);
    }
    expect(results).to.deep.equal([true, true, true, false, false]);
  });

  it("is GLOBAL: two independent 'instances' sharing the store still cap at maxCount", async () => {
    // The whole point of the fix -- the store models the shared DB, so calls
    // arriving via different serverless instances increment the SAME counter.
    const store = new Map<string, { window_start: number; count: number }>();
    const instanceA = checkDurableRateWindow.bind(null);
    const sqlA = makeFakeSql(store);
    const sqlB = makeFakeSql(store); // different closure, same backing store
    const admitted = [
      (await instanceA(sqlA, "k", 1000, 3, 5_000_000)).allowed, // A #1
      (await instanceA(sqlB, "k", 1000, 3, 5_000_000)).allowed, // B #1
      (await instanceA(sqlA, "k", 1000, 3, 5_000_000)).allowed, // A #2
      (await instanceA(sqlB, "k", 1000, 3, 5_000_000)).allowed, // B #2  -> 4th, blocked
    ];
    expect(admitted).to.deep.equal([true, true, true, false]);
  });

  it("resets once the window elapses", async () => {
    const sql = makeFakeSql();
    for (let i = 0; i < 3; i++) await checkDurableRateWindow(sql, "k", 1000, 3, 2_000_000);
    const blocked = await checkDurableRateWindow(sql, "k", 1000, 3, 2_000_000); // 4th, same window
    expect(blocked.allowed).to.equal(false);
    const afterWindow = await checkDurableRateWindow(sql, "k", 1000, 3, 2_001_500); // >1s later
    expect(afterWindow.allowed).to.equal(true);
    expect(afterWindow.count).to.equal(1);
  });

  it("keys are independent", async () => {
    const sql = makeFakeSql();
    for (let i = 0; i < 3; i++) await checkDurableRateWindow(sql, "a", 1000, 3, 3_000_000);
    const aBlocked = await checkDurableRateWindow(sql, "a", 1000, 3, 3_000_000);
    const bFresh = await checkDurableRateWindow(sql, "b", 1000, 3, 3_000_000);
    expect(aBlocked.allowed).to.equal(false);
    expect(bFresh.allowed).to.equal(true);
  });

  it("FAILS OPEN when the DB throws, and signals non-durable so the caller can fall back", async () => {
    const throwingSql: RateLimitQuery = async () => {
      throw new Error("connection refused");
    };
    const r = await checkDurableRateWindow(throwingSql, "k", 1000, 3, 4_000_000);
    expect(r.allowed).to.equal(true);   // never blocks legit traffic on a DB blip
    expect(r.durable).to.equal(false);  // caller must apply its in-memory L1
  });
});
