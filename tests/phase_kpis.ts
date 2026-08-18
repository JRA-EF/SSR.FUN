// Offline, pure-logic regression coverage for /internal/kpis (the protocol
// usage-stats dashboard). Covers two things: (1) activityLog.ts's extended
// summarizeActivityEvent now also returning structured amountRaw/amountKind
// fields for KPI aggregation, alongside its pre-existing summary text; (2)
// lib/reserve-activity/kpis.ts's pure bucketing/formatting helpers -- the
// half of that module that doesn't touch Postgres, so it's directly
// unit-tested the same way cursorLogic.ts already is. The SQL-touching half
// (computeProtocolKpis, streamActivityLogCsv) is intentionally NOT covered
// here, same rationale as db.ts/indexer.ts not being unit-tested: no live
// DB in this offline suite.
import { expect } from "chai";
import { summarizeActivityEvent } from "../packages/sdk/src/activityLog";
import { monthKey, dayKey, sumBigStrings, bucketReservesCreatedByMonth, computeMonthlyAvgAssets, csvField, csvRow } from "../lib/reserve-activity/kpis";

describe("activityLog.ts summarizeActivityEvent -- structured amounts (KPI dashboard support)", () => {
  it("reserveTokensMinted: amountRaw is the GROSS amount (net + fee), tagged mintVolume", () => {
    const decoded = summarizeActivityEvent("reserveTokensMinted", { depositor: "Depositor1", reserveTokensOut: "990000", mintFeeReserveTokens: "10000" });
    expect(decoded?.amountRaw).to.equal("1000000");
    expect(decoded?.amountKind).to.equal("mintVolume");
  });

  it("reserveTokensRedeemed: amountRaw is the GROSS amount (burned + fee), tagged redeemVolume", () => {
    const decoded = summarizeActivityEvent("reserveTokensRedeemed", { redeemer: "Redeemer1", reserveTokensBurned: "495000", redemptionFeeReserveTokens: "5000" });
    expect(decoded?.amountRaw).to.equal("500000");
    expect(decoded?.amountKind).to.equal("redeemVolume");
  });

  it("reserveSeeded: amountRaw is the GROSS seed amount, tagged mintVolume (seeding is a form of minting)", () => {
    const decoded = summarizeActivityEvent("reserveSeeded", { initialReserveTokens: "98000000", mintFeeReserveTokens: "2000000" });
    expect(decoded?.amountRaw).to.equal("100000000");
    expect(decoded?.amountKind).to.equal("mintVolume");
  });

  it("protocolMintFeeTransferred: amountRaw = amount, tagged protocolFee", () => {
    const decoded = summarizeActivityEvent("protocolMintFeeTransferred", { amount: "500", destination: "Treasury1" });
    expect(decoded?.amountRaw).to.equal("500");
    expect(decoded?.amountKind).to.equal("protocolFee");
  });

  it("protocolFeeCollected: amountRaw = amount, tagged protocolFee", () => {
    const decoded = summarizeActivityEvent("protocolFeeCollected", { amount: "200", collectedBy: "Someone1" });
    expect(decoded?.amountRaw).to.equal("200");
    expect(decoded?.amountKind).to.equal("protocolFee");
  });

  it("tvlFeeSettled: TWO independent amounts -- protocol side as amountRaw/protocolFee, manager side as amountRaw2/managerFee", () => {
    const decoded = summarizeActivityEvent("tvlFeeSettled", {
      settledBy: "Keeper1",
      periodStartTs: 1000,
      periodEndTs: 2000,
      protocolFeeShares: "300",
      managerFeeShares: "700",
    });
    expect(decoded?.amountRaw).to.equal("300");
    expect(decoded?.amountKind).to.equal("protocolFee");
    expect(decoded?.amountRaw2).to.equal("700");
    expect(decoded?.amountKind2).to.equal("managerFee");
  });

  it("feesAccrued (legacy): manager side as amountRaw/managerFee, protocol side as amountRaw2/protocolFee", () => {
    const decoded = summarizeActivityEvent("feesAccrued", { managerFeeSharesAccrued: "400", protocolFeeSharesAccrued: "100" });
    expect(decoded?.amountRaw).to.equal("400");
    expect(decoded?.amountKind).to.equal("managerFee");
    expect(decoded?.amountRaw2).to.equal("100");
    expect(decoded?.amountKind2).to.equal("protocolFee");
  });

  it("managerFeeShareAccrued: amountRaw sums the amounts array across every recipient, tagged managerFee", () => {
    const decoded = summarizeActivityEvent("managerFeeShareAccrued", { recipients: ["A", "B", "C"], amounts: ["100", "200", "300"], source: { mint: {} } });
    expect(decoded?.amountRaw).to.equal("600");
    expect(decoded?.amountKind).to.equal("managerFee");
  });

  it("managerFeeShareCollected: tagged managerFeeClaimed, distinct from managerFee accrual (no double count)", () => {
    const decoded = summarizeActivityEvent("managerFeeShareCollected", { recipient: "R1", amount: "600", collectedBy: "R1" });
    expect(decoded?.amountRaw).to.equal("600");
    expect(decoded?.amountKind).to.equal("managerFeeClaimed");
    expect(decoded?.amountKind).to.not.equal("managerFee");
  });

  it("a large u64 amount (beyond Number.MAX_SAFE_INTEGER) round-trips exactly as a string, never losing precision", () => {
    const huge = "18446744073709551615"; // u64::MAX
    const decoded = summarizeActivityEvent("protocolMintFeeTransferred", { amount: huge, destination: "T1" });
    expect(decoded?.amountRaw).to.equal(huge);
  });

  it("events with no primary token amount (delegate/pause/lifecycle) carry no amountRaw/amountKind", () => {
    const decoded = summarizeActivityEvent("windDownInitiated", { initiatedBy: "M1" });
    expect(decoded?.amountRaw).to.equal(undefined);
    expect(decoded?.amountKind).to.equal(undefined);
  });
});

