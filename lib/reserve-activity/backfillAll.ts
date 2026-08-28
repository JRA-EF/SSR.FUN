// Protocol-wide sweep for the /internal/kpis dashboard: syncReserveActivity
// (indexer.ts) is deliberately lazy and per-Reserve, only ever topped up
// when that ONE Reserve's own page is viewed -- fine for ManageDTR.tsx's
// Activity tab, but a KPI aggregate needs every Reserve's FULL history, not
// whatever happens to have been lazily viewed so far. This walks every
// discovered Reserve on every target cluster and repeatedly calls
// syncReserveActivity until each one's backfill_complete flips true (or a
// bounded step/time budget is hit), so the driver is safe to run from
// either a short-lived cron invocation or a manual "Refresh data" button --
// always resumable, never assumes it finishes in one call.
//
// Cluster-aware since DEC-0175: targets come from clusters.ts (Mainnet
// first, since it is the live protocol), and each cluster's discovery
// failure is isolated -- recorded in that cluster's result, never thrown,
// so DevNet's currently-undecodable upgraded program (see clusters.ts's
// header) cannot starve or fail the Mainnet sweep.
import { PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram, discoverAllReserves } from "@ssr/sdk";
import { syncReserveActivity } from "./indexer";
import { getSql } from "./db";
import type { ActivityCluster, ClusterTarget } from "./clusters";

export interface ClusterSweepResult {
  cluster: ActivityCluster;
  reservesDiscovered: number;
  reservesFullyBackfilled: number;
  reservesStillIncomplete: number;
  syncCallsMade: number;
  /** A discovery-level failure for this whole cluster (per-Reserve sync errors go in `errors` on the aggregate). */
  discoveryError: string | null;
}

export interface BackfillAllResult {
  reservesDiscovered: number;
  reservesFullyBackfilled: number;
  reservesStillIncomplete: number;
  syncCallsMade: number;
  errors: string[];
  timedOut: boolean;
  durationMs: number;
  clusters: ClusterSweepResult[];
}

/**
 * Runs bounded backfill steps across every discovered Reserve on every
 * target cluster until either every one reports `backfill_complete`, or
 * `budgetMs` is spent -- whichever comes first. The budget is shared across
 * clusters in target order (Mainnet first). Each Reserve gets at most
 * `maxStepsPerReserve` sync calls per invocation (matches indexer.ts's own
 * bounded-step philosophy: never one unbounded scan that risks a serverless
 * timeout). Safe to call repeatedly (e.g. every cron tick) -- a Reserve
 * already marked complete costs one cheap top-up call and is otherwise
 * skipped.
 */
export async function backfillAllReserveActivity(
  targets: ClusterTarget[],
  options: { budgetMs?: number; maxStepsPerReserve?: number } = {},
): Promise<BackfillAllResult> {
  const budgetMs = options.budgetMs ?? 45_000;
  const maxStepsPerReserve = options.maxStepsPerReserve ?? 3;
  const startedAt = Date.now();
  const errors: string[] = [];
  const clusterResults: ClusterSweepResult[] = [];
  let syncCallsMade = 0;
  let totalDiscovered = 0;
  let totalFullyBackfilled = 0;

  const sql = getSql();

  for (const target of targets) {
    const clusterResult: ClusterSweepResult = {
      cluster: target.cluster,
      reservesDiscovered: 0,
      reservesFullyBackfilled: 0,
      reservesStillIncomplete: 0,
      syncCallsMade: 0,
      discoveryError: null,
    };
    clusterResults.push(clusterResult);
    if (Date.now() - startedAt > budgetMs) continue;

    let reserves: Awaited<ReturnType<typeof discoverAllReserves>>["reserves"];
    try {
      const candidateMints = await target.candidateMints();
      ({ reserves } = await discoverAllReserves(target.connection, target.programId, candidateMints));
    } catch (e) {
      clusterResult.discoveryError = e instanceof Error ? e.message : String(e);
      errors.push(`${target.cluster}: discovery failed: ${clusterResult.discoveryError}`);
      continue;
    }
    clusterResult.reservesDiscovered = reserves.length;
    totalDiscovered += reserves.length;
    const program = buildReadOnlyProgram(target.connection);

    // Per-Reserve USD valuation contexts (DEC-0176) -- best-effort: pricing
    // being unavailable indexes events unvalued (never blocks the sweep,
    // never fabricates); the on-conflict upsert fills a null valuation in on
    // a later sweep.
    const valuations = target.buildValuations ? await target.buildValuations(reserves) : null;

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
    const cursorRows = (await sql`select reserve, updated_at from reserve_activity_cursor`) as { reserve: string; updated_at: string }[];
    const lastAttempted = new Map(cursorRows.map((c) => [c.reserve, new Date(c.updated_at).getTime()]));
    const orderedReserves = [...reserves].sort((a, b) => (lastAttempted.get(a.reserve) ?? 0) - (lastAttempted.get(b.reserve) ?? 0));

    for (const r of orderedReserves) {
      if (Date.now() - startedAt > budgetMs) break;
      const reserveAddress = new PublicKey(r.reserve);
      for (let step = 0; step < maxStepsPerReserve; step++) {
        if (Date.now() - startedAt > budgetMs) break;
        const { syncError } = await syncReserveActivity(target.connection, program, reserveAddress, target.cluster, valuations?.get(r.reserve));
        syncCallsMade++;
        clusterResult.syncCallsMade++;
        if (syncError) {
          errors.push(`${target.cluster}: ${r.reserve}: ${syncError}`);
          break;
        }
      }
      // Cheap re-read of just this Reserve's cursor to see if the loop above
      // actually reached backfill_complete -- syncReserveActivity doesn't
      // return that flag directly, so ask the same source of truth
      // getCursor() does, one row, indexed lookup.
      const rows = await sql`select backfill_complete from reserve_activity_cursor where reserve = ${r.reserve}`;
      if ((rows[0] as { backfill_complete?: boolean } | undefined)?.backfill_complete) {
        clusterResult.reservesFullyBackfilled++;
        totalFullyBackfilled++;
      }
    }
    clusterResult.reservesStillIncomplete = clusterResult.reservesDiscovered - clusterResult.reservesFullyBackfilled;
  }

  const timedOut = Date.now() - startedAt > budgetMs;
  return {
    reservesDiscovered: totalDiscovered,
    reservesFullyBackfilled: totalFullyBackfilled,
    reservesStillIncomplete: totalDiscovered - totalFullyBackfilled,
    syncCallsMade,
    errors,
    timedOut,
    durationMs: Date.now() - startedAt,
    clusters: clusterResults,
  };
}
