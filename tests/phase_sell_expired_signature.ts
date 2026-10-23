// A redeem whose transaction expired unlanded must not block the next attempt
// forever (live 2026-10-23: ALPHA redeem stuck on "could not be verified yet").
import { expect } from "chai";
import { unknownSignatureExpired, LEGACY_PENDING_EXPIRY_MS } from "../src/merge/lib/multiAssetSellClient";

describe("redeem resume: unknown signatures", () => {
  const now = 1_792_700_000_000;
  it("treats a signature as expired only past its blockhash's last valid block height", () => {
    expect(unknownSignatureExpired(1_000, 1_000, now, now)).to.equal(false);
    expect(unknownSignatureExpired(1_001, 1_000, now - 60 * 60_000, now)).to.equal(true);
    expect(unknownSignatureExpired(900, 1_000, now - 60 * 60_000, now)).to.equal(false);
  });
  it("falls back to the sale's age for records saved without the expiry height", () => {
    expect(unknownSignatureExpired(5_000, undefined, now - 60_000, now)).to.equal(false);
    expect(unknownSignatureExpired(5_000, undefined, now - LEGACY_PENDING_EXPIRY_MS - 1, now)).to.equal(true);
  });
});
