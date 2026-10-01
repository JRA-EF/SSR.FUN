// Offline, pure-logic coverage for DEC-0206: per-recipient USDC fee payouts
// on the Manage page's Fee Configuration panel. Covers the SDK's
// extractFeePayouts (decoded feeUsdcDistributed event -> per-wallet USDC
// list, persisted by lib/reserve-activity/indexer.ts as jsonb) and
// lib/reserve-activity/feePayouts.ts's aggregateFeePayouts (indexed rows ->
// per-wallet totals + pendingHeal). The DB/RPC halves (healMissingFeePayouts,
// readFeePayoutTotals, the route handler) are intentionally NOT covered
// here, same rationale as indexer.ts: no live DB in this offline suite.
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { extractFeePayouts, formatUsdcRaw, summarizeActivityEvent } from "../packages/sdk/src/activityLog";
import { aggregateFeePayouts } from "../lib/reserve-activity/feePayouts";

const A = "6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen";
const B = "EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq";

describe("DEC-0206 extractFeePayouts -- per-recipient USDC out of a feeUsdcDistributed event", () => {
  it("pairs managerRecipients with managerAmounts, PublicKeys and BN-like amounts stringified", () => {
    // Live Mainnet shape (reserve 25 'I', 2026-09-18 09:15:47 UTC, tx 2x6yYrNgeoYm...): $0.0502 + $0.050199.
    const payouts = extractFeePayouts("feeUsdcDistributed", {
      protocolUsdc: "100400",
      managerUsdc: "100399",
      managerRecipients: [new PublicKey(A), new PublicKey(B)],
      managerAmounts: [{ toString: () => "50200" }, { toString: () => "50199" }],
    });
    expect(payouts).to.deep.equal([
      { wallet: A, usdcRaw: "50200" },
      { wallet: B, usdcRaw: "50199" },
    ]);
  });

  it("is undefined for every other event kind, and an empty list for a no-op distribution", () => {
    expect(extractFeePayouts("feeVaultCredited", { protocolShares: "1", managerShares: "1" })).to.equal(undefined);
    expect(extractFeePayouts("reserveTokensMinted", { depositor: A })).to.equal(undefined);
    expect(extractFeePayouts("feeUsdcDistributed", { managerRecipients: [], managerAmounts: [] })).to.deep.equal([]);
  });

  it("never fabricates an amount for a recipient the event did not pay (mismatched array lengths -> overlapping prefix only)", () => {
    const payouts = extractFeePayouts("feeUsdcDistributed", { managerRecipients: [A, B], managerAmounts: ["7"] });
    expect(payouts).to.deep.equal([{ wallet: A, usdcRaw: "7" }]);
  });

  it("the activity summary now reads in dollars, not raw base units", () => {
    const decoded = summarizeActivityEvent("feeUsdcDistributed", { protocolUsdc: "100400", managerUsdc: "100399", managerRecipients: [A, B], distributedBy: "K" });
    expect(decoded?.summary).to.contain("$0.1004");
    expect(decoded?.summary).to.contain("$0.100399");
    expect(decoded?.summary).to.contain("2 Manager fee recipient(s)");
    expect(decoded?.amountKind).to.equal(undefined);
    expect(formatUsdcRaw("1250000")).to.equal("$1.25");
    expect(formatUsdcRaw("abc")).to.equal("abc raw");
  });
});

describe("DEC-0206 aggregateFeePayouts -- indexed rows -> per-wallet USDC totals", () => {
  it("sums exact raw USDC per wallet across payouts, tracks count + latest payout, sorts largest first", () => {
    const rows = [
      { signature: "sig3", event_index: 0, ts: 300, payouts: [{ wallet: A, usdcRaw: "100" }] },
      { signature: "sig1", event_index: 0, ts: "100", payouts: [{ wallet: A, usdcRaw: "50200" }, { wallet: B, usdcRaw: "50199" }] },
      { signature: "sig2", event_index: 0, ts: 200, payouts: [{ wallet: B, usdcRaw: "1" }] },
    ];
    const { byRecipient, pendingHeal } = aggregateFeePayouts(rows);
    expect(pendingHeal).to.equal(0);
    expect(byRecipient).to.deep.equal([
      { wallet: A, usdcRaw: "50300", payoutCount: 2, lastTs: 300, lastSignature: "sig3" },
      { wallet: B, usdcRaw: "50200", payoutCount: 2, lastTs: 200, lastSignature: "sig2" },
    ]);
  });

  it("counts rows without a stored breakdown as pendingHeal instead of guessing their split", () => {
    const rows = [
      { signature: "old1", event_index: 0, ts: 10, payouts: null },
      { signature: "new1", event_index: 0, ts: 20, payouts: [{ wallet: A, usdcRaw: "5" }] },
      { signature: "old2", event_index: 1, ts: 30, payouts: null },
    ];
    const { byRecipient, pendingHeal } = aggregateFeePayouts(rows);
    expect(pendingHeal).to.equal(2);
    expect(byRecipient).to.deep.equal([{ wallet: A, usdcRaw: "5", payoutCount: 1, lastTs: 20, lastSignature: "new1" }]);
  });

  it("stays BigInt-exact for totals beyond Number's safe range", () => {
    const big = "9007199254740993"; // 2^53 + 1
    const { byRecipient } = aggregateFeePayouts([
      { signature: "s1", event_index: 0, ts: 1, payouts: [{ wallet: A, usdcRaw: big }] },
      { signature: "s2", event_index: 0, ts: 2, payouts: [{ wallet: A, usdcRaw: "1" }] },
    ]);
    expect(byRecipient[0].usdcRaw).to.equal("9007199254740994");
  });

  it("an empty index yields no recipients and nothing pending", () => {
    expect(aggregateFeePayouts([])).to.deep.equal({ byRecipient: [], pendingHeal: 0 });
  });
});
