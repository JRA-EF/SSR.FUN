// GET /api/kpis/kpis -- protocol-wide usage stats for /internal/kpis.
// Gated by the exact same SSR_DASHBOARD_PASSWORD session as /internal/status
// (middleware.ts already blocks unauthenticated requests to this path, but
// this function re-verifies independently -- same pattern as
// api/dashboard/content.ts and api/road-to-mainnet/*.ts).
//
// Two things happen on every call: (1) one bounded discoverAllReserves()
// read for live lifecycle status + assetCount (fast, a handful of batched
// RPC calls, not per-Reserve), (2) the real aggregate SQL in
// lib/reserve-activity/kpis.ts against whatever reserve_activity_log
// currently holds. This endpoint does NOT run a backfill sweep itself --
// that's a separate, much slower operation (see kpis-refresh.ts and the
// cron) so a dashboard page load stays fast regardless of backfill state;
// `backfillStatus` in the response tells the frontend how complete the
// underlying data currently is.
import { Connection, PublicKey } from "@solana/web3.js";
import { discoverAllReserves, DEVNET_FIXTURES, WRAPPED_SOL_MINT, DEVUSDC_MINT } from "@ssr/sdk";
import { type DashboardRequest, type DashboardResponse, isAuthenticated, unauthorized } from "../../lib/road-to-mainnet/auth.js";
import { computeProtocolKpis, type LiveReserveState } from "../../lib/reserve-activity/kpis.js";
import { resolveRpcUrl, redactRpcSecrets } from "../devnet/_lib/rpc.js";

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  // Deliberately wraps the ENTIRE handler, including the auth check itself
  // -- a 2026-08-18 incident (docs/project/DECISION_LOG.md's entry for this
  // pass) traced a raw platform-level 500 (not one of this file's own
  // res.status(503) calls) back to a failure Vercel's runtime reported with
  // no visible message at all. This guarantees any future failure, no
  // matter where it originates, comes back as a real, readable JSON error
  // instead of an opaque crash -- the fastest possible path to actually
  // diagnosing it next time, rather than guessing again.
  try {
    if (!(await isAuthenticated(req))) {
      unauthorized(res);
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    let liveReserves: LiveReserveState[];
    try {
      const connection = new Connection(resolveRpcUrl(), "confirmed");
      const programId = new PublicKey(DEVNET_FIXTURES.programId);
      const candidateMints = [
        new PublicKey(DEVNET_FIXTURES.mints.mintX.address),
        new PublicKey(DEVNET_FIXTURES.mints.mintY.address),
        new PublicKey(DEVNET_FIXTURES.mints.mintZ.address),
        WRAPPED_SOL_MINT,
        DEVUSDC_MINT,
      ];
      const { reserves } = await discoverAllReserves(connection, programId, candidateMints);
      liveReserves = reserves.map((r) => ({ reserve: r.reserve, status: r.status, assetCount: r.assetCount }));
    } catch (e) {
      res.status(503).json({ stage: "discover", error: redactRpcSecrets(e instanceof Error ? e.message : "Failed to read live Reserve state.") });
      return;
    }

    try {
      const kpis = await computeProtocolKpis(liveReserves);
      res.status(200).json(kpis);
    } catch (e) {
      res.status(503).json({ stage: "compute", error: e instanceof Error ? e.message : "Failed to compute protocol KPIs.", stack: e instanceof Error ? e.stack : undefined });
    }
  } catch (e) {
    res.status(500).json({ stage: "handler", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: e instanceof Error ? e.stack : undefined });
  }
}