describe("lib/reserve-activity/kpis.ts -- pure bucketing/formatting helpers", () => {
  it("monthKey/dayKey are stable, UTC, sortable strings", () => {
    const ts = Math.floor(Date.UTC(2026, 7, 17, 12, 0, 0) / 1000); // 2026-08-17
    expect(monthKey(ts)).to.equal("2026-08");
    expect(dayKey(ts)).to.equal("2026-08-17");
  });

  it("sumBigStrings sums BigInt-safe, including nulls/undefined as 0, past Number.MAX_SAFE_INTEGER", () => {
    expect(sumBigStrings(["1", "2", "3"])).to.equal("6");
    expect(sumBigStrings(["9007199254740993", "1"])).to.equal("9007199254740994"); // MAX_SAFE_INTEGER + 2, would lose precision as a JS number
    expect(sumBigStrings(["5", null, undefined, ""])).to.equal("5");
    expect(sumBigStrings([])).to.equal("0");
  });

  it("bucketReservesCreatedByMonth groups by month, sorts chronologically, and computes a correct running cumulative", () => {
    const augTs = Math.floor(Date.UTC(2026, 7, 1) / 1000);
    const julTs = Math.floor(Date.UTC(2026, 6, 15) / 1000);
    const result = bucketReservesCreatedByMonth([augTs, julTs, augTs, augTs]);
    expect(result).to.deep.equal([
      { month: "2026-07", count: 1, cumulative: 1 },
      { month: "2026-08", count: 3, cumulative: 4 },
    ]);
  });

  it("bucketReservesCreatedByMonth returns an empty array for no events", () => {
    expect(bucketReservesCreatedByMonth([])).to.deep.equal([]);
  });

  it("computeMonthlyAvgAssets averages CURRENT live assetCount across Reserves grouped by creation month, skipping any Reserve missing live state", () => {
    const augTs = Math.floor(Date.UTC(2026, 7, 1) / 1000);
    const result = computeMonthlyAvgAssets(
      [
        { reserve: "R1", ts: augTs },
        { reserve: "R2", ts: augTs },
        { reserve: "R3", ts: augTs }, // no live entry below -- must be skipped, not treated as 0
      ],
      new Map([["R1", 2], ["R2", 4]]),
    );
    expect(result).to.deep.equal([{ month: "2026-08", avgAssetCount: 3, reserveCount: 2 }]);
  });

  it("computeMonthlyAvgAssets returns an empty array when no creation event has matching live state", () => {
    expect(computeMonthlyAvgAssets([{ reserve: "R1", ts: 1000 }], new Map())).to.deep.equal([]);
  });

  it("csvField quotes and escapes only when the value contains a comma, quote, or newline", () => {
    expect(csvField("plain")).to.equal("plain");
    expect(csvField("has,comma")).to.equal('"has,comma"');
    expect(csvField('has"quote')).to.equal('"has""quote"');
    expect(csvField("has\nnewline")).to.equal('"has\nnewline"');
    expect(csvField(null)).to.equal("");
    expect(csvField(undefined)).to.equal("");
    expect(csvField(42)).to.equal("42");
  });

  it("csvRow joins fields with commas and terminates with CRLF (RFC 4180)", () => {
    expect(csvRow(["a", "b,c", 3])).to.equal('a,"b,c",3\r\n');
  });
});
