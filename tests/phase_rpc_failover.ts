import { expect } from "chai";
import { failoverFetch, isRefusedStatus, resetRpcFailover, FALLBACK_RPC_URL } from "../api/mainnet/_lib/rpc";

describe("Mainnet RPC failover (2026-11-14: Helius answered 403 to everything)", () => {
  const PRIMARY = "https://primary.example/?api-key=x";
  beforeEach(() => resetRpcFailover());
  const fake = (statusFor: (url: string) => number, calls: string[]) =>
    (async (u: any) => { calls.push(String(u)); return new Response("{}", { status: statusFor(String(u)) }); }) as unknown as typeof fetch;

  it("treats 401/403/429 as refused, not 500", () => {
    expect([401, 403, 429].every(isRefusedStatus)).to.equal(true);
    expect(isRefusedStatus(500)).to.equal(false);
    expect(isRefusedStatus(200)).to.equal(false);
  });

  it("uses the primary when it answers", async () => {
    const calls: string[] = [];
    const res = await failoverFetch(PRIMARY, FALLBACK_RPC_URL, fake(() => 200, calls))(PRIMARY, {});
    expect(res.status).to.equal(200);
    expect(calls).to.deep.equal([PRIMARY]);
  });

  it("repeats a refused call on the fallback, then skips the primary for a while", async () => {
    const calls: string[] = [];
    const f = failoverFetch(PRIMARY, FALLBACK_RPC_URL, fake((u) => (u === PRIMARY ? 403 : 200), calls));
    expect((await f(PRIMARY, {})).status).to.equal(200);
    expect((await f(PRIMARY, {})).status).to.equal(200);
    expect(calls).to.deep.equal([PRIMARY, FALLBACK_RPC_URL, FALLBACK_RPC_URL]);
  });

  it("does not fail over on a server error (the request may have run)", async () => {
    const calls: string[] = [];
    const res = await failoverFetch(PRIMARY, FALLBACK_RPC_URL, fake(() => 500, calls))(PRIMARY, {});
    expect(res.status).to.equal(500);
    expect(calls).to.deep.equal([PRIMARY]);
  });
});

describe("Mainnet RPC proxy: a plain-text refusal fails over (2026-11-14 watcher: 'Mainnet RPC endpoint unreachable' on Reserve creation)", () => {
  const realFetch = globalThis.fetch;
  const PRIMARY = "https://primary.example/?api-key=x";
  let calls: string[] = [];
  before(() => { process.env.HELIUS_MAINNET_RPC_URL = PRIMARY; });
  after(() => { globalThis.fetch = realFetch; delete process.env.HELIUS_MAINNET_RPC_URL; });
  beforeEach(() => {
    calls = [];
    // Helius's real refusal: HTTP 403 with the plain-text body "Forbidden".
    globalThis.fetch = (async (u: any, init?: any) => {
      calls.push(String(u));
      if (String(u) === PRIMARY) return new Response("Forbidden", { status: 403 });
      const req = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "sig" }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  const call = async (body: unknown) => {
    const { default: handler } = await import("../api/mainnet/rpc-proxy");
    let status = 0; let json: any;
    const res: any = { status(c: number) { status = c; return res; }, json(b: unknown) { json = b; } };
    await handler({ method: "POST", headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` }, body }, res);
    return { status, json };
  };

  it("sends a transaction through the fallback instead of answering 502", async () => {
    const r = await call({ jsonrpc: "2.0", id: 7, method: "sendTransaction", params: ["AAAA"] });
    expect(r.status).to.equal(200);
    expect(r.json.result).to.equal("sig");
    expect(calls).to.deep.equal([PRIMARY, FALLBACK_RPC_URL]);
  });

  it("does not retry the refused primary before failing over", async () => {
    await call({ jsonrpc: "2.0", id: 8, method: "getBlockHeight" });
    expect(calls.filter((u) => u === PRIMARY).length).to.equal(1);
  });

  it("still answers 502, never a null body, when the fallback refuses too", async () => {
    globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response("Forbidden", { status: 403 }); }) as unknown as typeof fetch;
    const r = await call({ jsonrpc: "2.0", id: 9, method: "sendTransaction", params: ["AAAA"] });
    expect(r.status).to.equal(502);
    expect(r.json.error.code).to.equal(-32003);
  });
});
