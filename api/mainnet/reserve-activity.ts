// GET /api/mainnet/reserve-activity?reserve=<address> -- the Mainnet twin of
// api/devnet/reserve-activity.ts (DEC-0200).
//
// Why this exists: there was NO Mainnet activity route. ManageDTR called the
// devnet one unconditionally for every Reserve on every cluster, so a Mainnet
// Reserve's activity was indexed against the DevNet RPC, found nothing, and
// wrote a cursor tagged `devnet`. Verified live 2026-09-11 against Reserve 24
// (C6xZ6bPFqYknZawZexW1kBfAehL5qCXQJHmFkBNQWedP): a `devnet` cursor,
// backfill incomplete, and 0 of the 429 indexed activity rows -- the direct
// cause of "a Reserve with activity still shows as inactive". The indexer
// already self-heals a mis-tagged cursor (indexer.ts's getCursor drops rows
// recorded under a different cluster), so the first correct call repairs it.
//
// Same contract as the DevNet route: best-effort bounded sync first, then
// always read from Postgres, and a sync failure is reported but never blocks
// returning what is already indexed. Reads are scoped to this cluster.
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { syncReserveActivity } from "../../lib/reserve-activity/indexer";
import { getSql } from "../../lib/reserve-activity/db";
import { checkRateWindow } from "../devnet/_lib/rateLimit";

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

const CLUSTER = "mainnet-beta" as const;

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

  // Same per-IP throttle rationale as the DevNet route: this does real
  // backfill work per request for any syntactically-valid address.
  if (!checkRateWindow(`mainnet-reserve-activity:${clientIp(req)}`, 1_000, 5)) {
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
    const connection = new Connection(resolveRpcUrl(), "confirmed");
    const program = buildReadOnlyProgram(connection);
    const result = await syncReserveActivity(connection, program, reservePk, CLUSTER);
    syncError = result.syncError ? redactRpcSecrets(result.syncError) : null;
  } catch (e) {
    syncError = redactRpcSecrets(e instanceof Error ? e.message : String(e));
  }

  try {
    const sql = getSql();
    const reserve = reservePk.toBase58();
    const [rows, cursorRows] = await Promise.all([
      sql`
        select signature, kind, ts, actor, summary
        from reserve_activity_log
        where reserve = ${reserve} and cluster = ${CLUSTER}
        order by ts desc
        limit 500
      `,
      sql`select backfill_complete from reserve_activity_cursor where reserve = ${reserve} and cluster = ${CLUSTER}`,
    ]);
    const entries = rows as unknown as ActivityRow[];
    const backfillComplete = Boolean((cursorRows[0] as { backfill_complete?: boolean } | undefined)?.backfill_complete);
    res.status(200).json({ entries, backfillComplete, syncError });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read the Reserve Activity Log." });
  }
}
