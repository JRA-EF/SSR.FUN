// Offline, pure-logic regression coverage for the SSR Ledger
// (lib/ledger/*.ts). Covers everything from the task's required test list
// that is genuinely testable without a live database or RPC connection:
// event-ID determinism, ordering within a transaction, decimal conversion,
// raw/normalized amounts, USD valuation source tracking, missing
// timestamps/actors, failed transactions, DevNet/Mainnet separation,
// Jupiter snapshot diffing, CSV escaping/stable headers, exact-date/
// date-range filtering, and privacy-field exclusion.
//
// NOT covered here (documented, not silently skipped): duplicate webhook
// delivery and replay/backfill at the DATABASE level (the unique
// constraint doing the real work lives in Postgres, not in this offline
// suite -- event-ID determinism below is what MAKES that constraint
// effective, and is tested), daily-totals/fee-reconciliation SQL (lives in
// lib/ledger/query.ts, touches Postgres directly), and partial/resumed
// deployments (already covered by tests/phase_reserve_deploy_resumability.ts
// -- this pass reuses that existing logic, not reinventing it).
import { expect } from "chai";
import { buildEventId } from "../lib/ledger/eventId";
import { normalizeRawAmount, computeUsdValuation, sumRawAmounts, classifyActorRole } from "../lib/ledger/amounts";
import { sanitizeProductEventMetadata, containsForbiddenContent, RETENTION_POLICY } from "../lib/ledger/privacy";
import { csvField, csvRow, ledgerEventCsvHeader, LEDGER_EVENT_CSV_COLUMNS, isValidUtcDateString, normalizeDateRange, filterRowsByDateRange } from "../lib/ledger/csv";
import { buildLedgerEventRecord, ledgerEventRecordToCsvRow } from "../lib/ledger/decodeEvent";
import { diffCatalogue, shapeSnapshotRows } from "../lib/ledger/jupiterCatalogue";

describe("lib/ledger/eventId.ts -- deterministic event IDs", () => {
  it("the exact same onchain input always produces the exact same ID (idempotent ingestion/replay/backfill)", () => {
    const input = { kind: "onchain" as const, cluster: "devnet", signature: "Sig1", eventType: "reserveCreated", instructionIndex: 0, eventIndex: 0 };
    expect(buildEventId(input)).to.equal(buildEventId({ ...input }));
  });

  it("differs by eventIndex -- ordering/uniqueness within the SAME transaction", () => {
    const base = { kind: "onchain" as const, cluster: "devnet", signature: "Sig1", eventType: "reserveAssetAdded", instructionIndex: 0 };
    const first = buildEventId({ ...base, eventIndex: 0 });
    const second = buildEventId({ ...base, eventIndex: 1 });
    expect(first).to.not.equal(second);
  });

  it("differs by instructionIndex and innerInstructionIndex independently", () => {
    const base = { kind: "onchain" as const, cluster: "devnet", signature: "Sig1", eventType: "targetsUpdated" };
    const ids = new Set([
      buildEventId({ ...base, instructionIndex: 0 }),
      buildEventId({ ...base, instructionIndex: 1 }),
      buildEventId({ ...base, instructionIndex: 0, innerInstructionIndex: 0 }),
      buildEventId({ ...base, instructionIndex: 0, innerInstructionIndex: 1 }),
    ]);
    expect(ids.size).to.equal(4);
  });

  it("DevNet and Mainnet never collide, even for an identical signature (impossible in reality, but the ID scheme itself must never rely on signature uniqueness ACROSS clusters)", () => {
    const devnetId = buildEventId({ kind: "onchain", cluster: "devnet", signature: "SameSig", eventType: "reserveCreated" });
    const mainnetId = buildEventId({ kind: "onchain", cluster: "mainnet-beta", signature: "SameSig", eventType: "reserveCreated" });
    expect(devnetId).to.not.equal(mainnetId);
    expect(devnetId.startsWith("onchain:devnet:")).to.equal(true);
    expect(mainnetId.startsWith("onchain:mainnet-beta:")).to.equal(true);
  });

  it("lifecycle/operational events are deterministic from caller-supplied dedupe parts", () => {
    const id1 = buildEventId({ kind: "lifecycle", cluster: "devnet", eventType: "launchStepStarted", dedupeParts: ["Reserve1", "seed-assets", 1] });
    const id2 = buildEventId({ kind: "lifecycle", cluster: "devnet", eventType: "launchStepStarted", dedupeParts: ["Reserve1", "seed-assets", 1] });
    const id3 = buildEventId({ kind: "lifecycle", cluster: "devnet", eventType: "launchStepStarted", dedupeParts: ["Reserve1", "seed-assets", 2] });
    expect(id1).to.equal(id2);
    expect(id1).to.not.equal(id3);
  });
});

