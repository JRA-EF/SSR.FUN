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
import { summarizeActivityEvent, valueActivityEventUsd } from "../packages/sdk/src/activityLog";
import { monthKey, dayKey, sumBigStrings, bucketReservesCreatedByMonth, computeMonthlyAvgAssets, csvField, csvRow } from "../lib/reserve-activity/kpis";
import { ACTIVITY_CLUSTERS, MAINNET_PROGRAM_ID, clustersForFilter, parseClusterFilter, computeReserveValuations } from "../lib/reserve-activity/clusters";

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

// DEC-0175: cluster-awareness for the activity pipeline. Only the pure
// filter/target-selection logic is offline-testable (buildClusterTargets
// constructs live RPC Connections; discovery/SQL are covered by the same
// no-live-IO rationale as the rest of this file's exclusions).
describe("lib/reserve-activity/clusters.ts -- pure cluster-filter logic (DEC-0175)", () => {
  it("parseClusterFilter accepts the three valid values verbatim", () => {
    expect(parseClusterFilter("all")).to.equal("all");
    expect(parseClusterFilter("mainnet-beta")).to.equal("mainnet-beta");
    expect(parseClusterFilter("devnet")).to.equal("devnet");
  });

  it("parseClusterFilter treats an absent/empty value as 'mainnet-beta' -- the KPIs surface is Mainnet by default (DEC-0176, Creator directive)", () => {
    expect(parseClusterFilter(undefined)).to.equal("mainnet-beta");
    expect(parseClusterFilter(null)).to.equal("mainnet-beta");
    expect(parseClusterFilter("")).to.equal("mainnet-beta");
  });

  it("parseClusterFilter rejects anything unrecognized with null (caller 400s), never guessing", () => {
    expect(parseClusterFilter("mainnet")).to.equal(null);
    expect(parseClusterFilter("MAINNET-BETA")).to.equal(null);
    expect(parseClusterFilter(["devnet"])).to.equal(null);
    expect(parseClusterFilter(42)).to.equal(null);
    expect(parseClusterFilter("testnet")).to.equal(null);
  });

  it("clustersForFilter expands 'all' to every cluster with Mainnet FIRST (sweep-order guarantee: the live protocol is never starved by a failing DevNet)", () => {
    expect(clustersForFilter("all")).to.deep.equal(["mainnet-beta", "devnet"]);
    expect(clustersForFilter("all")).to.deep.equal(ACTIVITY_CLUSTERS);
  });

  it("clustersForFilter maps a single cluster to exactly that cluster", () => {
    expect(clustersForFilter("mainnet-beta")).to.deep.equal(["mainnet-beta"]);
    expect(clustersForFilter("devnet")).to.deep.equal(["devnet"]);
  });

  it("clustersForFilter('all') returns a fresh array, never the shared ACTIVITY_CLUSTERS instance (a caller mutating its copy must not corrupt the module constant)", () => {
    const copy = clustersForFilter("all");
    expect(copy).to.not.equal(ACTIVITY_CLUSTERS);
    copy.pop();
    expect(ACTIVITY_CLUSTERS).to.deep.equal(["mainnet-beta", "devnet"]);
  });

  it("MAINNET_PROGRAM_ID pins the deployed Mainnet program (DEC-0115), byte-identical to api/mainnet/landing-stats.ts's literal", () => {
    expect(MAINNET_PROGRAM_ID).to.equal("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
  });
});

// DEC-0176: at-indexing USD valuation of activity events, per-event
// identity (eventIndex), and the fee-settlement event coverage added ahead
// of the DEC-0173 Mainnet upgrade.
describe("activityLog.ts valueActivityEventUsd + new event coverage (DEC-0176)", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SSR = "SSRmintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const valuation = {
    pricing: {
      [USDC]: { decimals: 6, priceUsd: 1 },
      [SSR]: { decimals: 9, priceUsd: 0.5 },
    },
    navUsdPerRtRawUnit: 0.000001, // $1.00 per whole 6-decimal Reserve Token
  };

  it("values a mint from the event's OWN asset legs -- exact for the USDC leg, live price for the other", () => {
    const usd = valueActivityEventUsd(
      "reserveTokensMinted",
      { assetMints: [USDC, SSR], assetAmountsIn: ["5000000", "2000000000"] }, // 5 USDC + 2 SSR@$0.50
      valuation,
    );
    expect(usd.amountUsd).to.be.closeTo(6.0, 1e-9);
    expect(usd.amountUsd2).to.equal(undefined);
  });

  it("values a redeem from assetAmountsOut and a seed from assetAmounts", () => {
    expect(valueActivityEventUsd("reserveTokensRedeemed", { assetMints: [USDC], assetAmountsOut: ["2500000"] }, valuation).amountUsd).to.be.closeTo(2.5, 1e-9);
    expect(valueActivityEventUsd("reserveSeeded", { assetMints: [USDC], assetAmounts: ["10000000"] }, valuation).amountUsd).to.be.closeTo(10, 1e-9);
  });

  it("values share-denominated fee amounts via the Reserve Token NAV", () => {
    expect(valueActivityEventUsd("protocolMintFeeTransferred", { amount: "50000" }, valuation).amountUsd).to.be.closeTo(0.05, 1e-9);
    const tvl = valueActivityEventUsd("tvlFeeSettled", { protocolFeeShares: "100000", managerFeeShares: "300000" }, valuation);
    expect(tvl.amountUsd).to.be.closeTo(0.1, 1e-9);
    expect(tvl.amountUsd2).to.be.closeTo(0.3, 1e-9);
  });

  it("NEVER fabricates: a null NAV leaves share amounts unvalued (undefined), and unknown events value to nothing", () => {
    const noNav = { pricing: valuation.pricing, navUsdPerRtRawUnit: null };
    expect(valueActivityEventUsd("protocolMintFeeTransferred", { amount: "50000" }, noNav).amountUsd).to.equal(undefined);
    expect(valueActivityEventUsd("delegateAdded", { delegate: "X" }, valuation)).to.deep.equal({});
  });

  it("feeUsdcDistributed is exact USDC (6 decimals), no NAV involved", () => {
    const usd = valueActivityEventUsd("feeUsdcDistributed", { protocolUsdc: "1250000", managerUsdc: "750000" }, { pricing: {}, navUsdPerRtRawUnit: null });
    expect(usd.amountUsd).to.be.closeTo(1.25, 1e-9);
    expect(usd.amountUsd2).to.be.closeTo(0.75, 1e-9);
  });

  it("feeVaultCredited (the DEC-0173 fee assessment event) is tagged protocolFee/managerFee like tvlFeeSettled, so post-upgrade fees keep aggregating", () => {
    const decoded = summarizeActivityEvent("feeVaultCredited", { protocolShares: "40000", managerShares: "60000", source: { mintFee: {} } });
    expect(decoded?.amountRaw).to.equal("40000");
    expect(decoded?.amountKind).to.equal("protocolFee");
    expect(decoded?.amountRaw2).to.equal("60000");
    expect(decoded?.amountKind2).to.equal("managerFee");
  });

  it("feeSharesRedeemed and feeUsdcDistributed carry NO amountKind -- settlement mechanics of already-counted fee revenue must never double-count", () => {
    const redeemed = summarizeActivityEvent("feeSharesRedeemed", { sharesRedeemed: "100", protocolSharesRedeemed: "40", managerSharesRedeemed: "60", redeemedBy: "K" });
    expect(redeemed?.amountKind).to.equal(undefined);
    const distributed = summarizeActivityEvent("feeUsdcDistributed", { protocolUsdc: "1", managerUsdc: "2", managerRecipients: [], distributedBy: "K" });
    expect(distributed?.amountKind).to.equal(undefined);
  });

  it("the remaining settlement/protocol events decode to real summaries instead of being silently dropped", () => {
    expect(summarizeActivityEvent("settlementSwapApproved", { amount: "5", assetMint: "M", keeper: "K" })).to.not.equal(null);
    expect(summarizeActivityEvent("feeSettlementKeeperSet", { authority: "A", oldKeeper: "O", newKeeper: "N" })).to.not.equal(null);
    expect(summarizeActivityEvent("protocolPausedSet", { authority: "A", paused: true })?.summary).to.contain("pause");
  });
});

