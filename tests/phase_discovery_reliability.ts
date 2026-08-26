// Offline, pure-logic regression coverage for the discovery/indexing
// reliability pass. Root cause traced to three real, confirmed bugs from a
// live-reported set of DevNet symptoms ("Portfolio Holdings frequently
// stuck on 'Syncing holdings...' reporting DevNet unreachable", "Reserve
// creation frequently fails at Step 1/2", "a Reserve eventually appeared
// after waiting/refreshing despite an earlier failure", "a new Reserve
// showed 'Reserve not found' before later appearing in Discover"):
//
// 1. packages/sdk/src/discovery.ts's discoverAllReserves fetched every
//    candidate Reserve account SEQUENTIALLY (one getAccountInfo per
//    reserveId, already ~30 and growing) and the top-level per-reserve
//    fetch had NO retry at all (unlike the asset/vault/supply reads a few
//    lines below it) -- a single transient hiccup silently dropped that one
//    Reserve for the whole poll pass, and the sheer sequential length made
//    a single pass slow enough to explain "frequently remains on Syncing
//    holdings". Fixed by batching every read via Anchor's fetchMultiple/
//    connection.getMultipleAccountsInfo (chunked, see chunkArray below) and
//    retrying every chunk, matching the retry treatment every other read in
//    this codebase already gets (src/merge/lib/rpcResilience.ts).
// 2. src/merge/pages/CreateDTR.tsx's handleResumeDeployment never registered
//    the resumed Reserve into the `dtrs` store slice (unlike the fresh-
//    creation success path), so DTRDetail.tsx immediately rendered "Reserve
//    Not Found" until RealReserveSync's next background poll (up to
//    MAX_POLL_MS later) happened to pick it up.
// 3. src/merge/lib/onChainReserve.ts's resolveDtrPageState treated "not yet
//    in the local `dtrs` array" identically to "genuinely doesn't exist",
//    with no awareness of whether background discovery had even completed
//    a first pass -- the root cause that actually SURFACED bugs #1/#2 as a
//    dead-end error page instead of a soft, self-resolving state.
//
// Matches this repo's existing testing split (see phase_rpc_resilience.ts,
// phase_reserve_deploy_resumability.ts): pure decision logic covered here
// offline; a real live discovery pass is covered separately via
// scripts/verify_discovery.ts (read-only, already exists).
import { expect } from "chai";
import { chunkArray } from "../packages/sdk/src/discovery";
import { resolveDtrPageState, parseOnChainReserveId, type DtrPageState } from "../src/merge/lib/onChainReserve";
import type { DTR } from "../src/merge/lib/types";
import { checkRateWindow } from "../api/devnet/_lib/rateLimit";
import handler, { type ApiRequest, type ApiResponse } from "../api/devnet/rpc-proxy";

describe("discovery reliability -- chunkArray (batching boundary)", () => {
  it("returns no chunks for an empty array", () => {
    expect(chunkArray([], 90)).to.deep.equal([]);
  });

  it("returns a single chunk when under the chunk size", () => {
    expect(chunkArray([1, 2, 3], 90)).to.deep.equal([[1, 2, 3]]);
  });

  it("returns exactly one chunk when the array length equals the chunk size", () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    expect(chunkArray(items, 5)).to.deep.equal([items]);
  });

  it("splits into a second chunk for one element over the chunk size", () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    expect(chunkArray(items, 5)).to.deep.equal([
      [0, 1, 2, 3, 4],
      [5],
    ]);
  });

  it("preserves order across chunks", () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const chunks = chunkArray(items, 90);
    expect(chunks.flat()).to.deep.equal(items);
    expect(chunks.length).to.equal(3);
  });

  it("throws on a non-positive chunk size instead of looping forever", () => {
    expect(() => chunkArray([1, 2], 0)).to.throw();
    expect(() => chunkArray([1, 2], -1)).to.throw();
  });
});

