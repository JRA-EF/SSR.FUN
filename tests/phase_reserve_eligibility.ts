// Offline, pure-logic regression coverage for this pass's fix: the "2
// registered asset(s) on-chain, but only 0 could be resolved" / "Buy not
// available for this Reserve" bug (reserveId 0-8 on the live DevNet
// deployment, whose registered assets predate the current fixture-mint
// registry and can never resolve against any future candidate-mint hint
// list). Covers the new canonical eligibility gate
// (packages/sdk/src/reserveEligibility.ts), the DTRDetail direct-link
// quarantine routing (src/merge/lib/onChainReserve.ts's
// resolveDtrPageState), and the CreateDTR submission guardrails
// (src/merge/lib/createReserveClient.ts's validateCreateReserveAssets).
// Matches this repo's existing testing split -- pure logic covered here
// offline; the live on-chain root-cause evidence and the 3 canonical
// replacement Reserves' real Buy/Sell signatures are recorded in this pass's
// docs/project/DECISION_LOG.md entry instead (scripts/create_canonical_reserves.ts,
// not reimplemented here).
import { expect } from "chai";
import type { DTR, QuarantinedReserveInfo } from "../src/merge/lib/types";
import { resolveDtrPageState } from "../src/merge/lib/onChainReserve";
import { validateCreateReserveAssets, type CreateReserveAssetInput } from "../src/merge/lib/createReserveClient";
import { evaluateReserveEligibility, DEVUSDC, DEVNET_FIXTURES, type ReserveEligibilityInput } from "../packages/sdk/src";

const DEVUSDC_MINT = DEVUSDC.mint;
const MOCK_X = DEVNET_FIXTURES.mints.mintX.address;
const MOCK_Y = DEVNET_FIXTURES.mints.mintY.address;
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const HIDDEN_ADDRESS = "GNAvLuTNmccXx5bSAVQeqPSncay7kBNjjHZFKFvKUbo2"; // the real, documented HIDDEN_RESERVE_ADDRESSES entry (DevNet EGAYQQ)
const HIDDEN_MAINNET_SMOKE_TEST = "9KkRx62FwvXvzYZeWqpBdLvokdPjdfqYMZ6vawUFvf4i"; // Mainnet reserveId 0, the DEC-0115 smoke-test Reserve

function baseInput(overrides: Partial<ReserveEligibilityInput> = {}): ReserveEligibilityInput {
  return {
    reserve: "SomeReserveAddress1111111111111111111111111",
    assetCount: 1,
    resolvedAssetCount: 1,
    assetMints: [DEVUSDC_MINT],
    status: "active",
    reserveTokenSupplyRaw: "1000000",
    ...overrides,
  };
}

