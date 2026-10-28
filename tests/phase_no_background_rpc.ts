// An open tab must never keep draining RPC calls (Creator, 2026-10-28). One forgotten
// ssr.fun tab sent ~38,000 Helius calls an hour through /api/mainnet/rpc-proxy because
// RealReserveSync re-read every Reserve every 30 s, WalletSync re-read the SOL balance
// every 20 s and useMainnetKnownAssetMints refetched every 3 min (each new array also
// restarted a full chain pass). Measured locally through a counting relay over 150 s:
// 885 calls before, 253 (the one load pass) after, and none after that.
// They now read on load, after the user's own transaction, and when the user returns
// to a tab hidden for 5+ minutes. These checks keep timers from coming back.
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const FILES = ["src/merge/lib/RealReserveSync.tsx", "src/merge/lib/WalletSync.tsx", "src/merge/hooks/useMainnetKnownAssetMints.ts"];
const code = (src: string) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("no background RPC from open tabs", () => {
  for (const f of FILES) {
    it(`${f} has no repeating timer and refreshes when the user returns`, () => {
      const src = code(read(f));
      expect(src).not.to.match(/setInterval\(/);
      expect(src).to.include('addEventListener("visibilitychange"');
      expect(src).to.include("STALE_AFTER_MS = 5 * 60_000");
    });
  }

  it("discovery only re-arms a timer to retry a failed pass, a bounded number of times", () => {
    const src = code(read("src/merge/lib/RealReserveSync.tsx"));
    expect(src.match(/setTimeout\(/g) ?? []).to.have.length(1);
    expect(src).to.match(/if \(cancelled \|\| retries >= MAX_RETRIES\) return;/);
    expect(src).to.match(/if \(failed \|\| hitRateLimit\) scheduleRetry\(\);\s*else retries = 0;/);
  });

  it("discovery and the wallet balance refresh after the user's own transaction", () => {
    for (const f of ["src/merge/lib/RealReserveSync.tsx", "src/merge/lib/WalletSync.tsx"]) {
      expect(code(read(f))).to.match(/if \(prev\.txInFlight && !state\.txInFlight\)/);
    }
  });

  it("an unchanged known-mint list keeps its array, so it cannot restart a chain pass", () => {
    expect(read("src/merge/hooks/useMainnetKnownAssetMints.ts")).to.include('prev.join(",") === data.mints!.join(",") ? prev : data.mints!');
  });
});
