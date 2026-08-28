// POST /api/kpis/kpis-refresh -- manual "Refresh data" trigger for
// /internal/kpis. Runs the same bounded backfillAllReserveActivity sweep
// the cron (api/kpis/kpis-backfill-cron.ts) runs on a schedule, just
// on demand. Auth + same-origin CSRF check (road-to-mainnet/auth.ts's
// pattern) since this is state-changing (writes to Postgres), unlike
// kpis.ts's read-only GET.
import { type DashboardRequest, type DashboardResponse, isAuthenticated, isSameOriginRequest, unauthorized } from "./_session";
import { backfillAllReserveActivity } from "../../lib/reserve-activity/backfillAll.js";
import { ACTIVITY_CLUSTERS, buildClusterTargets } from "../../lib/reserve-activity/clusters.js";
import { redactRpcSecrets } from "../devnet/_lib/rpc.js";

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  // See kpis.ts's matching comment: wraps the whole handler so any failure,
  // wherever it originates, comes back as a readable JSON error rather than
  // an opaque platform-level crash.
  try {
    if (!(await isAuthenticated(req))) {
      unauthorized(res);
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    if (!isSameOriginRequest(req)) {
      res.status(403).json({ error: "Cross-site request rejected." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    try {
      // Both clusters, Mainnet first (see clusters.ts) -- a cluster whose
      // discovery fails is reported inside the result, never a 503 here.
      const result = await backfillAllReserveActivity(buildClusterTargets([...ACTIVITY_CLUSTERS]), { budgetMs: 45_000 });
      res.status(200).json(result);
    } catch (e) {
      res.status(503).json({ error: redactRpcSecrets(e instanceof Error ? e.message : "Backfill sweep failed.") });
    }
  } catch (e) {
    res.status(500).json({ stage: "handler", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: e instanceof Error ? e.stack : undefined });
  }
}