describe("lib/ledger/amounts.ts -- decimal conversion, raw/normalized amounts, USD valuation", () => {
  it("normalizeRawAmount divides by 10^decimals correctly", () => {
    expect(normalizeRawAmount("1000000", 6)).to.equal(1);
    expect(normalizeRawAmount("500000", 6)).to.equal(0.5);
    expect(normalizeRawAmount("1", 0)).to.equal(1);
  });

  it("normalizeRawAmount returns null (never 0 or NaN) for missing raw/decimals -- an honest gap, not a fabricated zero", () => {
    expect(normalizeRawAmount(null, 6)).to.equal(null);
    expect(normalizeRawAmount("100", null)).to.equal(null);
    expect(normalizeRawAmount("not-a-number", 6)).to.equal(null);
  });

  it("computeUsdValuation multiplies normalized amount by unit price and records the source", () => {
    const v = computeUsdValuation(2, 1.5, "devnet-fixed-test-price");
    expect(v.usdValueAtEvent).to.equal(3);
    expect(v.usdPriceAtEvent).to.equal(1.5);
    expect(v.usdPriceSource).to.equal("devnet-fixed-test-price");
  });

  it("computeUsdValuation NEVER fabricates a value when no price source exists -- every field comes back null/'unavailable'", () => {
    const v = computeUsdValuation(2, null, "unavailable");
    expect(v.usdValueAtEvent).to.equal(null);
    expect(v.usdPriceAtEvent).to.equal(null);
    expect(v.usdPriceSource).to.equal("unavailable");
  });

  it("sumRawAmounts is BigInt-safe past Number.MAX_SAFE_INTEGER", () => {
    expect(sumRawAmounts(["9007199254740993", "1"])).to.equal("9007199254740994");
    expect(sumRawAmounts(["1", null, undefined, ""])).to.equal("1");
    expect(sumRawAmounts([])).to.equal("0");
  });

  it("classifyActorRole prefers keeper > protocol > manager > creator > delegate > holder, falls back to unknown for no wallet", () => {
    expect(classifyActorRole(null, {})).to.equal("unknown");
    expect(classifyActorRole("W1", { isKeeperTriggered: true, reserveManager: "W1" })).to.equal("keeper");
    expect(classifyActorRole("W1", { protocolTreasury: "W1", reserveManager: "W2" })).to.equal("protocol");
    expect(classifyActorRole("W1", { reserveManager: "W1" })).to.equal("manager");
    expect(classifyActorRole("W1", { reserveCreator: "W1" })).to.equal("creator");
    expect(classifyActorRole("W1", { knownDelegates: ["W1"] })).to.equal("delegate");
    expect(classifyActorRole("W1", {})).to.equal("holder");
  });
});

