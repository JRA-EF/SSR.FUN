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

describe("DEC-0238 mintFeePaidUsdc -- USDC paid at mint time counts as payouts to the treasury and each Manager recipient", () => {
  const T = "TreasuryWa11et111111111111111111111111111111";
  const mintFeeEvent = {
    reserve: new PublicKey(A),
    payer: new PublicKey(B),
    isSeed: false,
    reserveTokensOut: "1000000",
    usdcFee: { toString: () => "250000" },
    protocolUsdc: { toString: () => "100000" },
    managerUsdc: { toString: () => "150000" },
    protocolDestination: { toBase58: () => T },
    managerRecipients: [new PublicKey(A), new PublicKey(B)],
    managerAmounts: [{ toString: () => "100000" }, { toString: () => "50000" }],
    feeQuoteSigner: new PublicKey(A),
    ts: 1790000000,
  };

  it("extracts the protocol leg first, then each Manager leg, exact raw USDC", () => {
    expect(extractFeePayouts("mintFeePaidUsdc", mintFeeEvent)).to.deep.equal([
      { wallet: T, usdcRaw: "100000" },
      { wallet: A, usdcRaw: "100000" },
      { wallet: B, usdcRaw: "50000" },
    ]);
  });

  it("skips zero-amount legs (no USDC moved for them)", () => {
    const payouts = extractFeePayouts("mintFeePaidUsdc", { ...mintFeeEvent, protocolUsdc: "0", managerAmounts: ["0", "7"] });
    expect(payouts).to.deep.equal([{ wallet: B, usdcRaw: "7" }]);
  });

  it("feeUsdcDistributed keeps its DEC-0206 shape (Manager legs only, protocol leg not added)", () => {
    const payouts = extractFeePayouts("feeUsdcDistributed", { protocolUsdc: "5", protocolDestination: T, managerRecipients: [A], managerAmounts: ["5"] });
    expect(payouts).to.deep.equal([{ wallet: A, usdcRaw: "5" }]);
  });

  it("folds together with keeper payouts into one per-wallet USDC total (the Manage page's USDC received)", () => {
    const rows = [
      { signature: "keeper1", event_index: 0, ts: 100, payouts: [{ wallet: A, usdcRaw: "50200" }] },
      { signature: "mint1", event_index: 0, ts: 200, payouts: extractFeePayouts("mintFeePaidUsdc", mintFeeEvent)! },
    ];
    const { byRecipient, pendingHeal } = aggregateFeePayouts(rows);
    expect(pendingHeal).to.equal(0);
    expect(byRecipient).to.deep.equal([
      { wallet: A, usdcRaw: "150200", payoutCount: 2, lastTs: 200, lastSignature: "mint1" },
      { wallet: T, usdcRaw: "100000", payoutCount: 1, lastTs: 200, lastSignature: "mint1" },
      { wallet: B, usdcRaw: "50000", payoutCount: 1, lastTs: 200, lastSignature: "mint1" },
    ]);
  });
});
