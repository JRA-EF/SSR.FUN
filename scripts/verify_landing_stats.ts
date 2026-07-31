// Read-only live-DevNet sanity check for /api/devnet/landing-stats (see
// docs/project/DECISION_LOG.md's KPI-restoration entry). Calls the exact
// same handler function the deployed endpoint uses (unmodified import), so a
// pass here is evidence the real aggregate computation works against live
// DevNet, not just that its pure sub-functions are individually correct.
//
// THIS SCRIPT SENDS ZERO TRANSACTIONS -- every call is a read.
import handler from "../api/devnet/landing-stats";

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
    },
    _state: state,
  };
}

async function main() {
  console.log("=== /api/devnet/landing-stats -- live read-only sanity check ===");
  const res = mockRes();
  const start = Date.now();
  await handler({ method: "GET", headers: {} } as any, res as any);
  const elapsedMs = Date.now() - start;
  console.log(`Elapsed: ${elapsedMs}ms`);
  console.log(`Status: ${res._state.statusCode}`);
  console.log(`Body: ${JSON.stringify(res._state.body, null, 2)}`);

  if (res._state.statusCode !== 200) {
    throw new Error(`FAIL: expected 200, got ${res._state.statusCode}`);
  }
  const body = res._state.body as { holders: number; volume24hUsd: number; reservesCounted: number };
  if (typeof body.holders !== "number" || body.holders < 0) throw new Error("FAIL: holders is not a sane non-negative number.");
  if (typeof body.volume24hUsd !== "number" || body.volume24hUsd < 0 || !Number.isFinite(body.volume24hUsd)) {
    throw new Error("FAIL: volume24hUsd is not a sane non-negative finite number.");
  }
  if (typeof body.reservesCounted !== "number" || body.reservesCounted <= 0) {
    throw new Error("FAIL: reservesCounted should be > 0 against a live DevNet deployment with real Reserves.");
  }
  console.log("\nCONFIRMED: real, sane numbers returned from a genuine live read. This script sent zero transactions.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
