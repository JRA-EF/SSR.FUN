// Pure-logic coverage for the Reserve Activity Log's resumable-backfill
// cursor decisions (lib/reserve-activity/cursorLogic.ts) -- no network or
// database code involved, consistent with this repo's offline
// pure-function test convention. See indexer.ts's syncReserveActivity for
// how these two functions drive the real Postgres upserts.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_reserve_activity_cursor.ts
import { expect } from "chai";
import { computeTopUpCursorUpdate, computeBackfillCursorUpdate, type CursorState } from "../lib/reserve-activity/cursorLogic";

describe("computeTopUpCursorUpdate (lib/reserve-activity/cursorLogic.ts)", () => {
  it("seeds the backfill starting point from this walk on the very first sync (no prior cursor)", () => {
    const update = computeTopUpCursorUpdate(null, { newestSignature: "sigNewest", oldestSignatureWalked: "sigOldestOfPage", reachedRealEnd: false, reachedKnownSignature: false });
    expect(update).to.deep.equal({
      newest_signature_indexed: "sigNewest",
      oldest_signature_indexed: "sigOldestOfPage",
    });
  });

  it("does NOT touch oldest_signature_indexed on a routine top-up that CONNECTED with known history -- would otherwise discard real backfill progress", () => {
    const existing: CursorState = { newest_signature_indexed: "sigA", oldest_signature_indexed: "sigVeryOld", backfill_complete: false };
    const update = computeTopUpCursorUpdate(existing, { newestSignature: "sigNewer", oldestSignatureWalked: "sigOfThisPage", reachedRealEnd: false, reachedKnownSignature: true });
    expect(update.newest_signature_indexed).to.equal("sigNewer");
    expect(update.oldest_signature_indexed).to.equal(undefined); // "leave alone" -- must not clobber sigVeryOld
    expect(update.backfill_complete).to.equal(undefined);
  });

  it("leaves newest_signature_indexed alone (falls back to the existing value) when the top-up found nothing new", () => {
    const existing: CursorState = { newest_signature_indexed: "sigA", oldest_signature_indexed: "sigOld", backfill_complete: false };
    const update = computeTopUpCursorUpdate(existing, { newestSignature: null, oldestSignatureWalked: undefined, reachedRealEnd: false, reachedKnownSignature: false });
    expect(update.newest_signature_indexed).to.equal("sigA");
    expect(update.backfill_complete).to.equal(undefined); // nothing walked -> no gap regression either
  });

  it("marks backfill_complete=true when this single top-up page already covers the Reserve's ENTIRE history, regardless of any prior partial backfill progress", () => {
    const existing: CursorState = { newest_signature_indexed: "sigA", oldest_signature_indexed: "sigSomewhatOld", backfill_complete: false };
    const update = computeTopUpCursorUpdate(existing, { newestSignature: "sigNewest", oldestSignatureWalked: "sigVeryFirstEver", reachedRealEnd: true, reachedKnownSignature: false });
    expect(update.backfill_complete).to.equal(true);
    expect(update.oldest_signature_indexed).to.equal("sigVeryFirstEver");
  });

  it("GAP DETECTION (DEC-0176): regresses backfill_complete to false and repoints the backfill cursor when a top-up with a prior cursor neither connected with known history nor reached the real end -- unindexed transactions sit in between", () => {
    const existing: CursorState = { newest_signature_indexed: "sigA", oldest_signature_indexed: "sigVeryFirstEver", backfill_complete: true };
    const update = computeTopUpCursorUpdate(existing, { newestSignature: "sigBurstNewest", oldestSignatureWalked: "sigBurstOldestWalked", reachedRealEnd: false, reachedKnownSignature: false });
    expect(update.backfill_complete).to.equal(false);
    expect(update.oldest_signature_indexed).to.equal("sigBurstOldestWalked");
    expect(update.newest_signature_indexed).to.equal("sigBurstNewest");
  });

  it("never falsely flags a gap on the FIRST sync of a Reserve (no prior cursor means nothing to connect with)", () => {
    const update = computeTopUpCursorUpdate(null, { newestSignature: "sigNewest", oldestSignatureWalked: "sigOldest", reachedRealEnd: false, reachedKnownSignature: false });
    expect(update.backfill_complete).to.equal(undefined);
  });
});

describe("computeBackfillCursorUpdate (lib/reserve-activity/cursorLogic.ts)", () => {
  it("advances oldest_signature_indexed to wherever this backfill step reached", () => {
    const after: CursorState = { newest_signature_indexed: "sigA", oldest_signature_indexed: "sigMidway", backfill_complete: false };
    const update = computeBackfillCursorUpdate(after, { oldestSignatureWalked: "sigFurtherBack", reachedRealEnd: false });
    expect(update.oldest_signature_indexed).to.equal("sigFurtherBack");
    expect(update.backfill_complete).to.equal(undefined);
  });

  it("marks backfill_complete=true once a page comes back short (genuinely reached the Reserve's first transaction)", () => {
    const after: CursorState = { newest_signature_indexed: "sigA", oldest_signature_indexed: "sigMidway", backfill_complete: false };
    const update = computeBackfillCursorUpdate(after, { oldestSignatureWalked: "sigVeryFirstEver", reachedRealEnd: true });
    expect(update.backfill_complete).to.equal(true);
  });

  it("falls back to the existing oldest_signature_indexed if this backfill step found no signatures at all", () => {
    const after: CursorState = { newest_signature_indexed: "sigA", oldest_signature_indexed: "sigMidway", backfill_complete: false };
    const update = computeBackfillCursorUpdate(after, { oldestSignatureWalked: undefined, reachedRealEnd: false });
    expect(update.oldest_signature_indexed).to.equal("sigMidway");
  });
});
