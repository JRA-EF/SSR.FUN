// Pure decision logic for how reserve_activity_cursor should change after a
// top-up or backfill walk -- split out from indexer.ts (which does the real
// RPC/DB I/O) so this is directly offline-testable, same rationale as
// createReserveResume.ts's split from createReserveClient.ts. No network or
// database code in this file at all.

export interface CursorState {
  newest_signature_indexed: string | null;
  oldest_signature_indexed: string | null;
  backfill_complete: boolean;
}

/** `undefined` means "leave this field alone" -- indexer.ts's upsertCursor COALESCEs against the existing row for any field left undefined here. */
export interface CursorUpdate {
  newest_signature_indexed?: string | null;
  oldest_signature_indexed?: string | null;
  backfill_complete?: boolean;
}

/**
 * After an incremental top-up walk (always one fresh page from the newest
 * signature, see indexer.ts's syncReserveActivity):
 *  - newest_signature_indexed always advances to the top-up's own newest
 *    entry (or is left alone if the top-up found nothing new).
 *  - oldest_signature_indexed is only seeded from THIS walk the very first
 *    time a Reserve is synced (no prior cursor) -- otherwise a routine
 *    top-up would yank an already-further-back backfill cursor forward to
 *    this page's boundary, discarding real backfill progress.
 *  - backfill_complete flips true, regardless of prior cursor state,
 *    whenever this single top-up page already covers the Reserve's ENTIRE
 *    history (reachedRealEnd) -- there's nothing left to backfill either
 *    way. It never regresses an already-true value back to false.
 */
export function computeTopUpCursorUpdate(
  before: CursorState | null,
  topUp: { newestSignature: string | null; oldestSignatureWalked: string | undefined; reachedRealEnd: boolean },
): CursorUpdate {
  const update: CursorUpdate = {
    newest_signature_indexed: topUp.newestSignature ?? before?.newest_signature_indexed ?? null,
  };
  if (!before) {
    update.oldest_signature_indexed = topUp.oldestSignatureWalked ?? null;
  }
  if (topUp.reachedRealEnd) {
    update.oldest_signature_indexed = topUp.oldestSignatureWalked ?? null;
    update.backfill_complete = true;
  }
  return update;
}

/**
 * After a bounded backfill step (walks further back from
 * oldest_signature_indexed, see indexer.ts's syncReserveActivity):
 * advances oldest_signature_indexed to wherever this step reached, and
 * marks backfill_complete once a page came back short (genuinely no more
 * history, not just this step's own page cap).
 */
export function computeBackfillCursorUpdate(
  after: CursorState,
  backfill: { oldestSignatureWalked: string | undefined; reachedRealEnd: boolean },
): CursorUpdate {
  return {
    oldest_signature_indexed: backfill.oldestSignatureWalked ?? after.oldest_signature_indexed ?? undefined,
    backfill_complete: backfill.reachedRealEnd || undefined,
  };
}
