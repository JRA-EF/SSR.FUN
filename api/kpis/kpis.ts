// GET /api/kpis/kpis -- protocol-wide usage stats for /internal/kpis.
// Gated by the exact same SSR_DASHBOARD_PASSWORD session as /internal/status
// (middleware.ts already blocks unauthenticated requests to this path, but
// this function re-verifies independently -- same pattern as
// api/dashboard/content.ts and api/road-to-mainnet/*.ts).
//
// Cluster-aware since DEC-0175 (the protocol has been live on Mainnet since
// 2026-08-19, DEC-0115): live Reserve state is discovered per cluster from
// lib/reserve-activity/clusters.ts's targets, and ?cluster=all|mainnet-beta|
// devnet scopes both the live state and the SQL aggregates. Each cluster's
// discovery is isolated -- a failure (live 2026-08-28: DevNet's upgraded
// program no longer decodes with the SDK's deployed-Mainnet-shape IDL,
// "Invalid bool: 87") is reported in that cluster's summary instead of
// failing the whole page, which is exactly how the pre-cluster version
// broke: one DevNet decode error 503'd every load of /internal/kpis.
//
// This endpoint does NOT run a backfill sweep itself -- that's a separate,
// much slower operation (see kpis-refresh.ts and the cron) so a dashboard
// page load stays fast regardless of backfill state; `backfillStatus` in
// the response tells the frontend how complete the underlying data
// currently is.
import { type DashboardRequest, type DashboardResponse, isAuthenticated, unauthorized } from "./_session";
import { computeProtocolKpis, type LiveReserveState } from "../../lib/reserve-activity/kpis.js";
import { buildClusterTargets, clustersForFilter, parseClusterFilter, type ActivityCluster } from "../../lib/reserve-activity/clusters.js";
import { discoverAllReserves } from "@ssr/sdk";
import { redactRpcSecrets } from "../devnet/_lib/rpc.js";

interface ClusterSummary {
  cluster: ActivityCluster;
  reservesDiscovered: number;
  /** Non-null when this cluster's live discovery failed; SQL aggregates still include its recorded history. */
  discoveryError: string | null;
}

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

    const filter = parseClusterFilter((req as { query?: Record<string, unknown> }).query?.cluster);
    if (!filter) {
      res.status(400).json({ error: "cluster must be one of: all, mainnet-beta, devnet." });
      return;
    }
    const clusters = clustersForFilter(filter);

    res.setHeader("Cache-Control", "no-store");

    const liveReserves: LiveReserveState[] = [];
    const clusterSummaries: ClusterSummary[] = [];
    for (const target of buildClusterTargets(clusters)) {
      try {
        const candidateMints = await target.candidateMints();
        const { reserves } = await discoverAllReserves(target.connection, target.programId, candidateMints);
        for (const r of reserves) liveReserves.push({ reserve: r.reserve, status: r.status, assetCount: r.assetCount });
        clusterSummaries.push({ cluster: target.cluster, reservesDiscovered: reserves.length, discoveryError: null });
      } catch (e) {
        clusterSummaries.push({
          cluster: target.cluster,
          reservesDiscovered: 0,
          discoveryError: redactRpcSecrets(e instanceof Error ? e.message : "Failed to read live Reserve state."),
        });
      }
    }

    try {
      const kpis = await computeProtocolKpis(liveReserves, clusters);
      res.status(200).json({ ...kpis, clusterFilter: filter, clusters: clusterSummaries });
    } catch (e) {
      res.status(503).json({ stage: "compute", error: e instanceof Error ? e.message : "Failed to compute protocol KPIs.", stack: e instanceof Error ? e.stack : undefined });
    }
  } catch (e) {
    res.status(500).json({ stage: "handler", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: e instanceof Error ? e.stack : undefined });
  }
}
