// One-off backfill for the issuer columns (scripts/migrate-issuers.mjs).
//
// Deliberately NOT lib/ledger/markIncompatibleMints.ts, which would do the
// right thing but ALSO re-evaluate ssr_status in the same pass -- and that
// flip is production-visible on a database prod and staging share. This
// writes issuer/issuer_checked_at and nothing else, so the picker's new
// filter has data without changing what any build currently offers.
//
// Routine upkeep is markIncompatibleMints from here on; this exists so the
// columns are not empty until its next weekly run.
//
//   DATABASE_URL=... npx tsx scripts/backfill-issuers.mts [--dry-run]
import * as fs from "node:fs";
import * as os from "node:os";
import { Connection, PublicKey } from "@solana/web3.js";
import { issuerOfMintAccount } from "../packages/sdk/src/mintExtensions";
import { getSql } from "../lib/ledger/db";

const DRY = process.argv.includes("--dry-run");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BATCH = 100;

const rpc = process.env.RPC ?? /json_rpc_url:\s*(\S+)/.exec(fs.readFileSync(`${os.homedir()}/.config/solana/cli/config.yml`, "utf8"))?.[1];
if (!rpc) throw new Error("No RPC: set RPC=... or configure the Solana CLI.");
const connection = new Connection(rpc, "confirmed");
const sql = getSql();

const rows = (await sql`
  select mint, symbol,
    to_jsonb(ledger_asset_catalogue) ->> 'issuer' as "issuer",
    to_jsonb(ledger_asset_catalogue) ->> 'issuer_checked_at' as "issuerCheckedAt"
  from ledger_asset_catalogue
  where token_program = ${TOKEN_2022} and removed_from_catalogue_at is null
`) as { mint: string; symbol: string | null; issuer: string | null; issuerCheckedAt: string | null }[];

console.log(`${rows.length} Token-2022 mint(s) to classify${DRY ? " (dry run)" : ""}`);
let attributed = 0, written = 0, unread = 0;
const bySymbol: string[] = [];

for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH);
  const keys = slice.map((r) => new PublicKey(r.mint));
  let infos;
  try {
    infos = await connection.getMultipleAccountsInfo(keys);
  } catch {
    // A failed batch leaves those rows untouched -- never record "no issuer"
    // because an RPC call failed.
    unread += slice.length;
    continue;
  }
  for (let j = 0; j < slice.length; j++) {
    const row = slice[j];
    if (!infos[j]) { unread += 1; continue; }
    const issuer = issuerOfMintAccount(keys[j], infos[j] as never);
    if (issuer) { attributed += 1; if (bySymbol.length < 8) bySymbol.push(`${row.symbol}`); }
    if (issuer !== row.issuer || row.issuerCheckedAt === null) {
      if (!DRY) {
        await sql`update ledger_asset_catalogue set issuer = ${issuer}, issuer_checked_at = now() where mint = ${row.mint}`;
      }
      written += 1;
    }
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.log(`attributed to a known issuer: ${attributed}`);
console.log(`rows written: ${written}${DRY ? " (would write)" : ""}`);
console.log(`accounts that could not be read: ${unread}`);
console.log(`examples: ${bySymbol.join(", ")}`);
