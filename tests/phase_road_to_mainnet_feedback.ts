// Offline, pure-logic regression coverage for the Road to Mainnet checklist
// feedback pass (5 items: AR-01, DL-01, PU-01, WD-01, FE-01). See
// docs/project/DECISION_LOG.md's entry for this pass for full root-cause
// detail on each. Matches this repo's existing testing split: pure decision
// logic covered here offline; real signed live verification (where a
// wallet/signer is needed, e.g. the new pause/unpause/collect-fees
// instructions) is covered separately via a scripts/verify_*.ts script.
import { expect } from "chai";
import type { DTR, OnChainReserveMeta } from "../src/merge/lib/types";
import { isManagerOrDelegate } from "../src/merge/lib/permissions";
import { evaluateReserveEligibility, type ReserveEligibilityInput } from "../packages/sdk/src";
import { selectFeaturedReserves } from "../src/merge/lib/reserveCardProps";
import { summarizeActivityEvent } from "../packages/sdk/src/activityLog";

function baseOnChain(overrides: Partial<OnChainReserveMeta> = {}): OnChainReserveMeta {
  return {
    programId: "Prog11111111111111111111111111111111111",
    reserveId: "1",
    reserve: "Reserve1111111111111111111111111111111111",
    reserveTokenMint: "Mint111111111111111111111111111111111111",
    mintAuthority: "MintAuth111111111111111111111111111111111",
    vaultAuthority: "VaultAuth11111111111111111111111111111111",
    manager: "Manager111111111111111111111111111111111111",
    assets: [],
    status: "active",
    totalTargetWeightBps: 10_000,
    reserveTokenSupplyRaw: "1000000",
    vaultBalancesRaw: {},
    ...overrides,
  };
}

function baseDtr(overrides: Partial<DTR> = {}): DTR {
  return {
    id: "devnet-1",
    name: "Test Reserve",
    ticker: "TST",
    description: "",
    category: "DevNet",
    tags: [],
    logoSeed: "devnet-1",
    dtrAddress: "Reserve1111111111111111111111111111111111",
    managerAddress: "Manager111111111111111111111111111111111111",
    delegates: [],
    feeConfig: { mintFeePct: 0, tvlFeePct: 0, managerBuyTaxPct: 0, managerSellTaxPct: 0, creatorFeeDestination: "Manager111111111111111111111111111111111111", feeRecipients: [] },
    tokenPrice: 1,
    nav: 1,
    aum: 100,
    liquidityUsdc: 100,
    change24h: 0,
    change7d: 0,
    holders: 1,
    composition: [],
    unallocatedPct: 0,
    isUserCreated: false,
    priceHistory: [],
    trades: [],
    ...overrides,
  };
}

describe("DL-01a -- isManagerOrDelegate recognizes a REAL on-chain delegate grant", () => {
  const DELEGATE_WALLET = "Delegate1111111111111111111111111111111111";

  it("recognizes the root manager", () => {
    const dtr = baseDtr();
    expect(isManagerOrDelegate(dtr, dtr.managerAddress)).to.equal(true);
  });

  it("recognizes a wallet in the LOCAL simulated delegates array (unchanged, pre-existing behavior)", () => {
    const dtr = baseDtr({ delegates: [{ address: "Sim11111111111111111111111111111111111111", permissions: { manageDelegates: false, rebalance: false, feeAdmin: false, pause: false, metadata: false }, addedAt: 0 }] });
    expect(isManagerOrDelegate(dtr, "Sim11111111111111111111111111111111111111")).to.equal(true);
  });

  it("was the confirmed bug: a real on-chain delegate grant (onChain.delegatesOnChain) was never checked at all", () => {
    const dtr = baseDtr({
      onChain: baseOnChain({
        delegatesOnChain: [{ wallet: DELEGATE_WALLET, delegateAccount: "DelAcct11111111111111111111111111111111111", permissions: 2, restricted: true, addedAt: 0 }],
      }),
    });
    // This is the exact reported symptom: a wallet holding a real, granted
    // on-chain delegate PDA must see this Reserve on its own manager
    // dashboard -- before this fix, this returned false.
    expect(isManagerOrDelegate(dtr, DELEGATE_WALLET)).to.equal(true);
  });

  it("does not grant access to an unrelated wallet, on-chain or otherwise", () => {
    const dtr = baseDtr({ onChain: baseOnChain({ delegatesOnChain: [{ wallet: DELEGATE_WALLET, delegateAccount: "DelAcct11111111111111111111111111111111111", permissions: 2, restricted: true, addedAt: 0 }] }) });
    expect(isManagerOrDelegate(dtr, "Stranger111111111111111111111111111111111")).to.equal(false);
  });

  it("returns false for a null address regardless of delegate state", () => {
    const dtr = baseDtr({ onChain: baseOnChain({ delegatesOnChain: [{ wallet: DELEGATE_WALLET, delegateAccount: "DelAcct11111111111111111111111111111111111", permissions: 2, restricted: true, addedAt: 0 }] }) });
    expect(isManagerOrDelegate(dtr, null)).to.equal(false);
  });

  it("handles a Reserve with no onChain data at all (purely local/simulated) without throwing", () => {
    const dtr = baseDtr({ onChain: undefined });
    expect(isManagerOrDelegate(dtr, "Anyone111111111111111111111111111111111111")).to.equal(false);
  });
});

