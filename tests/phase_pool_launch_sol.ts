// DEC-0283 (2026-11-03): a pool launch from a wallet holding less SOL than the cost cap was
// refused with "raise your cap to 0.25 SOL" even though the cap was already 0.30 SOL.
import { expect } from "chai";
import { measuringRefundLamports, poolLaunchSolMessage, CREATOR_SOL_RESERVE_LAMPORTS } from "../lib/mainnet/createLiquidity";
import { POOL_PAYER_REFUND_MARGIN_LAMPORTS } from "../lib/mainnet/poolPayer";

const SOL = 1_000_000_000n;

describe("Pool launch SOL sizing (DEC-0283)", () => {
  it("uses the full cap when the wallet can spare it (unchanged behaviour)", () => {
    expect(measuringRefundLamports(300_000_000n, 2n * SOL)).to.equal(300_000_000n - POOL_PAYER_REFUND_MARGIN_LAMPORTS);
  });
  it("never refunds more than the wallet can spare", () => {
    const bal = 250_000_000n;
    expect(measuringRefundLamports(300_000_000n, bal)).to.equal(bal - CREATOR_SOL_RESERVE_LAMPORTS - POOL_PAYER_REFUND_MARGIN_LAMPORTS);
  });
  it("is zero, never negative, for an almost empty wallet", () => {
    expect(measuringRefundLamports(300_000_000n, 1_000_000n)).to.equal(0n);
  });
  it("blames the wallet balance, not the cap, for the live case (0.079 SOL, cap 0.30)", () => {
    const m = poolLaunchSolMessage(300_000_000n, 78_939_764n);
    expect(m).to.include("your wallet holds 0.079 SOL");
    expect(m).to.include("Add at least");
    expect(m).to.not.include("cost limit");
  });
  it("blames the cap only when the cap is below 0.25 SOL and the wallet has enough", () => {
    expect(poolLaunchSolMessage(100_000_000n, 2n * SOL)).to.include("0.100 SOL cost limit");
    expect(poolLaunchSolMessage(300_000_000n, 2n * SOL)).to.not.include("Raise the maximum");
  });
});
