// Live sanity check for the Reserve NAV History pass (see
// docs/project/DECISION_LOG.md's entry). Against the REAL Mainnet database
// (DATABASE_URL from .env.local) it:
//
//   1. calls the exact /api/mainnet/reserve-nav-history handler the deployed
//      endpoint uses and prints, per Reserve, the launch anchor, the first /
//      last served point, recordedFrom, and the all-time change the detail
//      page will display (current snapshot NAV vs. the anchor);
//   2. with --record, runs ONE recorder pass (the same recordNavPoints call
//      api/mainnet/warm-cache-cron.ts makes every ~15s) from the current
//      warm-cache snapshot, so recorded history starts now rather than at
//      the next production deploy. Without the flag it is read-only.
//
// Usage: npx ts-node -P tests/tsconfig.json scripts/verify_nav_history.ts [--record]
import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import handler from "../api/mainnet/reserve-nav-history";
import { readReserveSnapshot } from "../lib/reserve-warm-cache/db";
import { computeNavUsd, type NavInputReserve } from "../lib/reserve-nav-history/navMath";
import { createNavRecorderState, recordNavPoints } from "../lib/reserve-nav-history/recorder";

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    setHeader() {},
    json(body: unknown) {
      state.body = body;
    },
    _state: state,
  };
}

async function main() {
  const record = process.argv.includes("--record");
  const row = await readReserveSnapshot("mainnet-beta");
  if (!row) throw new Error("FAIL: no warm-cache snapshot row -- the cron hasn't run?");
  const snapshot = row.snapshot as { reserves: (NavInputReserve & { reserveId: string })[]; priceByMint: Record<string, number>; metadataByReserve: Record<string, { ticker?: string } | null> };
  console.log(`Snapshot generated ${row.generatedAt}, ${snapshot.reserves.length} reserves`);

  if (record) {
    const state = createNavRecorderState();
    const written = await recordNavPoints("mainnet-beta", snapshot.reserves, snapshot.priceByMint, state);
    console.log(`Recorder pass wrote ${written} row(s).`);
  }

  const res = mockRes();
  await handler({ method: "GET", headers: {} } as any, res as any);
  if (res._state.statusCode !== 200) throw new Error(`FAIL: expected 200, got ${res._state.statusCode}: ${JSON.stringify(res._state.body)}`);
  const body = res._state.body as { series: Record<string, { points: { t: number; price: number }[]; recordedFrom: number | null }> };

  const fmt = (n: number) => n.toFixed(4);
  for (const r of snapshot.reserves) {
    const ticker = snapshot.metadataByReserve?.[r.reserveId]?.ticker ?? r.reserveId;
    const s = body.series[r.reserve];
    const navNow = computeNavUsd(r, snapshot.priceByMint);
    if (!s) {
      console.log(`${ticker.padEnd(8)} ${r.reserve}  no series served (nav now ${navNow === null ? "n/a" : fmt(navNow)})`);
      continue;
    }
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    const allTime = navNow !== null ? ((navNow - first.price) / first.price) * 100 : null;
    console.log(
      `${ticker.padEnd(8)} points=${String(s.points.length).padStart(3)}  anchor ${new Date(first.t).toISOString().slice(0, 10)} @ ${fmt(first.price)}  last ${new Date(last.t).toISOString().slice(0, 16)} @ ${fmt(last.price)}  recordedFrom=${s.recordedFrom === null ? "null" : new Date(s.recordedFrom).toISOString().slice(0, 16)}  nav now ${navNow === null ? "n/a" : fmt(navNow)}  all-time ${allTime === null ? "n/a" : (allTime >= 0 ? "+" : "") + allTime.toFixed(2) + "%"}`,
    );
  }
  console.log("PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
