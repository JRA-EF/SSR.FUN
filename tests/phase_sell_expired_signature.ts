// A transaction that expired unlanded must never block the next attempt, and
// one still in flight must be waited for, never reset and repeated (live
// 2026-10-23: ALPHA redeem stuck on "could not be verified yet").
import { expect } from "chai";
import type { Connection } from "@solana/web3.js";
import { readFileSync } from "fs";
import { unknownSignatureExpired, resolveSubmittedSignature, LEGACY_PENDING_EXPIRY_MS } from "../src/merge/lib/rpcResilience";
import { redeemExpiredMessage, REDEEM_AUTO_RETRY_LIMIT } from "../src/merge/lib/multiAssetSellClient";

type Status = { err: unknown; confirmationStatus: string } | null;
function fakeConnection(heights: number[], statuses: Status[]): Connection {
  let h = 0;
  let s = 0;
  return {
    getBlockHeight: async () => heights[Math.min(h++, heights.length - 1)],
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [statuses[Math.min(s++, statuses.length - 1)]] }),
  } as unknown as Connection;
}

describe("resuming a submitted transaction: expired vs in flight", () => {
  const now = 1_792_700_000_000;
  it("treats a signature as expired only past its blockhash's last valid block height", () => {
    expect(unknownSignatureExpired(1_000, 1_000, now, now)).to.equal(false);
    expect(unknownSignatureExpired(1_001, 1_000, now - 60 * 60_000, now)).to.equal(true);
    expect(unknownSignatureExpired(900, 1_000, now - 60 * 60_000, now)).to.equal(false);
  });

  it("falls back to the record's age when it was saved without the expiry height", () => {
    expect(unknownSignatureExpired(5_000, undefined, now - 60_000, now)).to.equal(false);
    expect(unknownSignatureExpired(5_000, undefined, now - LEGACY_PENDING_EXPIRY_MS - 1, now)).to.equal(true);
  });

  it("waits for a signature still in flight until it confirms", async () => {
    const c = fakeConnection([990, 995, 998], [null, null, { err: null, confirmationStatus: "confirmed" }]);
    expect(await resolveSubmittedSignature(c, "sig", 1_000, Date.now(), { intervalMs: 1 })).to.equal("confirmed");
  });

  it("waits for a signature still in flight until its blockhash runs out", async () => {
    const c = fakeConnection([990, 999, 1_001], [null]);
    expect(await resolveSubmittedSignature(c, "sig", 1_000, Date.now(), { intervalMs: 1 })).to.equal("expired");
  });

  it("reports an on-chain failure, and 'unknown' only when the RPC cannot answer in time", async () => {
    expect(await resolveSubmittedSignature(fakeConnection([990], [{ err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }]), "sig", 1_000, Date.now(), { intervalMs: 1 })).to.equal("failed");
    const broken = { getBlockHeight: async () => { throw new Error("down"); }, getSignatureStatuses: async () => { throw new Error("down"); } } as unknown as Connection;
    expect(await resolveSubmittedSignature(broken, "sig", 1_000, Date.now(), { intervalMs: 1, maxWaitMs: 5 })).to.equal("unknown");
  });

  it("an expired redeem is rebuilt and re-signed, and its message says nothing moved and to press Redeem again", () => {
    expect(REDEEM_AUTO_RETRY_LIMIT).to.be.at.least(1);
    const m = redeemExpiredMessage("SIG");
    expect(m).to.match(/Nothing was redeemed or moved/);
    expect(m).to.match(/Press Redeem again/);
    const src = readFileSync("src/merge/lib/multiAssetSellClient.ts", "utf8");
    expect(src).to.match(/if \(redeemExpired\(outcome, signature, attempt\)\) continue;/);
    expect(src).to.match(/redeemLastValidBlockHeight = t\.lastValidBlockHeight/);
  });

  it("the mint path saves each swap's and the mint's expiry and waits instead of resetting an in-flight swap", () => {
    const src = readFileSync("src/merge/lib/multiAssetBuyClient.ts", "utf8");
    expect(src).to.match(/lastSignature: sig, lastValidBlockHeight: job\.tx\.lastValidBlockHeight/);
    expect(src).to.match(/lastMintLastValidBlockHeight = /);
    expect(src).to.not.match(/previous swap signature not found on-chain -- leg reset/);
  });
});