describe("clusters.ts computeReserveValuations (DEC-0176)", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const OTHER = "OtherMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const baseReserve = {
    reserveId: "0",
    reserve: "R1",
    manager: "M",
    reserveTokenMint: "RT",
    status: "active",
    assetCount: 2,
    resolvedAssetCount: 2,
    totalTargetWeightBps: 10000,
    mintFeeBps: 0, redemptionFeeBps: 0, annualTvlFeeBps: 0, managerFeeShareBps: 0, protocolFeeShareBps: 0,
    feeDestination: "F", pendingManagerFeeShares: "0", pendingProtocolFeeShares: "0", lastFeeAccrualTs: "0",
    effectiveMintFeeProtocolBps: 0, effectiveMintFeeManagerBps: 0, effectiveMintFeeTotalBps: 0,
    effectiveTvlFeeProtocolBps: 0, effectiveTvlFeeManagerBps: 0, effectiveTvlFeeTotalBps: 0,
    metadataUri: "", reserveTokenSupplyRaw: "10000000", delegateCount: 0,
    assets: [
      { assetMint: USDC, reserveAsset: "RA1", vault: "V1", decimals: 6, targetWeightBps: 5000, enabled: true, orderIndex: 0, vaultBalanceRaw: "5000000" },
      { assetMint: OTHER, reserveAsset: "RA2", vault: "V2", decimals: 9, targetWeightBps: 5000, enabled: true, orderIndex: 1, vaultBalanceRaw: "10000000000" },
    ],
  };

  it("computes NAV per raw Reserve Token unit from vault balances x live prices / raw supply", () => {
    // 5 USDC ($5) + 10 OTHER @ $0.50 ($5) = $10 TVL over 10.000000 RT -> $1/RT -> 1e-6 per raw unit
    const valuations = computeReserveValuations([baseReserve], new Map([[OTHER, { usdPrice: 0.5 }]]));
    expect(valuations.get("R1")?.navUsdPerRtRawUnit).to.be.closeTo(0.000001, 1e-12);
    expect(valuations.get("R1")?.pricing[USDC].priceUsd).to.equal(1);
  });

  it("returns a null NAV (never a guess) for zero supply, incomplete asset resolution, or an unpriced asset with a real balance", () => {
    const zeroSupply = { ...baseReserve, reserveTokenSupplyRaw: "0" };
    const underResolved = { ...baseReserve, resolvedAssetCount: 1 };
    const priced = new Map([[OTHER, { usdPrice: 0.5 }]]);
    expect(computeReserveValuations([zeroSupply], priced).get("R1")?.navUsdPerRtRawUnit).to.equal(null);
    expect(computeReserveValuations([underResolved], priced).get("R1")?.navUsdPerRtRawUnit).to.equal(null);
    expect(computeReserveValuations([baseReserve], new Map()).get("R1")?.navUsdPerRtRawUnit).to.equal(null);
  });
});
