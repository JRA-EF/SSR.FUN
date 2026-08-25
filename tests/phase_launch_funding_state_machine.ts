// Offline, pure-logic regression coverage for the first-principles Mainnet
// funding correction (DEC-0151): the explicit per-asset launch-funding state
// machine, the upfront launch-feasibility preflight, and the USDC-purchase
// invariant (launchFunding.ts; wiring in createReserveClient.ts /
// CreateDTR.tsx / DTRDetail.tsx).
//
// Root-cause background this file guards against regressing (2026-08-25,
// Reserve 11 EQ5HNT9hAnYFfXARRJeKrNahMLaag5tepXV1uoK6CqoM, a real 10-asset
// ~$20 Mainnet launch): the 4th swap (USDC -> USD1) failed FIVE consecutive
// times over 34 minutes with Jupiter error 6024 -- documented by Jupiter as
// InsufficientFunds, not slippage -- because the wallet held 0.490579 USDC
// against a ~$2 required input, and nothing anywhere checked "does this
// wallet hold enough USDC for the remaining plan," not before creating the
// Reserve PDA and not before each swap. Earlier abandoned attempts had
// already converted the wallet's USDC into OTHER constituent tokens.
// Separately: the "ETH" asset the Creator reported never existed in either
// launch -- the on-chain registrations are ZEC (A7bdiYdS5G..., 8 decimals,
// in both DELTA and Reserve 11) and HYPE (98sMhvDwXj..., 9 decimals) --
// identity is only ever established by MINT, never by displayed symbol.
import { expect } from "chai";
import {
  advanceAssetFunding,
  canEnterSeeding,
  countReadyToSeed,
  firstUnresolvedIndex,
  isLegalFundingTransition,
  assessLaunchFeasibility,
  DEFAULT_MIN_PRACTICAL_SWAP_USD,
  type PersistedAssetFunding,
  type LaunchAssetPlan,
} from "../src/merge/lib/launchFunding";
import { computeMintRequirements, computeNetMintOutput } from "../packages/sdk/src/calculations";
import { usdToReserveTokensRequested } from "../src/merge/lib/multiAssetBuyClient";

const mkStates = (statuses: PersistedAssetFunding["status"][]): PersistedAssetFunding[] =>
  statuses.map((status, i) => ({ mint: `Mint${i}`, status }));

describe("Launch funding state machine -- lifecycle and transitions (launchFunding.ts)", () => {
  it("every forward transition through the full lifecycle is legal, in order", () => {
    const order: PersistedAssetFunding["status"][] = ["not_started", "quoted", "awaiting_signature", "submitted", "confirmed", "balance_verified", "ready_to_seed"];
    for (let i = 0; i < order.length - 1; i++) {
      expect(isLegalFundingTransition(order[i], order[i + 1]), `${order[i]} -> ${order[i + 1]}`).to.equal(true);
    }
  });

  it("a backward transition to anything but not_started is refused -- a stale async event can never demote verified progress", () => {
    expect(isLegalFundingTransition("ready_to_seed", "submitted")).to.equal(false);
    expect(isLegalFundingTransition("balance_verified", "quoted")).to.equal(false);
    expect(isLegalFundingTransition("confirmed", "awaiting_signature")).to.equal(false);
  });

  it("an explicit retry reset (anything -> not_started) is always legal -- how a definitively failed/expired swap starts its next attempt cleanly", () => {
    expect(isLegalFundingTransition("submitted", "not_started")).to.equal(true);
    expect(isLegalFundingTransition("quoted", "not_started")).to.equal(true);
  });

  it("advanceAssetFunding refuses an illegal transition by returning the record unchanged -- duplicate/stale events cannot corrupt state", () => {
    let record = advanceAssetFunding({}, "MintA", "ready_to_seed", { verifiedBalanceRaw: "12345" });
    const before = record;
    record = advanceAssetFunding(record, "MintA", "submitted", { lastSignature: "staleSig" });
    expect(record).to.equal(before);
    expect(record["MintA"].status).to.equal("ready_to_seed");
    expect(record["MintA"].lastSignature).to.equal(undefined);
  });

  it("a retry reset clears the stale signature so the next attempt cannot confuse it for its own", () => {
    let record = advanceAssetFunding({}, "MintA", "submitted", { lastSignature: "sigThatFailed" });
    record = advanceAssetFunding(record, "MintA", "not_started");
    expect(record["MintA"].lastSignature).to.equal(undefined);
  });

  it("delayed confirmation shape: submitted -> confirmed (reconciled later against real signature status) is a normal forward transition", () => {
    let record = advanceAssetFunding({}, "MintA", "submitted", { lastSignature: "sigPending" });
    record = advanceAssetFunding(record, "MintA", "confirmed");
    expect(record["MintA"].status).to.equal("confirmed");
    expect(record["MintA"].lastSignature).to.equal("sigPending");
  });

  it("persists raw amounts as strings across mixed decimals without precision loss (5/6/8/9-dp scale raw values)", () => {
    let record = {};
    const bigRaw = "629941944160000000"; // beyond Number-safe integer range
    record = advanceAssetFunding(record, "Bonk5dp", "ready_to_seed", { verifiedBalanceRaw: bigRaw });
    expect((record as Record<string, PersistedAssetFunding>)["Bonk5dp"].verifiedBalanceRaw).to.equal(bigRaw);
    expect(BigInt(bigRaw)).to.equal(629941944160000000n);
  });
});

