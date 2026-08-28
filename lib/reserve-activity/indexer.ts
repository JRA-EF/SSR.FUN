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
import { fetchReserveActivityLog, type ActivityLogEntry } from "@ssr/sdk";
import { getSql } from "./db.js";
import { computeTopUpCursorUpdate, computeBackfillCursorUpdate, type CursorState, type CursorUpdate } from "./cursorLogic.js";
import type { ActivityCluster } from "./clusters.js";

// SsrProtocol (the Program's IDL type) isn't itself re-exported by name
// from @ssr/sdk -- deriving the parameter type from fetchReserveActivityLog's
// own signature avoids needing to name it directly.
type ReserveActivityProgram = Parameters<typeof fetchReserveActivityLog>[1];

const BACKFILL_MAX_PAGES_PER_STEP = 2;

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
    await sql`
      insert into reserve_activity_log (reserve, cluster, signature, kind, ts, actor, summary, amount_raw, amount_kind, amount_raw_2, amount_kind_2)
      values (${reserve}, ${cluster}, ${e.signature}, ${e.kind}, ${e.ts}, ${e.actor}, ${e.summary}, ${e.amountRaw ?? null}, ${e.amountKind ?? null}, ${e.amountRaw2 ?? null}, ${e.amountKind2 ?? null})
      on conflict (reserve, signature, kind) do nothing
    `;
  }
}

/** `undefined` fields are left untouched on conflict (COALESCEd against the existing row); `backfill_complete` only ever flips true, never regresses. */
async function upsertCursor(reserve: string, cluster: ActivityCluster, updates: CursorUpdate): Promise<void> {
  const sql = getSql();
  const newest = updates.newest_signature_indexed ?? null;
  const oldest = updates.oldest_signature_indexed ?? null;
  const complete = updates.backfill_complete ?? false;
  await sql`
    insert into reserve_activity_cursor (reserve, cluster, newest_signature_indexed, oldest_signature_indexed, backfill_complete)
    values (${reserve}, ${cluster}, ${newest}, ${oldest}, ${complete})
    on conflict (reserve) do update set
      newest_signature_indexed = coalesce(${newest}, reserve_activity_cursor.newest_signature_indexed),
      oldest_signature_indexed = coalesce(${oldest}, reserve_activity_cursor.oldest_signature_indexed),
      backfill_complete = reserve_activity_cursor.backfill_complete or ${complete},
      cluster = ${cluster},
      updated_at = now()
  `;
}

export async function syncReserveActivity(
  connection: Connection,
  program: ReserveActivityProgram,
  reserveAddress: PublicKey,
  cluster: ActivityCluster,
): Promise<{ syncError: string | null }> {
  const reserve = reserveAddress.toBase58();
  try {
    const before = await getCursor(reserve, cluster);

    const topUp = await fetchReserveActivityLog(connection, program, reserveAddress, { maxPages: 1 });
    await upsertEntries(reserve, cluster, topUp.entries);
    await upsertCursor(
      reserve,
      cluster,
      computeTopUpCursorUpdate(before, {
        newestSignature: topUp.entries[0]?.signature ?? null,
        oldestSignatureWalked: topUp.oldestSignatureWalked,
        reachedRealEnd: topUp.reachedRealEnd,
      }),
    );

    const after = await getCursor(reserve, cluster);
    if (after && !after.backfill_complete) {
      const backfill = await fetchReserveActivityLog(connection, program, reserveAddress, {
        before: after.oldest_signature_indexed ?? undefined,
        maxPages: BACKFILL_MAX_PAGES_PER_STEP,
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
