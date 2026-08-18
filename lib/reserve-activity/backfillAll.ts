// Protocol-wide sweep for the /internal/kpis dashboard: syncReserveActivity
// (indexer.ts) is deliberately lazy and per-Reserve, only ever topped up
// when that ONE Reserve's own page is viewed -- fine for ManageDTR.tsx's
// Activity tab, but a KPI aggregate needs every Reserve's FULL history, not
// whatever happens to have been lazily viewed so far. This walks every
// discovered Reserve and repeatedly calls syncReserveActivity until each
// one's backfill_complete flips true (or a bounded step/time budget is hit),
// so the driver is safe to run from either a short-lived cron invocation or
// a manual "Refresh data" button -- always resumable, never assumes it
// finishes in one call.
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram, discoverAllReserves, DEVNET_FIXTURES, WRAPPED_SOL_MINT, DEVUSDC_MINT } from "@ssr/sdk";
import { syncReserveActivity } from "./indexer";
import { getSql } from "./db";

export interface BackfillAllResult {
  reservesDiscovered: number;
  reservesFullyBackfilled: number;
  reservesStillIncomplete: number;
  syncCallsMade: number;
  errors: string[];
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs bounded backfill steps across every discovered Reserve until either
 * every one reports `backfill_complete`, or `budgetMs` is spent -- whichever
 * comes first. Each Reserve gets at most `maxStepsPerReserve` sync calls per
 * invocation (matches indexer.ts's own bounded-step philosophy: never one
 * unbounded scan that risks a serverless timeout). Safe to call repeatedly
 * (e.g. every cron tick) -- a Reserve already marked complete costs one
 * cheap top-up call and is otherwise skipped.
 */
export async function backfillAllReserveActivity(
  connection: Connection,
  options: { budgetMs?: number; maxStepsPerReserve?: number } = {},
): Promise<BackfillAllResult> {
  const budgetMs = options.budgetMs ?? 45_000;
  const maxStepsPerReserve = options.maxStepsPerReserve ?? 3;
  const startedAt = Date.now();
  const errors: string[] = [];
  let syncCallsMade = 0;

  const programId = new PublicKey(DEVNET_FIXTURES.programId);
  const candidateMints = [
    new PublicKey(DEVNET_FIXTURES.mints.mintX.address),
    new PublicKey(DEVNET_FIXTURES.mints.mintY.address),
    new PublicKey(DEVNET_FIXTURES.mints.mintZ.address),
    WRAPPED_SOL_MINT,
    DEVUSDC_MINT,
  ];
  const { reserves } = await discoverAllReserves(connection, programId, candidateMints);
  const program = buildReadOnlyProgram(connection);

  // Order by LEAST-RECENTLY-ATTEMPTED first (never-attempted = oldest of
  // all, via COALESCE to the epoch), not discovery order. Without this, a
  // Reserve near the front of discoverAllReserves's fixed ordering that is
  // merely slow or permanently erroring (e.g. old history the event parser
  // can't decode) would consume the entire time budget on every single
  // sweep, forever starving every Reserve after it -- confirmed live: two
  // consecutive real sweeps against production produced byte-identical
  // results (same 6 fully backfilled, same 11 errors) because the loop
  // never got past the same handful of Reserves. Ordering by attempt
  // recency guarantees a Reserve that errors out still rotates to the back
  // of the queue for the NEXT sweep, so genuinely untouched Reserves get a
  // turn instead of the sweep spinning on the same failures indefinitely.
  const sql = getSql();
  const cursorRows = (await sql`select reserve, updated_at from reserve_activity_cursor`) as { reserve: string; updated_at: string }[];
  const lastAttempted = new Map(cursorRows.map((c) => [c.reserve, new Date(c.updated_at).getTime()]));
  const orderedReserves = [...reserves].sort((a, b) => (lastAttempted.get(a.reserve) ?? 0) - (lastAttempted.get(b.reserve) ?? 0));

  let fullyBackfilled = 0;
  for (const r of orderedReserves) {
    if (Date.now() - startedAt > budgetMs) break;
    const reserveAddress = new PublicKey(r.reserve);
    let complete = false;
    for (let step = 0; step < maxStepsPerReserve; step++) {
      if (Date.now() - startedAt > budgetMs) break;
      const { syncError } = await syncReserveActivity(connection, program, reserveAddress);
      syncCallsMade++;
      if (syncError) {
        errors.push(`${r.reserve}: ${syncError}`);
        break;
      }
    }
    // Cheap re-read of just this Reserve's cursor to see if the loop above
    // actually reached backfill_complete -- syncReserveActivity doesn't
    // return that flag directly, so ask the same source of truth
    // getCursor() does, one row, indexed lookup.
    const rows = await sql`select backfill_complete from reserve_activity_cursor where reserve = ${r.reserve}`;
    complete = Boolean((rows[0] as { backfill_complete?: boolean } | undefined)?.backfill_complete);
    if (complete) fullyBackfilled++;
  }

  const timedOut = Date.now() - startedAt > budgetMs;
  return {
    reservesDiscovered: reserves.length,
    reservesFullyBackfilled: fullyBackfilled,
    reservesStillIncomplete: reserves.length - fullyBackfilled,
    syncCallsMade,
    errors,
    timedOut,
    durationMs: Date.now() - startedAt,
  };
}