describe("WD-01 -- evaluateReserveEligibility no longer quarantines a Reserve in windDown", () => {
  function eligibleInput(overrides: Partial<ReserveEligibilityInput> = {}): ReserveEligibilityInput {
    return {
      reserve: "Reserve1111111111111111111111111111111111",
      assetCount: 1,
      resolvedAssetCount: 1,
      assetMints: ["Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k"], // devUSDC -- a genuinely supported mint
      status: "active",
      reserveTokenSupplyRaw: "1000000",
      ...overrides,
    };
  }

  it("was the confirmed bug: a fully-resolved, supported, seeded Reserve in windDown used to be excluded (quarantined) entirely", () => {
    const result = evaluateReserveEligibility(eligibleInput({ status: "windDown" }));
    expect(result.eligible).to.equal(true);
    expect(result.reason).to.equal(null);
  });

  it("still excludes windDown if the Reserve is otherwise genuinely broken (e.g. under-resolved) -- windDown is not a blanket bypass", () => {
    const result = evaluateReserveEligibility(eligibleInput({ status: "windDown", assetCount: 2, resolvedAssetCount: 1 }));
    expect(result.eligible).to.equal(false);
  });

  it("still excludes every other non-normal-use lifecycle status (created, assetsInitializing, closed)", () => {
    for (const status of ["created", "assetsInitializing", "closed"]) {
      const result = evaluateReserveEligibility(eligibleInput({ status }));
      expect(result.eligible, `status=${status}`).to.equal(false);
    }
  });

  it("active and paused remain eligible, unchanged", () => {
    expect(evaluateReserveEligibility(eligibleInput({ status: "active" })).eligible).to.equal(true);
    expect(evaluateReserveEligibility(eligibleInput({ status: "paused" })).eligible).to.equal(true);
  });
});

describe("WD-01 -- selectFeaturedReserves excludes windDown from curation (but not from Discover)", () => {
  function windDownCandidateDtr(status: string): DTR {
    return baseDtr({
      aum: 1000,
      onChain: baseOnChain({
        status,
        assetsResolvedFully: true,
        assets: [{ mint: "Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k", symbol: "devUSDC", decimals: 6, weightBps: 10_000, reserveAsset: "RA1", vault: "V1", orderIndex: 0 }],
      }),
      name: "Real Reserve",
    });
  }

  it("excludes a windDown Reserve from Featured even though it's fully eligible/visible on Discover", () => {
    const featured = selectFeaturedReserves([windDownCandidateDtr("windDown")], 3);
    expect(featured).to.have.length(0);
  });

  it("still features an otherwise-identical active Reserve", () => {
    const featured = selectFeaturedReserves([windDownCandidateDtr("active")], 3);
    expect(featured).to.have.length(1);
  });
});

