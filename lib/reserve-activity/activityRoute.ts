// Shared handler behind GET /api/devnet/reserve-activity and
// GET /api/mainnet/reserve-activity (DEC-0206). Until this pass the Activity
// tab always called the DevNet route, which syncs against HELIUS_RPC_URL and
// tags rows 'devnet' -- for a Mainnet Reserve that walked the wrong chain
// (and, via indexer.ts's cluster self-heal, would have discarded the
// Reserve's real 'mainnet-beta' rows). Each route now passes its own
// cluster tag and RPC URL; everything else is identical.
//
// Best-effort syncs the store first (indexer.ts's syncReserveActivity,
// bounded so this call can never approach a serverless timeout regardless
// of how much real history a Reserve has), heals a bounded number of
// pre-DEC-0206 fee-payout rows, then always reads from the database -- a
// sync failure (RPC congestion) is reported via `syncError` but never blocks
// returning whatever is already indexed. No dashboard auth: this must be
// visible to any wallet viewing a Reserve's Manage page, same as the public
// read it replaced (packages/sdk/src/activityLog.ts's
// fetchReserveActivityLog, previously called directly from the browser).
//
// `?scope=fees` returns only the per-recipient USDC fee-payout totals (the
// Fee Configuration panel's read); the default returns the full entry list
// plus those same totals.
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { syncReserveActivity } from "./indexer";
import { getSql } from "./db";
import { healMissingFeePayouts, readFeePayoutTotals, type FeePayoutTotals } from "./feePayouts";
import type { ActivityCluster } from "./clusters";

export interface ActivityRouteRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}

export interface ActivityRouteResponse {
  status(code: number): ActivityRouteResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

export interface ActivityRouteConfig {
  cluster: ActivityCluster;
  rpcUrl: string;
  /** Strips RPC secrets from an error message before it reaches a response body. */
  redact: (message: string) => string;
  /** Per-IP throttle hook (api/devnet/_lib/rateLimit.ts); returns false when the caller should get a 429. */
  allowRequest: (clientIp: string) => boolean;
}

interface ActivityRow {
  signature: string;
  kind: string;
  ts: number;
  actor: string | null;
  summary: string;
}

export interface ActivityRouteBody {
  entries: ActivityRow[];
  backfillComplete: boolean;
  syncError: string | null;
  feePayouts: FeePayoutTotals;
}

function clientIp(req: ActivityRouteRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

export async function handleReserveActivityRequest(req: ActivityRouteRequest, res: ActivityRouteResponse, config: ActivityRouteConfig): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  res.setHeader?.("Cache-Control", "no-store");

  // This route does real backfill work (syncReserveActivity) per request for
  // any syntactically-valid address, not just a known Reserve -- a per-IP
  // throttle here is a cheap secondary defense against that being driven at
  // volume, on top of syncReserveActivity's own bounded work per call.
  if (!config.allowRequest(clientIp(req))) {
    res.status(429).json({ error: "Too many requests to the Reserve Activity Log from this client -- wait a moment and try again." });
    return;
  }

  const url = new URL(req.url ?? "", "http://internal");
  const reserveParam = url.searchParams.get("reserve");
  const feesOnly = url.searchParams.get("scope") === "fees";
  if (!reserveParam) {
    res.status(400).json({ error: "Missing required 'reserve' query param." });
    return;
  }

  let reservePk: PublicKey;
  try {
    reservePk = new PublicKey(reserveParam);
  } catch {
    res.status(400).json({ error: "'reserve' is not a valid Solana address." });
    return;
  }
  const reserve = reservePk.toBase58();

  let syncError: string | null;
  try {
    const connection = new Connection(config.rpcUrl, "confirmed");
    const program = buildReadOnlyProgram(connection);
    const result = await syncReserveActivity(connection, program, reservePk, config.cluster);
    syncError = result.syncError ? config.redact(result.syncError) : null;
    const heal = await healMissingFeePayouts(connection, program, reserve, config.cluster);
    if (heal.error && !syncError) syncError = config.redact(heal.error);
  } catch (e) {
    // syncReserveActivity itself never throws, but guard the connection/
    // program construction above too -- a sync failure must never prevent
    // reading whatever is already indexed below.
    syncError = config.redact(e instanceof Error ? e.message : String(e));
  }

  try {
    const feePayouts = await readFeePayoutTotals(reserve, config.cluster);
    if (feesOnly) {
      res.status(200).json({ feePayouts, syncError });
      return;
    }
    const sql = getSql();
    const rows = await sql`
      select signature, kind, ts, actor, summary
      from reserve_activity_log
      where reserve = ${reserve} and cluster = ${config.cluster}
      order by ts desc
      limit 500
    `;
    const body: ActivityRouteBody = { entries: rows as unknown as ActivityRow[], backfillComplete: feePayouts.backfillComplete, syncError, feePayouts };
    res.status(200).json(body);
  } catch (e) {
    // A genuinely broken DB read (not just a sync-side RPC hiccup) is the
    // one case worth a real error response -- there's nothing to fall back
    // to serve at that point.
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read the Reserve Activity Log." });
  }
}
