// GET /api/dashboard/kpis -- protocol-wide usage stats for /internal/kpis.
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
    res.status(503).json({ error: redactRpcSecrets(e instanceof Error ? e.message : "Failed to read live Reserve state.") });
    return;
  }

  try {
    const kpis = await computeProtocolKpis(liveReserves);
    res.status(200).json(kpis);
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to compute protocol KPIs." });
  }
}