describe("DL-01b -- summarizeActivityEvent decodes governance events into a display-ready summary", () => {
  const PK = "8dY3FgC87hLecekmsKdjXXeuPMTtEJ19x1gL8vWNRfZa";
  const MINT = "Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k";
  const fakePubkey = (s: string) => ({ toBase58: () => s });

  it("decodes delegateAdded with the acting delegate as actor", () => {
    const result = summarizeActivityEvent("delegateAdded", { delegate: fakePubkey(PK), permissions: 2, restricted: true });
    expect(result).to.not.equal(null);
    expect(result!.actor).to.equal(PK);
    expect(result!.summary).to.include(PK).and.to.include("restricted");
  });

  it("decodes reservePaused/reserveUnpaused with the pausing/unpausing wallet as actor", () => {
    expect(summarizeActivityEvent("reservePaused", { pausedBy: fakePubkey(PK) })!.actor).to.equal(PK);
    expect(summarizeActivityEvent("reserveUnpaused", { unpausedBy: fakePubkey(PK) })!.actor).to.equal(PK);
  });

  it("decodes feesCollected with real amounts, no actor (permissionless -- see collect_fees.rs)", () => {
    const result = summarizeActivityEvent("feesCollected", {
      managerFeeSharesMinted: { toString: () => "800" } as unknown,
      protocolFeeSharesMinted: { toString: () => "200" } as unknown,
    });
    expect(result!.actor).to.equal(null);
    expect(result!.summary).to.include("800").and.to.include("200");
  });

  it("decodes targetsUpdated listing every asset mint and its new weight", () => {
    const result = summarizeActivityEvent("targetsUpdated", {
      updatedBy: fakePubkey(PK),
      assetMints: [fakePubkey(MINT)],
      newTargetWeightsBps: [5000],
    });
    expect(result!.summary).to.include("5000bps");
  });

  it("returns null only for a genuinely unknown/unhandled event name", () => {
    expect(summarizeActivityEvent("someUnknownFutureEvent", {})).to.equal(null);
  });

  it("decodes reserveTokensMinted/reserveTokensRedeemed (2026-08-14 pass: mint/redeem are now surfaced in the Activity Log)", () => {
    const minted = summarizeActivityEvent("reserveTokensMinted", {
      depositor: fakePubkey(PK),
      reserveTokensOut: { toString: () => "1000000" } as unknown,
      mintFeeReserveTokens: { toString: () => "5000" } as unknown,
    });
    expect(minted).to.not.equal(null);
    expect(minted!.actor).to.equal(PK);
    expect(minted!.summary).to.include(PK).and.to.include("1000000").and.to.include("5000");

    const redeemed = summarizeActivityEvent("reserveTokensRedeemed", {
      redeemer: fakePubkey(PK),
      reserveTokensBurned: { toString: () => "2000000" } as unknown,
      redemptionFeeReserveTokens: { toString: () => "0" } as unknown,
    });
    expect(redeemed).to.not.equal(null);
    expect(redeemed!.actor).to.equal(PK);
    expect(redeemed!.summary).to.include(PK).and.to.include("2000000");
  });

  it("decodes protocolMintFeeTransferred and tvlFeeSettled (instant Protocol treasury transfers)", () => {
    const mintFee = summarizeActivityEvent("protocolMintFeeTransferred", {
      amount: { toString: () => "1234" } as unknown,
      destination: fakePubkey(PK),
    });
    expect(mintFee).to.not.equal(null);
    expect(mintFee!.summary).to.include("1234");

    const tvlSettled = summarizeActivityEvent("tvlFeeSettled", {
      settledBy: fakePubkey(PK),
      periodStartTs: 1_700_000_000,
      periodEndTs: 1_700_604_800,
      protocolFeeShares: { toString: () => "500" } as unknown,
      managerFeeShares: { toString: () => "500" } as unknown,
    });
    expect(tvlSettled).to.not.equal(null);
    expect(tvlSettled!.actor).to.equal(PK);
    expect(tvlSettled!.summary).to.include("500").and.to.include("Protocol-share").and.to.include("Manager-share");
  });

  it("decodes managerFeeShareCollected with the recipient's own wallet as the collector (claimant-only)", () => {
    const result = summarizeActivityEvent("managerFeeShareCollected", {
      recipient: fakePubkey(PK),
      collectedBy: fakePubkey(PK),
      amount: { toString: () => "42" } as unknown,
    });
    expect(result).to.not.equal(null);
    expect(result!.actor).to.equal(PK);
    expect(result!.summary).to.include(PK).and.to.include("42");
  });
});
