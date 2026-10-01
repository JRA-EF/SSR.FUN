// GET /api/ledger/jupiter-snapshot-cron -- weekly keeper (vercel.json's
// `crons`) for requirement 9's Jupiter catalogue tracking. Idempotent per
// UTC calendar date (lib/ledger/jupiterCatalogue.ts's runWeeklyJupiterSnapshot
// skips if today's snapshot already exists) unless `?force=1`/`?force=true`
// is given, which re-runs today's fetch+upsert anyway (see
// runWeeklyJupiterSnapshot's header for the one legitimate use: backfilling
// a newly-added ledger_asset_catalogue column into a snapshot that already
// ran today). Requires JUPITER_API_KEY -- returns a clear 503 (not a crash)
// if it's unset, since this cannot run at all without it. See
// docs/protocol/LEDGER_ARCHITECTURE.md for the exact Creator action needed
// to unblock this.
import { runWeeklyJupiterSnapshot } from "../../lib/ledger/jupiterCatalogue";
import { markIncompatibleMints } from "../../lib/ledger/markIncompatibleMints";
import { Connection } from "@solana/web3.js";
import { resolveRpcUrl } from "../mainnet/_lib/rpc";

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

  const force = req.query?.force === "true" || req.query?.force === "1";

  try {
    const result = await runWeeklyJupiterSnapshot({ force });
    // DEC-0205: a Token-2022 mint carrying one of the five extensions the
    // program refuses can never be registered as a Reserve asset, so it must
    // not reach the picker. Read from the chain after each snapshot; a
    // failure here leaves the catalogue exactly as the snapshot left it
    // rather than failing the whole cron.
    let extensions: unknown = null;
    try {
      extensions = await markIncompatibleMints(new Connection(resolveRpcUrl(), "confirmed"));
    } catch (e) {
      extensions = { error: e instanceof Error ? e.message : "extension scan failed" };
    }
    res.status(200).json({ ...result, extensions });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "Jupiter snapshot failed." });
  }
}
