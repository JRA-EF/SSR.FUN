// The instant snapshot seed must show a Reserve's CURRENT profile picture
// (the pointer set by a picture edit), not wait seconds for the first live
// poll -- reported 2026-10-28 on Reserve 59, whose picture lives only in the
// pointer map.
import { expect } from "chai";
import { readFileSync } from "node:fs";

describe("snapshot seed: profile pictures", () => {
  it("applies the image pointer map to the seeded Reserves, sharing RealReserveSync's cache key", () => {
    const hydrator = readFileSync("src/merge/lib/ReserveSnapshotHydrator.tsx", "utf8");
    const sync = readFileSync("src/merge/lib/RealReserveSync.tsx", "utf8");
    const key = "`reserve-image-pointers:${SOLANA_CLUSTER}`";
    expect(hydrator).to.include(key).and.match(/fetchReserveImagePointers\(/).and.match(/logoUrl: pointedImageUrl/);
    expect(sync).to.include(key);
  });
});
