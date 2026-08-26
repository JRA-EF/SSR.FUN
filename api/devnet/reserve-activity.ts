// GET /api/devnet/reserve-activity?reserve=<address> -- Reserve Activity
// Log, served from Postgres (lib/reserve-activity/schema.sql) instead of
// walking live RPC on every request. Best-effort syncs the store first
// (lib/reserve-activity/indexer.ts's syncReserveActivity, bounded so this
// call can never approach a serverless timeout regardless of how much real
// history a Reserve has), then always reads from the database -- a sync
// failure (RPC congestion) is reported via `syncError` but never blocks
// returning whatever is already indexed. No dashboard auth: this must be
// visible to any wallet viewing a Reserve's Manage page, same as the
// public read this replaces (packages/sdk/src/activityLog.ts's
// fetchReserveActivityLog, previously called directly from the browser).
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { syncReserveActivity } from "../../lib/reserve-activity/indexer";
import { getSql } from "../../lib/reserve-activity/db";
import { checkRateWindow } from "./_lib/rateLimit";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

const RPC_URL = resolveRpcUrl();

interface ActivityRow {
  signature: string;
  kind: string;
  ts: number;
  actor: string | null;
  summary: string;
}

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  res.setHeader?.("Cache-Control", "no-store");

  // This route does real backfill work (syncReserveActivity) per request for
  // any syntactically-valid address, not just a known Reserve -- a per-IP
  // throttle here is a cheap secondary defense against that being driven at
  // volume, on top of syncReserveActivity's own bounded work per call.
  if (!checkRateWindow(`devnet-reserve-activity:${clientIp(req)}`, 1_000, 5)) {
    res.status(429).json({ error: "Too many requests to the Reserve Activity Log from this client -- wait a moment and try again." });
    return;
  }

  const url = new URL(req.url ?? "", "http://internal");
  const reserveParam = url.searchParams.get("reserve");
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

  let syncError: string | null;
  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const program = buildReadOnlyProgram(connection);
    const result = await syncReserveActivity(connection, program, reservePk);
    syncError = result.syncError ? redactRpcSecrets(result.syncError) : null;
  } catch (e) {
    // syncReserveActivity itself never throws, but guard the connection/
    // program construction above too -- a sync failure must never prevent
    // reading whatever is already indexed below.
    syncError = redactRpcSecrets(e instanceof Error ? e.message : String(e));
  }

  try {
    const sql = getSql();
    const reserve = reservePk.toBase58();
    const [rows, cursorRows] = await Promise.all([
      sql`
        select signature, kind, ts, actor, summary
        from reserve_activity_log
        where reserve = ${reserve}
        order by ts desc
        limit 500
      `,
      sql`select backfill_complete from reserve_activity_cursor where reserve = ${reserve}`,
    ]);
    const entries = rows as unknown as ActivityRow[];
    const backfillComplete = Boolean((cursorRows[0] as { backfill_complete?: boolean } | undefined)?.backfill_complete);
    res.status(200).json({ entries, backfillComplete, syncError });
  } catch (e) {
    // A genuinely broken DB read (not just a sync-side RPC hiccup) is the
    // one case worth a real error response -- there's nothing to fall back
    // to serve at that point.
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read the Reserve Activity Log." });
  }
}
