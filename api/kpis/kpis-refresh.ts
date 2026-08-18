// POST /api/dashboard/kpis-refresh -- manual "Refresh data" trigger for
// /internal/kpis. Runs the same bounded backfillAllReserveActivity sweep
// the cron (api/dashboard/kpis-backfill-cron.ts) runs on a schedule, just
// on demand. Auth + same-origin CSRF check (road-to-mainnet/auth.ts's
// pattern) since this is state-changing (writes to Postgres), unlike
// kpis.ts's read-only GET.
import { Connection } from "@solana/web3.js";
import { type DashboardRequest, type DashboardResponse, isAuthenticated, isSameOriginRequest, unauthorized } from "../../lib/road-to-mainnet/auth.js";
import { backfillAllReserveActivity } from "../../lib/reserve-activity/backfillAll.js";
import { resolveRpcUrl, redactRpcSecrets } from "../devnet/_lib/rpc.js";

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
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
    const connection = new Connection(resolveRpcUrl(), "confirmed");
    const result = await backfillAllReserveActivity(connection, { budgetMs: 45_000 });
    res.status(200).json(result);
  } catch (e) {
    res.status(503).json({ error: redactRpcSecrets(e instanceof Error ? e.message : "Backfill sweep failed.") });
  }
}