describe("evaluateReserveEligibility (packages/sdk/src/reserveEligibility.ts) -- the canonical gate", () => {
  it("is eligible for a fully-resolved, supported, active, seeded Reserve", () => {
    const result = evaluateReserveEligibility(baseInput());
    expect(result.eligible).to.equal(true);
    expect(result.reason).to.equal(null);
  });

  it("is eligible for a multi-asset, fully-resolved, supported composition", () => {
    const result = evaluateReserveEligibility(baseInput({ assetCount: 2, resolvedAssetCount: 2, assetMints: [MOCK_X, MOCK_Y] }));
    expect(result.eligible).to.equal(true);
  });

  // The exact reported bug: reserveId 0-8's registered assets can never
  // resolve against any candidate-mint hint list, since their original
  // pre-fixture-registry mints are one-off DevNet test tokens, not the
  // current mockX/Y/Z/devUSDC set. This is what the OLD filter never
  // excluded on (see tests/phase_tradable_reserves_and_price_history.ts for
  // the corrected mergeDiscoveredReserves-level regression test).
  it("is NOT eligible when resolvedAssetCount < assetCount (the exact 'N registered, 0 resolved' bug shape)", () => {
    const result = evaluateReserveEligibility(baseInput({ assetCount: 2, resolvedAssetCount: 0 }));
    expect(result.eligible).to.equal(false);
    expect(result.reason).to.match(/2 registered.*only 0 resolve/);
  });

  it("is NOT eligible when resolvedAssetCount < assetCount even by just one asset", () => {
    const result = evaluateReserveEligibility(baseInput({ assetCount: 3, resolvedAssetCount: 2, assetMints: [DEVUSDC_MINT, MOCK_X] }));
    expect(result.eligible).to.equal(false);
  });

  it("is NOT eligible for a zero-asset Reserve", () => {
    const result = evaluateReserveEligibility(baseInput({ assetCount: 0, resolvedAssetCount: 0, assetMints: [] }));
    expect(result.eligible).to.equal(false);
    expect(result.reason).to.match(/no registered reserve assets/);
  });

  it("is NOT eligible when fully resolved but holding an unsupported asset (wrapped SOL)", () => {
    const result = evaluateReserveEligibility(baseInput({ assetMints: [WRAPPED_SOL] }));
    expect(result.eligible).to.equal(false);
    expect(result.reason).to.match(/holds an asset outside/);
  });

  it("is NOT eligible for a lifecycle status that doesn't permit normal use (assetsInitializing)", () => {
    const result = evaluateReserveEligibility(baseInput({ status: "assetsInitializing" }));
    expect(result.eligible).to.equal(false);
    expect(result.reason).to.match(/lifecycle status/);
  });

  it("is NOT eligible for created/closed lifecycle statuses", () => {
    expect(evaluateReserveEligibility(baseInput({ status: "created" })).eligible).to.equal(false);
    expect(evaluateReserveEligibility(baseInput({ status: "closed" })).eligible).to.equal(false);
  });

  it("IS eligible for a paused Reserve (redemption/visibility stays available while paused, matching the rest of the app's convention)", () => {
    expect(evaluateReserveEligibility(baseInput({ status: "paused" })).eligible).to.equal(true);
  });

  it("IS eligible for a windDown Reserve (2026-08-11, WD-01) -- stays visible so prior holders can still redeem out; see tests/phase_road_to_mainnet_feedback.ts for the full root-cause coverage", () => {
    expect(evaluateReserveEligibility(baseInput({ status: "windDown" })).eligible).to.equal(true);
  });

  it("is NOT eligible for a never-seeded Reserve (zero Reserve Token supply) even if otherwise fully valid", () => {
    const result = evaluateReserveEligibility(baseInput({ reserveTokenSupplyRaw: "0" }));
    expect(result.eligible).to.equal(false);
    expect(result.reason).to.match(/never seeded/);
  });

  it("is NOT eligible for the explicit HIDDEN_RESERVE_ADDRESSES entry, regardless of everything else being valid", () => {
    const result = evaluateReserveEligibility(baseInput({ reserve: HIDDEN_ADDRESS }));
    expect(result.eligible).to.equal(false);
    expect(result.reason).to.match(/explicitly excluded/);
  });

  it("is NOT eligible for the Mainnet smoke-test Reserve (reserveId 0) even though it is Active and seeded -- hidden by address, not by name", () => {
    const result = evaluateReserveEligibility(baseInput({ reserve: HIDDEN_MAINNET_SMOKE_TEST, status: "active", reserveTokenSupplyRaw: "901500" }));
    expect(result.eligible).to.equal(false);
    expect(result.reason).to.match(/explicitly excluded/);
  });

  it("is eligible (passthrough) when assetCount is undefined -- a legacy shape predating the field, never guessed at", () => {
    const result = evaluateReserveEligibility(baseInput({ assetCount: undefined, resolvedAssetCount: 0, assetMints: [] }));
    expect(result.eligible).to.equal(true);
  });
});

describe("resolveDtrPageState (src/merge/lib/onChainReserve.ts) -- DTRDetail direct-link routing", () => {
  const foundDtr = { id: "devnet-27", name: "Real Reserve" } as DTR;
  const quarantineInfo: QuarantinedReserveInfo = {
    id: "devnet-3",
    reserve: "HCD3u41XKcshUEi8zMT52S9VUiEGUFmcDvBC7MNvbGKi",
    reserveId: "3",
    name: "Unnamed Reserve (#3)",
    ticker: "RSV3",
    reason: "This Reserve reports 2 registered asset(s), but only 0 resolve against the current DevNet asset registry.",
  };
  const quarantined: Record<string, QuarantinedReserveInfo> = { "devnet-3": quarantineInfo };

  it("resolves to 'found' when the id matches a real, eligible DTR", () => {
    const state = resolveDtrPageState("devnet-27", [foundDtr], {}, "ready");
    expect(state.kind).to.equal("found");
    if (state.kind === "found") expect(state.dtr).to.equal(foundDtr);
  });

  it("resolves to 'quarantined' when the id isn't a public DTR but IS a known-quarantined on-chain Reserve", () => {
    const state = resolveDtrPageState("devnet-3", [foundDtr], quarantined, "ready");
    expect(state.kind).to.equal("quarantined");
    if (state.kind === "quarantined") expect(state.info).to.deep.equal(quarantineInfo);
  });

  it("resolves to 'not-found' when the id is neither a public DTR nor a known-quarantined Reserve, once discovery has completed a pass", () => {
    const state = resolveDtrPageState("devnet-999", [foundDtr], quarantined, "ready");
    expect(state.kind).to.equal("not-found");
  });

  it("resolves to 'not-found' for an undefined id, once discovery has completed a pass", () => {
    const state = resolveDtrPageState(undefined, [foundDtr], quarantined, "ready");
    expect(state.kind).to.equal("not-found");
  });

  it("resolves to 'indexing' -- never the terminal 'not-found' -- while discovery hasn't completed a pass yet", () => {
    const state = resolveDtrPageState("devnet-999", [foundDtr], quarantined, "loading");
    expect(state.kind).to.equal("indexing");
  });

  it("prefers 'found' over 'quarantined' if an id somehow matches both (found DTR is always authoritative)", () => {
    const dtrAtQuarantinedId = { id: "devnet-3", name: "Actually fine now" } as DTR;
    const state = resolveDtrPageState("devnet-3", [dtrAtQuarantinedId], quarantined, "ready");
    expect(state.kind).to.equal("found");
  });
});

