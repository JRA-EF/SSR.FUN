// Automatic swap retry policy (jupiterSwapClient.partitionSwapOutcomes /
// JupiterSwapNotLandedError) shared by the multi-asset Buy batch and the
// one-approval Sell fallback.
//
// Live motivation (2026-09-07, tester on Reserve GOLF, sig 48hDBgg3...vvi5b):
// a pump-token Jupiter route failed inside one DEX hop (custom error 0xe,
// ~4k CU -- an early pool precondition, not slippage). The old sequential
// flow stopped at leg 1 and told the user to press Buy again; their manual
// retry with a fresh quote landed first try. That retry is now automatic --
// but ONLY for a swap that provably did not land. An ambiguous confirmation
// must never be auto-retried (a second swap could land beside a first that
// quietly succeeded), and neither may any other error (RPC, balance read).
import { expect } from "chai";
import {
  JupiterSwapNotLandedError,
  partitionSwapOutcomes,
  SWAP_AUTO_RETRY_LIMIT,
} from "../src/merge/lib/jupiterSwapClient";
import { AmbiguousConfirmationError } from "../src/merge/lib/rpcResilience";

const rejected = (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason });
const fulfilled = (): PromiseFulfilledResult<void> => ({ status: "fulfilled", value: undefined });

describe("Automatic swap retry policy (partitionSwapOutcomes) -- retry only what provably did not land", () => {
  const legs = ["mintA", "mintB", "mintC"];

  it("exactly one automatic retry is allowed (one extra wallet approval at most, never a loop)", () => {
    expect(SWAP_AUTO_RETRY_LIMIT).to.equal(1);
  });

  it("a leg whose swap executed-and-FAILED on-chain (the live GOLF 0xe case) is retryable; landed legs are left alone", () => {
    const { retryable, fatal } = partitionSwapOutcomes(legs, [
      rejected(new JupiterSwapNotLandedError("failed", "sigA", "Jupiter swap was rejected on-chain (error code 14).")),
      fulfilled(),
      fulfilled(),
    ]);
    expect(retryable).to.deep.equal(["mintA"]);
    expect(fatal).to.equal(null);
  });

  it("a leg whose swap EXPIRED unincluded (blockhash no longer valid while a sibling/redeem was confirming) is retryable", () => {
    const { retryable, fatal } = partitionSwapOutcomes(legs, [
      fulfilled(),
      rejected(new JupiterSwapNotLandedError("expired", "sigB", "Jupiter swap expired before it could be confirmed.")),
      rejected(new JupiterSwapNotLandedError("failed", "sigC", "rejected on-chain")),
    ]);
    expect(retryable).to.deep.equal(["mintB", "mintC"]);
    expect(fatal).to.equal(null);
  });

  it("an AMBIGUOUS confirmation is NEVER retryable -- it is fatal even when other legs would otherwise be retried", () => {
    const ambiguous = new AmbiguousConfirmationError("sigB", "Mainnet");
    const { retryable, fatal } = partitionSwapOutcomes(legs, [
      rejected(new JupiterSwapNotLandedError("failed", "sigA", "rejected on-chain")),
      rejected(ambiguous),
      fulfilled(),
    ]);
    expect(fatal).to.equal(ambiguous);
    // The caller throws `fatal` before looking at retryable -- but the
    // policy still reports the retryable set honestly.
    expect(retryable).to.deep.equal(["mintA"]);
  });

  it("any other error (RPC failure, balance read, wallet rejection) is fatal, not retried, and the FIRST such error is surfaced", () => {
    const rpc = new Error("429 Too Many Requests");
    const later = new Error("second error");
    const { retryable, fatal } = partitionSwapOutcomes(legs, [fulfilled(), rejected(rpc), rejected(later)]);
    expect(fatal).to.equal(rpc);
    expect(retryable).to.deep.equal([]);
  });

  it("all legs landed -> nothing to retry, nothing fatal", () => {
    const { retryable, fatal } = partitionSwapOutcomes(legs, [fulfilled(), fulfilled(), fulfilled()]);
    expect(retryable).to.deep.equal([]);
    expect(fatal).to.equal(null);
  });

  it("JupiterSwapNotLandedError carries the kind + signature the resume flow reconciles, and is a real Error (instanceof survives)", () => {
    const e = new JupiterSwapNotLandedError("failed", "sig123", "boom");
    expect(e).to.be.instanceOf(Error);
    expect(e).to.be.instanceOf(JupiterSwapNotLandedError);
    expect(e.kind).to.equal("failed");
    expect(e.signature).to.equal("sig123");
    expect(e.message).to.equal("boom");
    expect(e.name).to.equal("JupiterSwapNotLandedError");
  });
});