describe("Launch funding state machine -- the seeding gate (premature seeding prevention)", () => {
  it("a ten-asset launch may enter seeding only when EVERY asset is ready_to_seed", () => {
    const nineReady = mkStates([...Array(9).fill("ready_to_seed"), "submitted"]);
    expect(canEnterSeeding(nineReady)).to.equal(false);
    const allReady = mkStates(Array(10).fill("ready_to_seed"));
    expect(canEnterSeeding(allReady)).to.equal(true);
  });

  it("completion is never inferred from a wallet approval or submission -- awaiting_signature/submitted/confirmed all still block seeding", () => {
    for (const notDone of ["awaiting_signature", "submitted", "confirmed", "balance_verified"] as const) {
      expect(canEnterSeeding(mkStates(["ready_to_seed", notDone])), notDone).to.equal(false);
    }
  });

  it("an empty asset list is never seedable", () => {
    expect(canEnterSeeding([])).to.equal(false);
  });

  it("reproduces the real failed-fourth-swap shape: swaps 1-3 verified, 4th unresolved -- resume continues from index 3, never skips, never seeds", () => {
    const states = mkStates(["ready_to_seed", "ready_to_seed", "ready_to_seed", "not_started", "not_started", "not_started", "not_started", "not_started", "not_started", "not_started"]);
    expect(firstUnresolvedIndex(states)).to.equal(3);
    expect(countReadyToSeed(states)).to.equal(3);
    expect(canEnterSeeding(states)).to.equal(false);
  });

  it("duplicate-execution prevention: an already-ready asset is never the first unresolved one, so a resume can never re-swap it", () => {
    const states = mkStates(["ready_to_seed", "ready_to_seed", "quoted"]);
    expect(firstUnresolvedIndex(states)).to.equal(2);
  });
});

