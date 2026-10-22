// GET /api/kpis/dex-volume-cron -- daily sweep that indexes swaps in every
// SSR-created Raydium pool into dex_pool_swaps (DEC-0254). Read-only against
// the chain; only writes this project's own Postgres. Daily, not more often:
// the sweep does one program-account scan plus a signature walk per pool,
// which belongs off the hot path under the shared Helius cap, and a frequent
// cron would keep Neon from suspending (DEC-0209).
//
// Same cron-security pattern as kpis-backfill-cron.ts: a scheduled call
// carries `Authorization: Bearer $CRON_SECRET`; `?dryRun=true` skips the
// check for manual runs (there is no destructive mode to skip).
import { Connection } from "@solana/web3.js";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes.js";
import { redactRpcSecrets } from "../devnet/_lib/rpc.js";
import { resolveRpcUrl } from "../mainnet/_lib/rpc.js";
import { sweepDexVolume } from "../../lib/dex-volume/indexer.js";

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
    if (!expected) {
      res.status(500).json({ error: "CRON_SECRET is not configured on this deployment." });
      return;
    }
    if (getHeader(req, "authorization") !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
  }
  try {
    const result = await sweepDexVolume(new Connection(resolveRpcUrl(), "confirmed"), 50_000);
    res.status(200).json(result);
  } catch (e) {
    res.status(503).json({ error: redactRpcSecrets(e instanceof Error ? e.message : "DEX volume sweep failed.") });
  }
}
