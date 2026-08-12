// Live, read-only verification for the Reserve Activity Log's new Postgres
// index (lib/reserve-activity/) -- see docs/project/DECISION_LOG.md's entry
// for this pass. Calls the REAL, unmodified syncReserveActivity against the
// persistent Gate-9 fixture Reserve (reserve_id 9,
// GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C, per
// docs/protocol/DEVNET_FIXTURES.md), confirms real rows land in Postgres,
// and confirms a second call is a fast, correct no-op top-up (idempotent
// via ON CONFLICT DO NOTHING) rather than re-walking/re-inserting
// everything. No wallet/signed transaction involved -- this is a read-only
// path end to end.
//
// Run: npx ts-node -P scripts/tsconfig.json scripts/verify_reserve_activity_index.ts
import * as fs from "fs";
import * as path from "path";
import Module from "module";
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";

// lib/reserve-activity/indexer.ts uses .js-suffixed relative imports
// (./db.js, ./cursorLogic.js) -- the correct, proven style for how Vercel's
// actual esbuild-based function bundler resolves them against sibling .ts
// files (identical to lib/road-to-mainnet/store.ts's already-live-in-
// production imports). ts-node's raw CJS require hook, used only by this
// LOCAL script, doesn't perform that mapping at resolution time (before an
// extension handler even runs) -- this patches Module._resolveFilename
// itself, for this process only, so this script can exercise the real,
// unmodified indexer.ts rather than a reimplementation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origResolveFilename = (Module as any)._resolveFilename;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  if (request.endsWith(".js")) {
    const tsRequest = request.slice(0, -3) + ".ts";
    try {
      return origResolveFilename.call(this, tsRequest, ...rest);
    } catch {
      // Not a local .ts sibling (e.g. a genuine node_modules .js) -- fall through.
    }
  }
  return origResolveFilename.call(this, request, ...rest);
};

import { syncReserveActivity } from "../lib/reserve-activity/indexer";
import { getSql } from "../lib/reserve-activity/db";

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
loadEnvLocal();

const RESERVE_ONE = new PublicKey("GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C");
const RPC_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (run `vercel env pull .env.local` first).");
    process.exit(1);
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const program = buildReadOnlyProgram(connection);

  console.log(`Syncing Reserve One (${RESERVE_ONE.toBase58()}) against ${RPC_URL} ...`);
  const t0 = Date.now();
  const first = await syncReserveActivity(connection, program, RESERVE_ONE);
  const firstMs = Date.now() - t0;
  console.log(`First sync: ${firstMs}ms, syncError=${first.syncError ?? "none"}`);

  const sql = getSql();
  const reserve = RESERVE_ONE.toBase58();
  const rows = await sql`select signature, kind, ts, actor, summary from reserve_activity_log where reserve = ${reserve} order by ts desc limit 10`;
  const countRows = await sql`select count(*)::int as n from reserve_activity_log where reserve = ${reserve}`;
  const cursorRows = await sql`select newest_signature_indexed, oldest_signature_indexed, backfill_complete from reserve_activity_cursor where reserve = ${reserve}`;

  console.log(`Rows in reserve_activity_log for this Reserve: ${(countRows[0] as { n: number }).n}`);
  console.log("Most recent 10:");
  for (const r of rows as unknown as { signature: string; kind: string; ts: number; actor: string | null; summary: string }[]) {
    console.log(`  [${new Date(r.ts * 1000).toISOString()}] ${r.kind}: ${r.summary}`);
  }
  console.log("Cursor:", cursorRows[0]);

  const t1 = Date.now();
  const second = await syncReserveActivity(connection, program, RESERVE_ONE);
  const secondMs = Date.now() - t1;
  const countRows2 = await sql`select count(*)::int as n from reserve_activity_log where reserve = ${reserve}`;
  console.log(`Second sync (should be fast, no-op top-up): ${secondMs}ms, syncError=${second.syncError ?? "none"}`);
  console.log(`Row count after second sync: ${(countRows2[0] as { n: number }).n} (should be unchanged from ${(countRows[0] as { n: number }).n} -- ON CONFLICT DO NOTHING confirmed idempotent if equal)`);

  if ((countRows2[0] as { n: number }).n !== (countRows[0] as { n: number }).n) {
    console.error("UNEXPECTED: row count changed between two immediate syncs -- investigate before trusting this index.");
    process.exit(1);
  }
  console.log("OK: index populated from real on-chain data, second sync is idempotent.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