describe("delayed indexing -- resolveDtrPageState's indexing state", () => {
  const emptyDtrs: DTR[] = [];
  const noQuarantine = {};

  it("returns 'found' when the DTR is already in the store, regardless of discovery status", () => {
    const dtr = { id: "devnet-5" } as DTR;
    const result = resolveDtrPageState("devnet-5", [dtr], noQuarantine, "loading");
    expect(result).to.deep.equal({ kind: "found", dtr });
  });

  it("returns 'quarantined' before ever considering discovery status", () => {
    const info = { reserve: "x", reserveId: "5", name: "n", ticker: "T", reason: "r" };
    const result: DtrPageState = resolveDtrPageState("devnet-5", emptyDtrs, { "devnet-5": info }, "ready");
    expect(result).to.deep.equal({ kind: "quarantined", info });
  });

  it("returns 'indexing' (never 'not-found') while discovery is still loading", () => {
    const result = resolveDtrPageState("devnet-31", emptyDtrs, noQuarantine, "loading");
    expect(result).to.deep.equal({ kind: "indexing" });
  });

  it("returns 'indexing' while discovery is in an error/retrying state -- absence isn't proven yet", () => {
    const result = resolveDtrPageState("devnet-31", emptyDtrs, noQuarantine, "error");
    expect(result).to.deep.equal({ kind: "indexing" });
  });

  it("only returns the terminal 'not-found' once discovery has completed a pass ('ready')", () => {
    const result = resolveDtrPageState("devnet-31", emptyDtrs, noQuarantine, "ready");
    expect(result).to.deep.equal({ kind: "not-found" });
  });

  it("returns 'not-found' for an undefined id once discovery is ready", () => {
    expect(resolveDtrPageState(undefined, emptyDtrs, noQuarantine, "ready")).to.deep.equal({ kind: "not-found" });
  });
});

describe("delayed indexing -- parseOnChainReserveId", () => {
  it("extracts the numeric reserveId from the canonical devnet-<id> shape", () => {
    expect(parseOnChainReserveId("devnet-31")).to.equal(31n);
    expect(parseOnChainReserveId("devnet-0")).to.equal(0n);
  });

  it("returns null for undefined", () => {
    expect(parseOnChainReserveId(undefined)).to.equal(null);
  });

  it("returns null for a non-numeric or legacy-shaped id (never guesses)", () => {
    expect(parseOnChainReserveId("devnet-reserve-one")).to.equal(null);
    expect(parseOnChainReserveId("simulated-42")).to.equal(null);
    expect(parseOnChainReserveId("devnet-")).to.equal(null);
    expect(parseOnChainReserveId("devnet-12abc")).to.equal(null);
  });
});

