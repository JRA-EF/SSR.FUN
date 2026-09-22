// Offline guard for api/robinhood/rpc-proxy.ts -- the browser's only route to
// the keyed Robinhood Chain RPC. What must never regress: it stays read-only,
// it refuses unfiltered log scans, it recognises the provider's plan refusal
// (so discovery falls back instead of breaking), and it never forwards to
// anything but an https URL.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_robinhood_rpc_proxy.ts
import { expect } from "chai";
import { ALLOWED_METHODS, isPlanRefusal, rejectReason, upstreamUrl, PUBLIC_FALLBACK_RPC_URL, takeLocal, MAX_BATCH_SIZE, PER_IP_CALLS_PER_MIN, GLOBAL_CALLS_PER_MIN } from "../api/robinhood/rpc-proxy";

const req = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("api/robinhood/rpc-proxy -- read-only, keyed provider stays server-side", () => {
  it("never forwards a transaction or signing method (the user's wallet broadcasts its own)", () => {
    for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4", "debug_traceTransaction"]) {
      expect(ALLOWED_METHODS.has(m), m).to.equal(false);
      expect(rejectReason(req(m))?.error.code, m).to.equal(-32601);
    }
  });

  it("forwards the reads the app actually makes", () => {
    for (const m of ["eth_call", "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getTransactionReceipt"]) {
      expect(rejectReason(req(m)), m).to.equal(null);
    }
  });

  it("refuses eth_getLogs without a contract address, allows it with one", () => {
    expect(rejectReason(req("eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest" }]))?.error.code).to.equal(-32602);
    expect(rejectReason(req("eth_getLogs", [{ address: "not-an-address" }]))?.error.code).to.equal(-32602);
    expect(rejectReason(req("eth_getLogs", [{ address: [] }]))?.error.code).to.equal(-32602);
    expect(rejectReason(req("eth_getLogs", [{ address: "0x81dd183c53C95F251869520d8DB10B0A4a4F8858", fromBlock: "0x41b1a06" }]))).to.equal(null);
  });

  it("rejects malformed entries", () => {
    expect(rejectReason(null)?.error.code).to.equal(-32600);
    expect(rejectReason([req("eth_call")])?.error.code).to.equal(-32600);
    expect(rejectReason({ jsonrpc: "1.0", method: "eth_call" })?.error.code).to.equal(-32600);
  });

  it("recognises the provider's plan refusal (Chainstack -32002, live 2026-09-22) and nothing else", () => {
    expect(isPlanRefusal({ error: { code: -32002, message: "Archive, Debug and Trace requests are not available on your current plan." } })).to.equal(true);
    expect(isPlanRefusal({ error: { code: -32000, message: "execution reverted" } })).to.equal(false);
    expect(isPlanRefusal({ result: "0x1" })).to.equal(false);
  });

  it("uses the keyed URL only when it is https, else the public RPC", () => {
    const before = process.env.ROBINHOOD_RPC_URL;
    try {
      delete process.env.ROBINHOOD_RPC_URL;
      expect(upstreamUrl()).to.equal(PUBLIC_FALLBACK_RPC_URL);
      process.env.ROBINHOOD_RPC_URL = "http://insecure.example";
      expect(upstreamUrl()).to.equal(PUBLIC_FALLBACK_RPC_URL);
      process.env.ROBINHOOD_RPC_URL = "https://provider.example/key";
      expect(upstreamUrl()).to.equal("https://provider.example/key");
    } finally {
      if (before === undefined) delete process.env.ROBINHOOD_RPC_URL;
      else process.env.ROBINHOOD_RPC_URL = before;
    }
  });

  it("budgets in CALLS, not requests -- a batch cannot multiply the limit", () => {
    const key = `t-${Math.random()}`;
    const now = 1_000_000;
    // 120 calls/min: six 20-call batches fit, the seventh does not.
    const ok = Array.from({ length: 7 }, () => takeLocal(key, 20, PER_IP_CALLS_PER_MIN, 60_000, now));
    expect(ok).to.deep.equal([true, true, true, true, true, true, false]);
    // A new window resets the budget.
    expect(takeLocal(key, 20, PER_IP_CALLS_PER_MIN, 60_000, now + 60_000)).to.equal(true);
  });

  it("keeps the limits in the ranges the measured page cost justifies", () => {
    // A page load costs ~6-7 calls (measured 2026-09-22). These bounds stop a
    // later edit from quietly reopening the quota to scripted use.
    expect(MAX_BATCH_SIZE).to.be.at.most(20);
    expect(PER_IP_CALLS_PER_MIN).to.be.within(60, 300);
    expect(GLOBAL_CALLS_PER_MIN).to.be.within(PER_IP_CALLS_PER_MIN, 3_000);
  });
});