describe("lib/ledger/decodeEvent.ts -- transaction-level enrichment", () => {
  const baseTx = {
    cluster: "devnet" as const,
    programId: "Prog1111111111111111111111111111111111111",
    signature: "Sig1",
    slot: 1000,
    blockTimeUnix: 1735689600, // 2025-01-01T00:00:00Z
    transactionFailed: false,
    ingestionSource: "backfill" as const,
  };

  it("builds a complete record for a real event type, with cluster/date/instruction index all populated", () => {
    const record = buildLedgerEventRecord({ name: "reserveCreated", data: { manager: { toBase58: () => "Manager1" } } }, { ...baseTx, instructionIndex: 0, eventIndex: 0 });
    expect(record).to.not.equal(null);
    expect(record?.cluster).to.equal("devnet");
    expect(record?.event_date_utc).to.equal("2025-01-01");
    expect(record?.status).to.equal("confirmed");
    expect(record?.actor_wallet).to.equal("Manager1");
  });

  it("returns null for an unrecognized event name -- never fabricates a record for something it can't decode", () => {
    const record = buildLedgerEventRecord({ name: "totallyUnknownEvent", data: {} }, baseTx);
    expect(record).to.equal(null);
  });

  it("a failed transaction is recorded with status='failed', not silently dropped", () => {
    const record = buildLedgerEventRecord({ name: "reserveCreated", data: { manager: { toBase58: () => "Manager1" } } }, { ...baseTx, transactionFailed: true, errorMessage: "InsufficientFunds" });
    expect(record?.status).to.equal("failed");
    expect(record?.error_message).to.equal("InsufficientFunds");
  });

  it("missing blockTime falls back to current time rather than throwing or producing an invalid date", () => {
    const record = buildLedgerEventRecord({ name: "reserveCreated", data: { manager: { toBase58: () => "Manager1" } } }, { ...baseTx, blockTimeUnix: null });
    expect(record?.event_date_utc).to.match(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("missing actor (reserveAssetInitialized genuinely decodes to actor: null by design) produces a null actor_wallet, not a crash or a fabricated wallet", () => {
    const record = buildLedgerEventRecord({ name: "reserveAssetInitialized", data: { assetMint: { toBase58: () => "Mint1" }, targetWeightBps: 5000 } }, baseTx);
    expect(record?.actor_wallet).to.equal(null);
    expect(record?.actor_role).to.equal("unknown");
  });

  it("amount_raw/amount_kind/amount_normalized are populated together for an amount-carrying event, using the supplied decimals", () => {
    const record = buildLedgerEventRecord(
      { name: "reserveTokensMinted", data: { depositor: { toBase58: () => "D1" }, reserveTokensOut: "990000", mintFeeReserveTokens: "10000" } },
      baseTx,
      { decimals: 6 },
    );
    expect(record?.amount_raw).to.equal("1000000");
    expect(record?.amount_kind).to.equal("mintVolume");
    expect(record?.amount_normalized).to.equal(1);
    expect(record?.amount_decimals).to.equal(6);
  });

  it("ledgerEventRecordToCsvRow maps every declared CSV column to a defined key (no silently-missing column)", () => {
    const record = buildLedgerEventRecord({ name: "reserveCreated", data: { manager: { toBase58: () => "Manager1" } } }, baseTx);
    const row = ledgerEventRecordToCsvRow(record!);
    for (const col of LEDGER_EVENT_CSV_COLUMNS) {
      expect(Object.prototype.hasOwnProperty.call(row, col), `missing CSV column: ${col}`).to.equal(true);
    }
  });
});

describe("lib/ledger/csv.ts -- CSV escaping, stable headers, date filtering", () => {
  it("csvField quotes/escapes only when needed", () => {
    expect(csvField("plain")).to.equal("plain");
    expect(csvField("a,b")).to.equal('"a,b"');
    expect(csvField('a"b')).to.equal('"a""b"');
    expect(csvField("a\nb")).to.equal('"a\nb"');
    expect(csvField(null)).to.equal("");
    expect(csvField(undefined)).to.equal("");
  });

  it("csvRow / ledgerEventCsvHeader produce CRLF-terminated rows matching the declared column order exactly", () => {
    const header = ledgerEventCsvHeader();
    expect(header.endsWith("\r\n")).to.equal(true);
    expect(header.trim().split(",")[0]).to.equal("event_id");
    expect(header.trim().split(",").length).to.equal(LEDGER_EVENT_CSV_COLUMNS.length);
  });

  it("csvRow output is stable/positional -- the same column list always produces fields in the same order", () => {
    expect(csvRow(["a", 1, null])).to.equal("a,1,\r\n");
  });

  it("isValidUtcDateString accepts YYYY-MM-DD only", () => {
    expect(isValidUtcDateString("2026-08-18")).to.equal(true);
    expect(isValidUtcDateString("2026-13-01")).to.equal(false);
    expect(isValidUtcDateString("08/18/2026")).to.equal(false);
    expect(isValidUtcDateString("not-a-date")).to.equal(false);
  });

  it("normalizeDateRange swaps reversed dates and rejects invalid ones", () => {
    const swapped = normalizeDateRange("2026-08-20", "2026-08-01");
    expect(swapped).to.deep.equal({ fromDateUtc: "2026-08-01", toDateUtc: "2026-08-20" });
    const invalid = normalizeDateRange("nope", "2026-08-01");
    expect("error" in invalid).to.equal(true);
  });

  it("filterRowsByDateRange includes both endpoints (inclusive range) and excludes outside dates", () => {
    const rows = [{ event_date_utc: "2026-08-01" }, { event_date_utc: "2026-08-10" }, { event_date_utc: "2026-08-20" }, { event_date_utc: "2026-08-21" }];
    const filtered = filterRowsByDateRange(rows, { fromDateUtc: "2026-08-01", toDateUtc: "2026-08-20" });
    expect(filtered.map((r) => r.event_date_utc)).to.deep.equal(["2026-08-01", "2026-08-10", "2026-08-20"]);
  });
});

describe("lib/ledger/jupiterCatalogue.ts -- weekly snapshot diffing", () => {
  it("diffCatalogue reports newly-added and newly-removed mints correctly", () => {
    const diff = diffCatalogue(["A", "B", "C"], ["B", "C", "D"]);
    expect(diff.added).to.deep.equal(["D"]);
    expect(diff.removed).to.deep.equal(["A"]);
  });

  it("diffCatalogue reports no changes when the mint set is identical", () => {
    const diff = diffCatalogue(["A", "B"], ["B", "A"]);
    expect(diff.added).to.deep.equal([]);
    expect(diff.removed).to.deep.equal([]);
  });

  it("shapeSnapshotRows maps Jupiter's raw token shape to the snapshot row shape, defaulting isVerified to true (every entry from the verified-tag query is verified by construction)", () => {
    const rows = shapeSnapshotRows({ fetchedAt: "now", mintCount: 1, tokens: [{ id: "Mint1", symbol: "TEST", organicScore: 42 }] });
    expect(rows).to.deep.equal([{ mint: "Mint1", symbol: "TEST", organicScore: 42, verified: true }]);
  });
});

describe("lib/ledger/privacy.ts -- privacy-field exclusion", () => {
  it("sanitizeProductEventMetadata keeps only allowlisted keys", () => {
    const { value, droppedKeys } = sanitizeProductEventMetadata({ page: "/discover", step: "connect", ipAddress: "1.2.3.4" });
    expect(value).to.deep.equal({ page: "/discover", step: "connect" });
    expect(droppedKeys).to.include("ipAddress");
  });

  it("sanitizeProductEventMetadata drops a forbidden KEY regardless of its value", () => {
    const { value, droppedKeys } = sanitizeProductEventMetadata({ apiKey: "sk-123", sessionSecret: "x", page: "/discover" });
    expect(value).to.deep.equal({ page: "/discover" });
    expect(droppedKeys).to.include("apiKey");
    expect(droppedKeys).to.include("sessionSecret");
  });

  it("sanitizeProductEventMetadata drops non-primitive values (an object/array could smuggle a forbidden field past the top-level key check)", () => {
    const { value, droppedKeys } = sanitizeProductEventMetadata({ page: { nested: "secretKey" } as unknown as string });
    expect(value).to.deep.equal({});
    expect(droppedKeys).to.deep.equal(["page"]);
  });

  it("containsForbiddenContent flags obvious secret-shaped text, never a plain wallet address or ordinary sentence", () => {
    expect(containsForbiddenContent("my api_key is abc123")).to.equal(true);
    expect(containsForbiddenContent("-----BEGIN PRIVATE KEY-----")).to.equal(true);
    expect(containsForbiddenContent("Reserve created by EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq")).to.equal(false);
    expect(containsForbiddenContent("Manager fee accrued")).to.equal(false);
    expect(containsForbiddenContent(null)).to.equal(false);
  });

  it("the documented retention policy never stores IP/device identifiers -- a checkable invariant, not just prose", () => {
    expect(RETENTION_POLICY.ipAndDeviceIdentifiersStored).to.equal(false);
    expect(RETENTION_POLICY.productEventsRawRetentionDays).to.be.a("number").greaterThan(0);
  });
});