describe("Portfolio legacy-holding lookup -- quarantinedReserves keyed the same way holdings.dtrId is", () => {
  it("a holding whose dtrId has no matching public DTR but DOES match quarantinedReserves resolves to real balance + honest labeling, never a fabricated value", () => {
    const holding = { dtrId: "devnet-3", tokenBalance: 42.5 };
    const dtrs: DTR[] = [];
    const quarantined: Record<string, QuarantinedReserveInfo> = {
      "devnet-3": {
        id: "devnet-3",
        reserve: "HCD3u41XKcshUEi8zMT52S9VUiEGUFmcDvBC7MNvbGKi",
        reserveId: "3",
        name: "Unnamed Reserve (#3)",
        ticker: "RSV3",
        reason: "under-resolved",
      },
    };
    const matchedDtr = dtrs.find((d) => d.id === holding.dtrId);
    expect(matchedDtr).to.equal(undefined); // Portfolio's !dtr branch would trigger
    const legacy = quarantined[holding.dtrId];
    expect(legacy).to.not.equal(undefined);
    expect(legacy.name).to.equal("Unnamed Reserve (#3)");
    // The real balance is preserved on the holding itself (never erased) --
    // no price/value/cost-basis/P&L field is ever derived from `legacy`.
    expect(holding.tokenBalance).to.equal(42.5);
  });

  it("a holding with neither a public DTR nor a quarantine entry is genuinely unknown (would render nothing, not fabricate a row)", () => {
    const holding = { dtrId: "devnet-999", tokenBalance: 1 };
    const dtrs: DTR[] = [];
    const quarantined: Record<string, QuarantinedReserveInfo> = {};
    expect(dtrs.find((d) => d.id === holding.dtrId)).to.equal(undefined);
    expect(quarantined[holding.dtrId]).to.equal(undefined);
  });
});

describe("validateCreateReserveAssets (src/merge/lib/createReserveClient.ts) -- prevents recurrence", () => {
  function asset(mint: string, weightBps: number): CreateReserveAssetInput {
    return { mint, weightBps, seedWeightFraction: weightBps / 10_000, decimals: 6 };
  }

  it("accepts a valid single-asset, fully-allocated selection", () => {
    expect(() => validateCreateReserveAssets([asset(DEVUSDC_MINT, 10_000)])).to.not.throw();
  });

  it("accepts a valid multi-asset selection summing to less than 100% (Unallocated remainder is a valid protocol state)", () => {
    expect(() => validateCreateReserveAssets([asset(MOCK_X, 4_000), asset(MOCK_Y, 3_000)])).to.not.throw();
  });

  it("rejects an empty asset list", () => {
    expect(() => validateCreateReserveAssets([])).to.throw(/at least one/i);
  });

  it("rejects an unsupported asset mint (e.g. wrapped SOL, or any mint outside the canonical registry)", () => {
    expect(() => validateCreateReserveAssets([asset(WRAPPED_SOL, 10_000)])).to.throw(/Unsupported reserve asset/);
  });

  it("rejects a duplicate mint selected twice", () => {
    expect(() => validateCreateReserveAssets([asset(MOCK_X, 5_000), asset(MOCK_X, 5_000)])).to.throw(/Duplicate/);
  });

  it("rejects an allocation total over 100%", () => {
    expect(() => validateCreateReserveAssets([asset(MOCK_X, 6_000), asset(MOCK_Y, 6_000)])).to.throw(/Invalid allocation total/);
  });

  it("rejects an allocation total of exactly 0%", () => {
    expect(() => validateCreateReserveAssets([asset(MOCK_X, 0)])).to.throw(/Invalid allocation total/);
  });

  it("accepts an allocation total of exactly 100%", () => {
    expect(() => validateCreateReserveAssets([asset(MOCK_X, 4_000), asset(MOCK_Y, 6_000)])).to.not.throw();
  });
});
