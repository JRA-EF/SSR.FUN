// GET /api/ledger/reclassify-actors-cron -- recomputes actor_role on
// already-ingested ledger_events rows using the CURRENT
// ledger_reserves/ledger_reserve_delegates snapshot (lib/ledger/
// reserveContext.ts's reclassifyActorRoles). Needed because ingestion
// walks newest-to-oldest for resumability: a Reserve's manager/creator
// often isn't known yet at the moment its earlier (newer, processed
// first) activity rows are classified, so those rows fall back to the
// generic "holder"/"unknown" roles until this runs. Cheap and idempotent
// -- touches only Postgres (no RPC calls), safe to run as its own,
// slightly-less-frequent cron tick after ingest-cron.
//
// Same CRON_SECRET / ?dryRun=true pattern as ingest-cron.ts.
import { reclassifyActorRoles } from "../../lib/ledger/reserveContext";
import { getSql } from "../../lib/ledger/db";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

function getHeader(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function resolveCluster(): "devnet" | "mainnet-beta" {
  return process.env.LEDGER_CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const dryRun = req.query?.dryRun === "true" || req.query?.dryRun === "1";
  if (!dryRun) {
    const expected = process.env.CRON_SECRET;
    const provided = getHeader(req, "authorization");
    if (!expected) {
      res.status(500).json({ error: "CRON_SECRET is not configured on this deployment." });
      return;
    }
    if (provided !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
  }

  try {
    const result = await reclassifyActorRoles(getSql(), resolveCluster());
    res.status(200).json(result);
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "Actor-role reclassification failed." });
  }
}