describe("Launch feasibility preflight (assessLaunchFeasibility) -- run BEFORE the Reserve PDA is created", () => {
  // Reserve 11's real composition shape: 10 assets at 10% each -- SSR,
  // USDC, SOL, PENGU, HYPE, ZEC, USD1, CARDS, MET, jlUSDC.
  const tenAssetPlan = (alreadyHeldUsd: Partial<Record<string, number>> = {}): LaunchAssetPlan[] => [
    { mint: "SSRmint", seedWeightFraction: 0.1, kind: "swap", alreadyHeldUsd: alreadyHeldUsd["SSRmint"] },
    { mint: "USDCmint", seedWeightFraction: 0.1, kind: "usdc" },
    { mint: "SOLmint", seedWeightFraction: 0.1, kind: "wrapped-sol" },
    { mint: "PENGUmint", seedWeightFraction: 0.1, kind: "swap", alreadyHeldUsd: alreadyHeldUsd["PENGUmint"] },
    { mint: "HYPEmint", seedWeightFraction: 0.1, kind: "swap", alreadyHeldUsd: alreadyHeldUsd["HYPEmint"] },
    { mint: "ZECmint", seedWeightFraction: 0.1, kind: "swap", alreadyHeldUsd: alreadyHeldUsd["ZECmint"] },
    { mint: "USD1mint", seedWeightFraction: 0.1, kind: "swap", alreadyHeldUsd: alreadyHeldUsd["USD1mint"] },
    { mint: "CARDSmint", seedWeightFraction: 0.1, kind: "swap" },
    { mint: "METmint", seedWeightFraction: 0.1, kind: "swap" },
    { mint: "jlUSDCmint", seedWeightFraction: 0.1, kind: "swap" },
  ];

  it("a $20 ten-asset launch IS viable on the allocation axis ($2/asset clears the practical per-swap floor) when the wallet genuinely holds the USDC", () => {
    const result = assessLaunchFeasibility({ assets: tenAssetPlan(), seedTotalUsd: 20, walletUsdcRaw: 25_000_000n });
    expect(result.feasible).to.equal(true);
    expect(result.perAsset.every((a) => a.ok)).to.equal(true);
  });

  it("reproduces the exact live disaster: $20 plan against a wallet holding 0.490579 USDC is rejected UPFRONT with the precise shortfall -- before any PDA, any signature, any 6024", () => {
    const result = assessLaunchFeasibility({ assets: tenAssetPlan(), seedTotalUsd: 20, walletUsdcRaw: 490_579n });
    expect(result.feasible).to.equal(false);
    // 9 USDC-consuming legs x $2 (the SOL leg consumes SOL, not USDC) plus
    // the 3% buffer = $18.54 required.
    expect(result.requiredUsdcUi).to.be.closeTo(18.54, 0.01);
    expect(result.missingUsdcUi).to.be.closeTo(18.05, 0.02);
    expect(result.reasons.join(" ")).to.include("USDC short");
  });

  it("a resume counts already-held confirmed balances toward the requirement -- only genuine remaining deficits need USDC", () => {
    // SSR/PENGU/HYPE/ZEC fully held from prior confirmed swaps: remaining
    // USDC need is the USDC leg ($2) + the 4 unfunded swap legs (USD1,
    // CARDS, MET, jlUSDC -- $2 each) = $10, x1.03 buffer = $10.30.
    const short = assessLaunchFeasibility({
      assets: tenAssetPlan({ SSRmint: 2, PENGUmint: 2, HYPEmint: 2, ZECmint: 2 }),
      seedTotalUsd: 20,
      walletUsdcRaw: 10_000_000n,
    });
    expect(short.requiredUsdcUi).to.be.closeTo(10.3, 0.01);
    expect(short.feasible).to.equal(false);
    const funded = assessLaunchFeasibility({
      assets: tenAssetPlan({ SSRmint: 2, PENGUmint: 2, HYPEmint: 2, ZECmint: 2 }),
      seedTotalUsd: 20,
      walletUsdcRaw: 10_500_000n,
    });
    expect(funded.feasible).to.equal(true);
  });

  it("dust allocations are rejected with a PRECISE recommended minimum, never an arbitrary blanket number: $3 across ten assets (30 cents each) recommends exactly $5 for 10% slices", () => {
    const result = assessLaunchFeasibility({ assets: tenAssetPlan(), seedTotalUsd: 3, walletUsdcRaw: 100_000_000n });
    expect(result.feasible).to.equal(false);
    expect(result.perAsset.filter((a) => !a.ok).length).to.equal(8); // every swap leg is dust; the USDC and SOL legs are not swaps
    // min practical $0.50 / smallest USDC-consuming fraction 0.1 = $5.00
    expect(result.minimumRecommendedSeedUsd).to.equal(DEFAULT_MIN_PRACTICAL_SWAP_USD / 0.1);
  });

  it("a small REMAINING deficit on resume is never rejected as dust -- only a DESIGNED allocation below the floor is (the funding loop's dust-skip owns the remaining-deficit case)", () => {
    const plan: LaunchAssetPlan[] = [{ mint: "SSRmint", seedWeightFraction: 1, kind: "swap", alreadyHeldUsd: 19.8 }];
    const result = assessLaunchFeasibility({ assets: plan, seedTotalUsd: 20, walletUsdcRaw: 1_000_000n });
    expect(result.perAsset[0].ok).to.equal(true); // $0.20 remaining on a $20 allocation is fine
    expect(result.feasible).to.equal(true);
  });

  it("a wrapped-SOL leg consumes SOL, never USDC -- it contributes nothing to the USDC requirement", () => {
    const plan: LaunchAssetPlan[] = [
      { mint: "SOLmint", seedWeightFraction: 0.5, kind: "wrapped-sol" },
      { mint: "SSRmint", seedWeightFraction: 0.5, kind: "swap" },
    ];
    const result = assessLaunchFeasibility({ assets: plan, seedTotalUsd: 20, walletUsdcRaw: 10_500_000n });
    expect(result.requiredUsdcUi).to.be.closeTo(10.3, 0.01); // only the SSR half, buffered
    expect(result.feasible).to.equal(true);
  });

  it("identity is by mint, never by symbol: two entries with lookalike roles but different mints are assessed independently (the 'ETH-that-was-actually-ZEC' doctrine)", () => {
    const plan: LaunchAssetPlan[] = [
      { mint: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", seedWeightFraction: 0.5, kind: "swap", alreadyHeldUsd: 10 },
      { mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", seedWeightFraction: 0.5, kind: "swap" },
    ];
    const result = assessLaunchFeasibility({ assets: plan, seedTotalUsd: 20, walletUsdcRaw: 20_000_000n });
    const zec = result.perAsset.find((a) => a.mint.startsWith("A7bd"))!;
    const weth = result.perAsset.find((a) => a.mint.startsWith("7vfC"))!;
    expect(zec.remainingUsdcUsd).to.equal(0);
    expect(weth.remainingUsdcUsd).to.equal(10);
  });
});

describe("USDC purchase of a 100% SSR Reserve -- correct Reserve Token output (the ALPHA invariant fix)", () => {
  // ALPHA's real live shape (2026-08-25): vault 21,132.446514 SSR (6dp),
  // supply 9.95 ALPHA (6dp), NAV ~$1.30, 1% mint fee.
  const SSR_VAULT_RAW = 21_132_446_514n;
  const ALPHA_SUPPLY_RAW = 9_950_000n;

  it("a $10 USDC purchase at NAV $1.30 requests the right gross Reserve Tokens, and the 1% mint fee nets down correctly", () => {
    const gross = usdToReserveTokensRequested(10, 1.3, 6);
    expect(gross).to.equal(7_692_307n); // floor(10/1.30 * 1e6)
    const { netOut } = computeNetMintOutput(gross, 100n); // 1% total mint fee
    expect(netOut).to.equal(gross - (gross * 100n + 9_999n) / 10_000n);
    expect(Number(netOut) / 1e6).to.be.closeTo(7.615, 0.001);
  });

  it("the single-leg deposit requirement is exactly proportional: requesting r tokens against supply s requires ceil(vault * r / s) SSR -- the same math the on-chain program enforces", () => {
    const requested = 7_692_307n;
    const reqs = computeMintRequirements(requested, ALPHA_SUPPLY_RAW, [{ mint: "SSRmint", vaultBalance: SSR_VAULT_RAW }]);
    expect(reqs).to.have.length(1);
    const expected = (SSR_VAULT_RAW * requested + ALPHA_SUPPLY_RAW - 1n) / ALPHA_SUPPLY_RAW;
    expect(reqs[0].requiredAmount).to.equal(expected);
  });

  it("usdToReserveTokensRequested refuses a missing/zero NAV rather than fabricating a quote", () => {
    expect(() => usdToReserveTokensRequested(10, 0, 6)).to.throw();
    expect(() => usdToReserveTokensRequested(0, 1.3, 6)).to.throw();
  });
});
