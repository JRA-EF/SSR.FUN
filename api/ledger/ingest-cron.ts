// GET /api/ledger/ingest-cron -- scheduled keeper that walks ssr_protocol's
// real transaction history and populates ledger_events (lib/ledger/ingest.ts).
// Read-only against the chain (no transaction ever submitted) -- only
// writes to this project's own Postgres.
//
// Cluster/program defaults to DevNet's deployed program (the only one that
// exists as of this writing) via CLUSTER/SSR_PROGRAM_ID env vars, falling
// back to DEVNET_FIXTURES.programId -- see docs/protocol/LEDGER_ARCHITECTURE.md's
// "Mainnet backfill" section for how this gets pointed at Mainnet once that
// program is deployed (a new deployment's program ID and start slot, not a
// code change).
//
// Same Vercel cron-security pattern as accrue-fees-cron.ts/
// kpis-backfill-cron.ts: a real scheduled invocation carries
// `Authorization: Bearer $CRON_SECRET`. `?dryRun=true` skips that check but
// still runs the real (read-only-on-chain) sweep.
import { Connection } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { ingestProgramEvents, type Cluster } from "../../lib/ledger/ingest";

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

function resolveCluster(): Cluster {
  const raw = process.env.LEDGER_CLUSTER;
  return raw === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

function resolveRpcUrl(): string {
  return process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
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
    const cluster = resolveCluster();
    // buildReadOnlyProgram derives BOTH the program ID and IDL from the
    // committed packages/sdk/idl/ssr_protocol.json -- currently the DevNet
    // deployment. Ingesting a future Mainnet deployment (a different
    // program ID, likely a different IDL revision) needs its OWN read-only
    // Program construction pointed at that program's own committed IDL --
    // not yet built, since no Mainnet program exists yet. See
    // docs/protocol/LEDGER_ARCHITECTURE.md's "Mainnet backfill" section.
    const connection = new Connection(resolveRpcUrl(), "confirmed");
    const program = buildReadOnlyProgram(connection);
    const result = await ingestProgramEvents(connection, program, cluster, { source: dryRun ? "backfill" : "rpc-poll" });
    res.status(200).json(result);
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "Ledger ingestion sweep failed." });
  }
}
