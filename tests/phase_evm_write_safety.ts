// Write-path safety, pinned after a real-money run on Base mainnet surfaced
// each of these. Mocks only -- no network.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_evm_write_safety.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSettled, sendChecked } from "../src/merge/lib/evmReserve";

const OWNER = "0x8b41e427BD610F49b3cAE8851428EB1e6DB88B24" as const;
const call = { address: "0x5b87190D4a54F3fc43ee0196Dd1f27f96A5e7b50" as const, abi: [] as readonly unknown[], functionName: "redeem", args: [] as readonly unknown[], account: OWNER, chain: { id: 8453 } as never };

function mocks(status: "success" | "reverted", estimate = 162_042n) {
  const sent: Record<string, unknown>[] = [];
  const pc = {
    simulateContract: async () => ({ request: { address: call.address, functionName: "redeem", account: OWNER } }),
    estimateContractGas: async () => estimate,
    waitForTransactionReceipt: async () => ({ status }),
  };
  const wallet = { account: { address: OWNER, type: "local" }, writeContract: async (req: Record<string, unknown>) => { sent.push(req); return "0xabc" as const; } };
  return { pc: pc as never, wallet: wallet as never, sent };
}

describe("sendChecked: the way every SSR write goes out", () => {
  it("throws on a mined-but-reverted transaction instead of reporting success", async () => {
    const { pc, wallet } = mocks("reverted");
    let err: Error | null = null;
    try { await sendChecked(pc, wallet, call, "redemption"); } catch (e) { err = e as Error; }
    expect(err?.message).to.match(/mined but reverted on-chain/);
  });

  it("returns the hash when the receipt succeeded", async () => {
    const { pc, wallet } = mocks("success");
    expect(await sendChecked(pc, wallet, call, "redemption")).to.equal("0xabc");
  });

  it("sends with 30% gas headroom -- a bare estimate ran a Base redeem out of gas at 160,031 / 162,042", async () => {
    const { pc, wallet, sent } = mocks("success", 162_042n);
    await sendChecked(pc, wallet, call, "redemption");
    expect(sent[0].gas).to.equal((162_042n * 130n) / 100n);
  });

  it("signs with the wallet's own account, not the simulation's bare address", async () => {
    const { pc, wallet, sent } = mocks("success");
    await sendChecked(pc, wallet, call, "redemption");
    expect((sent[0].account as { type?: string }).type, "a bare address makes a local signer ask the node to sign").to.equal("local");
  });
});

describe("readSettled: reads after a write wait for a backend that has caught up", () => {
  it("re-reads until the condition holds", async () => {
    const answers = [0n, 0n, 7n];
    let i = 0;
    const v = await readSettled(async () => answers[Math.min(i++, answers.length - 1)], (x) => x > 0n);
    expect(v).to.equal(7n);
    expect(i).to.equal(3);
  });
});

describe("every money-path write checks its receipt", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("swaps, approvals and deploys throw on a reverted receipt", () => {
    expect(read("src/merge/lib/evmSwap.ts"), "swap").to.match(/receipt\.status !== "success"/);
    const reserve = read("src/merge/lib/evmReserve.ts");
    expect(reserve, "approval").to.match(/approval was mined but reverted/);
    expect(reserve, "deploy").to.match(/deployment was mined but reverted/);
  });

  it("every receipt wait is patient enough for an L1 block -- viem's default gave up on a mined Ethereum approval", () => {
    for (const f of ["src/merge/lib/evmSwap.ts", "src/merge/lib/evmReserve.ts"]) {
      const waits = read(f).match(/waitForTransactionReceipt\(\{[^}]*\}/g) ?? [];
      expect(waits.length, f).to.be.greaterThan(0);
      for (const w of waits) expect(w, `${f}: ${w}`).to.include("timeout: RECEIPT_TIMEOUT_MS");
    }
  });

  it("the Reserve page mints and redeems through sendChecked, with redeem minimums", () => {
    const page = read("src/merge/components/robinhood/RobinhoodReserveDetail.tsx");
    expect(page).to.match(/sendChecked\([\s\S]*?"mint"/);
    expect(page).to.match(/sendChecked\([\s\S]*?"redemption"/);
    expect(page, "redeem must not accept zero minimums").to.not.match(/assets\.map\(\(\) => 0n\)/);
  });

  it("the launch waits for a visible balance after each swap, not a single read", () => {
    expect(read("src/merge/lib/evmLaunch.ts")).to.include("balanceAbove(pc, q.leg.asset.address, account, before)");
  });
});