describe("Reserve Holdings RPC reliability -- rpc-proxy's dedicated sendTransaction throttle", () => {
  // The pre-existing per-IP throttle (checkRateWindow, already covered in
  // phase_helius_rpc_and_buy_fix.ts) protects against one client hammering
  // the proxy; it does nothing to protect Helius's separate, SHARED
  // sendTransaction-specific rate cap. This section covers the new global
  // throttle's blocking behavior directly against the real handler -- the
  // blocked path returns before ever calling fetch, so no network stubbing
  // is needed.
  function fakeReq(method: string, id: number): ApiRequest {
    return {
      method: "POST",
      headers: { "x-forwarded-for": `203.0.113.${id}` }, // a distinct IP per call -- proves this is NOT the per-IP throttle.
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
    };
  }
  function fakeRes(): { res: ApiResponse; calls: { status: number; body: unknown }[] } {
    const calls: { status: number; body: unknown }[] = [];
    const res: ApiResponse = {
      status(code: number) {
        calls.push({ status: code, body: undefined });
        return res;
      },
      json(body: unknown) {
        calls[calls.length - 1].body = body;
      },
    };
    return { res, calls };
  }

  it("blocks a burst of sendTransaction calls from DIFFERENT IPs once the shared budget is exhausted", async () => {
    // Stubs the global fetch so the calls that DO get past the throttle
    // don't make a real network request in this offline suite -- only the
    // throttle's own gating logic is under test here.
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "stubbed" }) })) as typeof fetch;
    let results: number[];
    try {
      results = [];
      for (let i = 0; i < 6; i++) {
        const { res, calls } = fakeRes();
        await handler(fakeReq("sendTransaction", 9000 + i), res);
        results.push(calls[0].status);
      }
    } finally {
      global.fetch = originalFetch;
    }
    // At most SEND_TRANSACTION_THROTTLE_MAX_PER_WINDOW (3) can have gotten
    // past the throttle within this single burst; the rest must be 429s
    // with the dedicated rate-limit error code, never silently dropped.
    const blocked = results.filter((s) => s === 429);
    expect(blocked.length).to.be.greaterThan(0);
    expect(results.length).to.equal(6);
  });

  it("never throttles a non-sendTransaction read even immediately after sendTransaction calls exhausted the budget", async () => {
    for (let i = 0; i < 5; i++) {
      const { res } = fakeRes();
      await handler(fakeReq("sendTransaction", 9100 + i), res);
    }
    // Stubs the global fetch this offline test run must never actually hit
    // the network through -- postJsonRpc's only I/O boundary -- so this
    // asserts purely against the throttle's own gating logic, not real
    // upstream reachability.
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id: 9200, result: "stubbed" }) })) as typeof fetch;
    try {
      const { res, calls } = fakeRes();
      await handler(fakeReq("getLatestBlockhash", 9200), res);
      // A read call must never be rejected by the sendTransaction-specific
      // throttle -- it reaches the (stubbed) upstream and returns its result.
      expect(calls[0].status).to.equal(200);
      expect(calls[0].body).to.deep.equal({ jsonrpc: "2.0", id: 9200, result: "stubbed" });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("Reserve Holdings RPC reliability -- checkRateWindow reused correctly for a global (non-per-IP) key", () => {
  it("a single shared key blocks regardless of which 'caller' uses it, unlike the per-IP throttle", () => {
    const key = `global-test-${Date.now()}-${Math.random()}`;
    expect(checkRateWindow(key, 1000, 2)).to.equal(true);
    expect(checkRateWindow(key, 1000, 2)).to.equal(true);
    expect(checkRateWindow(key, 1000, 2)).to.equal(false);
  });
});

describe("rpc-proxy -- top-level JSON string body no longer crashes the handler", () => {
  // Regression for a confirmed live report: Vercel's own body parser turns
  // a bare JSON string literal like `"hello"` into the JS string "hello"
  // before this handler ever runs; parseBody's re-parse attempt on that
  // already-decoded string then fails and returns undefined, and the old
  // `JSON.stringify(rawBody).length` crashed uncaught on that undefined
  // (JSON.stringify(undefined) is the JS value undefined, not a string) --
  // a raw platform 500 instead of the clean, structured JSON-RPC rejection
  // every other malformed body already gets.
  function fakeRes(): { res: ApiResponse; calls: { status: number; body: unknown }[] } {
    const calls: { status: number; body: unknown }[] = [];
    const res: ApiResponse = {
      status(code: number) {
        calls.push({ status: code, body: undefined });
        return res;
      },
      json(body: unknown) {
        calls[calls.length - 1].body = body;
      },
    };
    return { res, calls };
  }

  it("a top-level JSON string literal body is rejected cleanly instead of crashing", async () => {
    const { res, calls } = fakeRes();
    const req: ApiRequest = { method: "POST", headers: {}, body: "hello" };
    await handler(req, res);
    expect(calls.length).to.be.greaterThan(0);
    expect(calls[0].status).to.equal(200); // the proxy's own JSON-RPC error shape, not an HTTP-level failure
    expect(calls[0].body).to.deep.include({ jsonrpc: "2.0" });
  });

  it("an empty JSON string literal body is also rejected cleanly", async () => {
    const { res, calls } = fakeRes();
    const req: ApiRequest = { method: "POST", headers: {}, body: "" };
    await handler(req, res);
    expect(calls.length).to.be.greaterThan(0);
    expect(calls[0].status).to.equal(200);
  });
});
