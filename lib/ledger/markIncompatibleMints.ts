// Marks catalogue mints the PROGRAM will refuse, so they never reach the
// asset picker (DEC-0205).
//
// DEC-0201 opened the picker to Token-2022. That was half the job: the
// program accepts Token-2022 but rejects five specific extensions at
// initialize_reserve_asset, because each breaks an assumption the protocol
// depends on. Without this pass the picker offers mints that cannot be
// registered, and the user pays for a Reserve-creation transaction to find
// out -- live 2026-09-11 with PUMP, which carries a transfer hook.
//
// Runs after the weekly Jupiter snapshot. Only Token-2022 mints are read
// (classic mints carry no extension data and are always fine), so this is
// roughly 1,600 accounts in batches of 100 -- about sixteen RPC calls, once
// a week.
import { Connection, PublicKey } from "@solana/web3.js";
import { assessMintAccount, issuerOfMintAccount } from "@ssr/sdk";
import { getSql } from "./db";

const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BATCH = 100;

export interface IncompatibleMintsResult {
  checked: number;
  marked: number;
  cleared: number;
  /** Mints whose recorded issuer changed this run (first classification included). */
  issuersRecorded: number;
  examples: { mint: string; symbol: string; reason: string }[];
}

/**
 * Reads every Token-2022 mint in the catalogue and records whether this
 * protocol can hold it.
 *
 * Marking uses `ssr_status = 'disabled'` with an `incompatibility_reason`,
 * which the catalogue query already excludes. A manual `'blocklisted'` is
 * never overwritten -- that is a human decision and outranks this one. A mint
 * previously auto-disabled that now reads as compatible is restored to
 * 'unreviewed', so a mis-read during an RPC blip is self-correcting rather
 * than permanently hiding a legitimate asset.
 */
export async function markIncompatibleMints(connection: Connection): Promise<IncompatibleMintsResult> {
  const sql = getSql();
  const rows = (await sql`
    select mint, symbol, ssr_status as "ssrStatus",
      -- via to_jsonb so a deployment that precedes scripts/migrate-issuers.mjs
      -- reads null instead of failing on a missing column (same guard as
      -- api/ledger/asset-catalogue.ts uses for the launchpad columns)
      to_jsonb(ledger_asset_catalogue) ->> 'issuer' as "issuer",
      to_jsonb(ledger_asset_catalogue) ->> 'issuer_checked_at' as "issuerCheckedAt"
    from ledger_asset_catalogue
    where token_program = ${TOKEN_2022_PROGRAM_ID}
      and removed_from_catalogue_at is null
      and ssr_status <> 'blocklisted'
  `) as { mint: string; symbol: string | null; ssrStatus: string; issuer: string | null; issuerCheckedAt: string | null }[];

  const result: IncompatibleMintsResult = { checked: 0, marked: 0, cleared: 0, issuersRecorded: 0, examples: [] };

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const keys = slice.map((r) => new PublicKey(r.mint));
    let infos: ({ data: Buffer; owner: PublicKey } | null)[];
    try {
      infos = (await connection.getMultipleAccountsInfo(keys)) as never;
    } catch {
      // A failed batch leaves those rows exactly as they were. Never mark a
      // mint unsupported because an RPC call failed.
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const row = slice[j];
      const compat = assessMintAccount(keys[j], infos[j]);
      result.checked += 1;

      // Issuer provenance rides along on the account we already fetched:
      // the same PermanentDelegate the compatibility check reads is the
      // issuer's proof (packages/sdk/src/issuers.ts). Always stamp
      // issuer_checked_at, so "not from a known issuer" is a recorded fact
      // rather than an unclassified row. Skipped when the account did not
      // load, since a failed read must never erase a known issuer.
      if (infos[j]) {
        const issuer = issuerOfMintAccount(keys[j], infos[j]);
        // Write only on a change or a first classification: this pass sees
        // ~1,700 mints a week and almost none of them ever change issuer, so
        // an unconditional update would be 1,700 pointless round trips.
        if (issuer !== row.issuer || row.issuerCheckedAt === null) {
          await sql`
            update ledger_asset_catalogue
               set issuer = ${issuer}, issuer_checked_at = now()
             where mint = ${row.mint}
          `;
          result.issuersRecorded += 1;
        }
      }
      if (!compat.supported) {
        if (row.ssrStatus !== "disabled") {
          await sql`
            update ledger_asset_catalogue
               set ssr_status = 'disabled', incompatibility_reason = ${compat.reason}, updated_at = now()
             where mint = ${row.mint}
          `;
          result.marked += 1;
          if (result.examples.length < 10) result.examples.push({ mint: row.mint, symbol: row.symbol ?? "", reason: compat.reason ?? "" });
        }
      } else if (row.ssrStatus === "disabled") {
        await sql`
          update ledger_asset_catalogue
             set ssr_status = 'unreviewed', incompatibility_reason = null, updated_at = now()
           where mint = ${row.mint}
        `;
        result.cleared += 1;
      }
    }
  }
  return result;
}
