// Reserve Activity Log indexer: keeps reserve_activity_log/
// reserve_activity_cursor (schema.sql) topped up from real on-chain data,
// so ManageDTR.tsx's Activity tab can read from Postgres instead of
// walking live RPC on every view -- see api/devnet/reserve-activity.ts,
// which calls syncReserveActivity best-effort before every read.
//
// Two bounded steps per call, never an unbounded scan:
//  1. Incremental top-up -- one fresh page from the newest signature.
//     ON CONFLICT DO NOTHING makes re-inserting already-known entries free,
//     so this is correct and cheap whether or not anything's new.
//  2. A bounded backfill step, continuing from wherever a prior call left
//     off (reserve_activity_cursor.oldest_signature_indexed), only while
//     backfill_complete is still false. A Reserve with a long real history
//     converges to fully indexed over a handful of calls, each one bounded
//     and fast -- never one big scan that risks a serverless timeout.
//
// syncReserveActivity never throws -- any RPC failure is caught and
// reported back as `syncError`, so a caller can still serve whatever is
// already in Postgres instead of failing the whole read.
import type { Connection, PublicKey } from "@solana/web3.js";
import { fetchReserveActivityLog, type ActivityLogEntry, type ActivityValuation } from "@ssr/sdk";
import { getSql } from "./db.js";
import { computeTopUpCursorUpdate, computeBackfillCursorUpdate, type CursorState, type CursorUpdate } from "./cursorLogic.js";
import type { ActivityCluster } from "./clusters.js";

// SsrProtocol (the Program's IDL type) isn't itself re-exported by name
// from @ssr/sdk -- deriving the parameter type from fetchReserveActivityLog's
// own signature avoids needing to name it directly.
type ReserveActivityProgram = Parameters<typeof fetchReserveActivityLog>[1];

const BACKFILL_MAX_PAGES_PER_STEP = 2;
// A top-up may need several pages to CONNECT with already-indexed history
// (stopAtSignature) when a burst of activity landed since the last sync --
// 4 pages = 200 signatures of headroom per call; anything beyond that is
// caught by cursorLogic's gap detection and closed by the backfill loop.
const TOP_UP_MAX_PAGES = 4;

/**
 * Reads this Reserve's cursor FOR the given cluster. A cursor row recorded
 * under a different cluster tag is poisoned, not reusable: before the
 * cluster column existed (DEC-0175), a Mainnet Reserve address could be
 * synced against the DevNet RPC (which has no history for it), leaving a
 * backfill_complete=true cursor with zero events that would permanently
 * mask the Reserve's real Mainnet history. Such a row (and any log rows
 * under the wrong tag) is deleted here so the sync below starts fresh --
 * self-healing, and a no-op once every row carries its true cluster.
 */
async function getCursor(reserve: string, cluster: ActivityCluster): Promise<CursorState | null> {
  const sql = getSql();
  const rows = await sql`
    select newest_signature_indexed, oldest_signature_indexed, backfill_complete, cluster
    from reserve_activity_cursor
    where reserve = ${reserve}
  `;
  const row = rows[0] as (CursorState & { cluster: string }) | undefined;
  if (!row) return null;
  if (row.cluster !== cluster) {
    await sql`delete from reserve_activity_log where reserve = ${reserve} and cluster <> ${cluster}`;
    await sql`delete from reserve_activity_cursor where reserve = ${reserve}`;
    return null;
  }
  return row;
}

