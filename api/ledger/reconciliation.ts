// GET /api/ledger/reconciliation -- runs the SSR Ledger's data-quality
// checks (lib/ledger/reconciliation.ts) on demand and returns a structured
// report. Every run is also permanently logged into
// ledger_reconciliation_runs (so "was this ever checked, and when" is
// itself answerable later). Auth-gated like every other internal endpoint.
import { isAuthenticated, type DashboardRequest, type DashboardResponse } from "./_session";
import { runAllReconciliationChecks } from "../../lib/ledger/reconciliation";

interface ApiRequest extends DashboardRequest {
  url?: string;
}

export default async function handler(req: ApiRequest, res: DashboardResponse) {
  try {
    if (!(await isAuthenticated(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const url = new URL(req.url ?? "", "http://internal");
    const cluster = url.searchParams.get("cluster") ?? "devnet";

    res.setHeader("Cache-Control", "no-store");
    const results = await runAllReconciliationChecks(cluster);
    const allPassed = results.every((r) => r.passed);
    res.status(200).json({ cluster, allPassed, checks: results });
  } catch (e) {
    res.status(500).json({ stage: "handler", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: e instanceof Error ? e.stack : undefined });
  }
}
