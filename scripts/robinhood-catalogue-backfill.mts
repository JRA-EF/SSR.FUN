// Walks the whole of Robinhood Chain once to build the asset catalogue
// (lib/robinhood/catalogue.ts), then hands over to the daily cron.
//
//   node scripts/migrate-robinhood-catalogue.mjs      # tables first
//   npx tsx scripts/robinhood-catalogue-backfill.mts  # then this
//
// Loops runRobinhoodCatalogueRefresh in 10M-block slices until the scan is
// caught up with the chain head, checkpointing after every slice, so it can
// be stopped and restarted. Needs DATABASE_URL (.env.local); uses
// ROBINHOOD_RPC_URL when set, else the public RPC.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { PUBLIC_RPC_URL, runRobinhoodCatalogueRefresh } from "../lib/robinhood/catalogue";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "").replace(/\r$/, "");
  }
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (run `vercel env pull .env.local` first).");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const rpcUrl = process.env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL;
const started = Date.now();
for (let pass = 1; ; pass++) {
  console.log(`--- pass ${pass} (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
  const s = await runRobinhoodCatalogueRefresh({ sql, rpcUrl, maxBlocksPerRun: 10_000_000n, dormantPoolLimit: 0, log: (m) => console.log(m) });
  console.log(JSON.stringify(s));
  if (s.caughtUp) break;
}
console.log("caught up with the chain head.");
