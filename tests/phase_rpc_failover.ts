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
