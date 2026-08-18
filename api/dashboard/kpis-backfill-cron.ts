// GET /api/dashboard/kpis-backfill-cron -- scheduled keeper (vercel.json's
// `crons`) that keeps reserve_activity_log's backfill genuinely complete
// across EVERY discovered Reserve, not just whichever ones happened to have
// their own page viewed recently (indexer.ts's syncReserveActivity is
// lazy/per-Reserve by design -- see lib/reserve-activity/backfillAll.ts's
// header for why a KPI aggregate needs this separate sweep). Read-only
// against the chain (no transaction ever submitted, unlike
// accrue-fees-cron.ts) -- only writes to this project's own Postgres.
//
// Same Vercel cron-security pattern as accrue-fees-cron.ts: a real
// scheduled invocation carries `Authorization: Bearer $CRON_SECRET`.
// `?dryRun=true` skips that check (useful for manual inspection) but still
// runs the real sweep -- there is no destructive/side-effect-only mode to
// skip here, unlike accrue-fees-cron's real-transaction dry-run split,
// since this endpoint never submits a transaction in the first place.
import { Connection } from "@solana/web3.js";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl, redactRpcSecrets } from "../devnet/_lib/rpc";
import { backfillAllReserveActivity } from "../../lib/reserve-activity/backfillAll";

function getHeader(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
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
    const connection = new Connection(resolveRpcUrl(), "confirmed");
    const result = await backfillAllReserveActivity(connection, { budgetMs: 50_000 });
    res.status(200).json(result);
  } catch (e) {
    res.status(503).json({ error: redactRpcSecrets(e instanceof Error ? e.message : "Backfill sweep failed.") });
  }
}