async function upsertEntries(reserve: string, cluster: ActivityCluster, entries: ActivityLogEntry[]): Promise<void> {
  const sql = getSql();
  for (const e of entries) {
    // On conflict (an already-indexed event), the ONLY things that may change
    // are a null USD valuation being filled in -- a stored valuation is
    // frozen at first-indexing and never re-priced (DEC-0176) -- and a null
    // per-recipient payouts list (DEC-0206: rows indexed before that column
    // existed). Both are exact on-chain facts, never re-derived.
    await sql`
      insert into reserve_activity_log (reserve, cluster, signature, kind, event_index, ts, actor, summary, amount_raw, amount_kind, amount_raw_2, amount_kind_2, amount_usd, amount_usd_2, payouts)
      values (${reserve}, ${cluster}, ${e.signature}, ${e.kind}, ${e.eventIndex}, ${e.ts}, ${e.actor}, ${e.summary}, ${e.amountRaw ?? null}, ${e.amountKind ?? null}, ${e.amountRaw2 ?? null}, ${e.amountKind2 ?? null}, ${e.amountUsd ?? null}, ${e.amountUsd2 ?? null}, ${e.payouts ? JSON.stringify(e.payouts) : null})
      on conflict (reserve, signature, kind, event_index) do update set
        amount_usd = coalesce(reserve_activity_log.amount_usd, excluded.amount_usd),
        amount_usd_2 = coalesce(reserve_activity_log.amount_usd_2, excluded.amount_usd_2),
        payouts = coalesce(reserve_activity_log.payouts, excluded.payouts)
    `;
  }
}

/** `undefined` fields are left untouched on conflict (COALESCEd against the existing row). `backfill_complete` applies EXPLICIT values -- including the gap-detection regression to false (see cursorLogic.ts, DEC-0176) -- and keeps the existing value when undefined. */
async function upsertCursor(reserve: string, cluster: ActivityCluster, updates: CursorUpdate): Promise<void> {
  const sql = getSql();
  const newest = updates.newest_signature_indexed ?? null;
  const oldest = updates.oldest_signature_indexed ?? null;
  const complete = updates.backfill_complete === undefined ? null : updates.backfill_complete;
  await sql`
    insert into reserve_activity_cursor (reserve, cluster, newest_signature_indexed, oldest_signature_indexed, backfill_complete)
    values (${reserve}, ${cluster}, ${newest}, ${oldest}, ${complete ?? false})
    on conflict (reserve) do update set
      newest_signature_indexed = coalesce(${newest}, reserve_activity_cursor.newest_signature_indexed),
      oldest_signature_indexed = coalesce(${oldest}, reserve_activity_cursor.oldest_signature_indexed),
      backfill_complete = coalesce(${complete}, reserve_activity_cursor.backfill_complete),
      cluster = ${cluster},
      updated_at = now()
  `;
}

export async function syncReserveActivity(
  connection: Connection,
  program: ReserveActivityProgram,
  reserveAddress: PublicKey,
  cluster: ActivityCluster,
  valuation?: ActivityValuation,
): Promise<{ syncError: string | null }> {
  const reserve = reserveAddress.toBase58();
  try {
    const before = await getCursor(reserve, cluster);

    const topUp = await fetchReserveActivityLog(connection, program, reserveAddress, {
      maxPages: TOP_UP_MAX_PAGES,
      // Connect with already-indexed history instead of blindly re-walking
      // one page -- makes a no-new-activity top-up nearly free (the very
      // first signature matches) and lets cursorLogic detect a genuine gap
      // when the walk could NOT connect (DEC-0176).
      stopAtSignature: before?.newest_signature_indexed ?? undefined,
      valuation,
    });
    await upsertEntries(reserve, cluster, topUp.entries);
    await upsertCursor(
      reserve,
      cluster,
      computeTopUpCursorUpdate(before, {
        newestSignature: topUp.entries[0]?.signature ?? null,
        oldestSignatureWalked: topUp.oldestSignatureWalked,
        reachedRealEnd: topUp.reachedRealEnd,
        reachedKnownSignature: topUp.reachedKnownSignature,
      }),
    );

    const after = await getCursor(reserve, cluster);
    if (after && !after.backfill_complete) {
      const backfill = await fetchReserveActivityLog(connection, program, reserveAddress, {
        before: after.oldest_signature_indexed ?? undefined,
        maxPages: BACKFILL_MAX_PAGES_PER_STEP,
        valuation,
      });
      await upsertEntries(reserve, cluster, backfill.entries);
      await upsertCursor(
        reserve,
        cluster,
        computeBackfillCursorUpdate(after, {
          oldestSignatureWalked: backfill.oldestSignatureWalked,
          reachedRealEnd: backfill.reachedRealEnd,
        }),
      );
    }

    return { syncError: null };
  } catch (e) {
    return { syncError: e instanceof Error ? e.message : String(e) };
  }
}
