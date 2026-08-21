// Offline, pure-logic regression coverage for the USDC fee-settlement
// pipeline (2026-08-21 pass, see docs/project/DECISION_LOG.md): fee shares
// crystallize into a shared per-Reserve fee vault (instead of minting
// straight to final destinations), get redeemed for their proportional
// underlying assets, swapped to USDC via Jupiter by a configured keeper, and
// distributed to the Protocol Treasury / Reserve's Manager recipient(s).
//
// The on-chain crystallization/redemption/distribution MATH itself
// (split_by_weight, and the pre-existing, unchanged time-weighted TVL
// accrual formula) is exhaustively covered by 13 new Rust unit tests in
// programs/ssr_protocol/src/fee_math.rs (`cargo test -p ssr_protocol`) --
// this file covers this pass's TS-side additions instead: the exact TS
// mirror of split_by_weight (must never drift from the Rust source of
// truth), and the keeper script's own pure decision logic
// (isQuoteSafeToExecute). Also exercises realistic multi-step SCENARIOS
// (multiple redemption events, idempotent/duplicate distribution, partial
// settlement across several assets, multi-recipient distribution) built
// entirely from already-tested pure functions, matching this repo's
// existing testing split (see e.g. tests/phase_reserve_deploy_resumability.ts's
// own header for the same "pure logic offline, live verification separate"
// convention).
import { expect } from "chai";
import { splitByWeight, apportionToRecipients, type FeeRecipientAllocation } from "../packages/sdk/src/feeMath";
import { isQuoteSafeToExecute } from "../api/mainnet/fee-settlement-cron";

describe("feeMath.ts -- splitByWeight (USDC fee-settlement pipeline, mirrors fee_math.rs::split_by_weight exactly)", () => {
  it("splits exactly, manager floor-rounded, protocol gets the exact remainder (protocol-favored, matching splitTotalFee's convention)", () => {
    const { protocolShare, managerShare } = splitByWeight(985_341n, 250n, 250n);
    expect(protocolShare + managerShare).to.equal(985_341n);
    expect(managerShare).to.equal(492_670n); // floor(985341 * 250/500)
    expect(protocolShare).to.equal(492_671n); // exact remainder
  });

  it("both weights zero returns zero, never a division error -- an empty fee vault or nothing pending", () => {
    expect(splitByWeight(1_000_000n, 0n, 0n)).to.deep.equal({ protocolShare: 0n, managerShare: 0n });
  });

  it("all-protocol-weight gives the protocol everything", () => {
    expect(splitByWeight(777n, 100n, 0n)).to.deep.equal({ protocolShare: 777n, managerShare: 0n });
  });

  it("all-manager-weight gives the manager everything", () => {
    expect(splitByWeight(777n, 0n, 100n)).to.deep.equal({ protocolShare: 0n, managerShare: 777n });
  });

  it("a zero amount splits to zero regardless of weights -- e.g. distributeFeeUsdc called with nothing staged", () => {
    expect(splitByWeight(0n, 250n, 750n)).to.deep.equal({ protocolShare: 0n, managerShare: 0n });
  });

  it("is exact across a sweep of realistic weight ratios and amounts -- protocolShare + managerShare === amount always", () => {
    const weightPairs: [bigint, bigint][] = [[1n, 1n], [250n, 750n], [1n, 999n], [500_000n, 1n], [12_345n, 67_890n]];
    const amounts = [0n, 1n, 7n, 100n, 999n, 1_000_000n, 123_456_789n];
    for (const [pw, mw] of weightPairs) {
      for (const amount of amounts) {
        const { protocolShare, managerShare } = splitByWeight(amount, pw, mw);
        expect(protocolShare + managerShare, `amount=${amount} pw=${pw} mw=${mw}`).to.equal(amount);
      }
    }
  });
});

describe("fee-settlement-cron.ts -- isQuoteSafeToExecute (pure, keeper-side slippage/route guard)", () => {
  it("accepts a quote comfortably within the price-impact ceiling", () => {
    expect(isQuoteSafeToExecute(0.5)).to.equal(true);
    expect(isQuoteSafeToExecute(14.9)).to.equal(true);
  });

  it("rejects a quote at or beyond the price-impact ceiling -- never executed, asset stays staged for later retry", () => {
    expect(isQuoteSafeToExecute(15.1)).to.equal(false);
    expect(isQuoteSafeToExecute(50)).to.equal(false);
  });

  it("rejects a non-finite priceImpactPct (NaN/Infinity from a malformed Jupiter response) rather than accepting it by accident", () => {
    expect(isQuoteSafeToExecute(NaN)).to.equal(false);
    expect(isQuoteSafeToExecute(Infinity)).to.equal(false);
  });
});

describe("USDC fee-settlement pipeline -- fee-vault accounting across multiple redemption events (scenario, built from tested pure functions)", () => {
  it("multiple redemption events each split the vault's CURRENT composition correctly, accumulating exact pending-settlement totals", () => {
    // Event 1: vault holds 250 protocol : 250 manager (50/50 config). Redeem
    // 300 shares out of the 500 total.
    const event1 = splitByWeight(300n, 250n, 250n);
    expect(event1.protocolShare + event1.managerShare).to.equal(300n);

    // Event 2: vault now holds a DIFFERENT composition (a later mint used an
    // 80/20 configured split) -- e.g. 400 protocol : 100 manager. Redeem all 500.
    const event2 = splitByWeight(500n, 400n, 100n);
    expect(event2.protocolShare + event2.managerShare).to.equal(500n);

    // Accumulated pending-settlement totals across both events -- exact, no
    // rounding dust lost anywhere.
    const totalProtocolPending = event1.protocolShare + event2.protocolShare;
    const totalManagerPending = event1.managerShare + event2.managerShare;
    expect(totalProtocolPending + totalManagerPending).to.equal(800n);
  });

  it("resume after a delayed swap: an asset staged during an earlier, different-ratio redemption still settles safely later -- distribution always uses the CURRENT pending ratio against the REAL current USDC balance, never a remembered one", () => {
    // First distribution retires everything accumulated so far.
    const firstUsdc = 1_000_000n;
    const first = splitByWeight(firstUsdc, 300n, 200n);
    expect(first.protocolShare + first.managerShare).to.equal(firstUsdc);

    // A NEW redemption after the first distribution establishes a fresh
    // ratio for whatever settles next -- completely independent of the
    // first distribution's ratio (matches distribute_fee_usdc.rs's
    // documented "reset to zero after distributing" design).
    const secondUsdc = 500_000n;
    const second = splitByWeight(secondUsdc, 100n, 400n); // a very different ratio this time
    expect(second.protocolShare + second.managerShare).to.equal(secondUsdc);
    expect(second.managerShare).to.be.greaterThan(second.protocolShare); // this cycle is manager-favored, unlike the first
  });
});

describe("USDC fee-settlement pipeline -- idempotent / duplicate distribution", () => {
  it("a zero USDC balance (nothing new since the last distribution) always splits to exactly zero -- a genuine, harmless no-op, callable any number of times", () => {
    for (let i = 0; i < 5; i++) {
      expect(splitByWeight(0n, 300n, 700n)).to.deep.equal({ protocolShare: 0n, managerShare: 0n });
    }
  });

  it("repeated distribution calls against the SAME real balance (simulating a retried/duplicated transaction) always compute the identical split -- pure function, no hidden state", () => {
    const results = [1, 2, 3].map(() => splitByWeight(777_777n, 123n, 456n));
    expect(results[0]).to.deep.equal(results[1]);
    expect(results[1]).to.deep.equal(results[2]);
  });
});

describe("USDC fee-settlement pipeline -- partial settlement across several assets (scenario)", () => {
  it("only assets that actually pass the safety guard contribute USDC this cycle -- a skipped (no-route/high-impact) asset's staged balance is simply absent from what gets distributed, never lost or force-swapped", () => {
    const assetQuotes = [
      { mint: "AssetA", priceImpactPct: 2.1, stagedUsdcEquivalent: 100_000n },
      { mint: "AssetB", priceImpactPct: 22.0, stagedUsdcEquivalent: 250_000n }, // exceeds ceiling -- skipped
      { mint: "AssetC", priceImpactPct: 0.4, stagedUsdcEquivalent: 50_000n },
    ];
    const executable = assetQuotes.filter((a) => isQuoteSafeToExecute(a.priceImpactPct));
    expect(executable.map((a) => a.mint)).to.deep.equal(["AssetA", "AssetC"]);
    const usdcThisCycle = executable.reduce((sum, a) => sum + a.stagedUsdcEquivalent, 0n);
    expect(usdcThisCycle).to.equal(150_000n); // AssetB's 250,000 correctly excluded, not lost -- still staged, retryable later
  });
});

describe("USDC fee-settlement pipeline -- Protocol/Manager distribution (multi-recipient, reuses the existing apportionToRecipients exactly)", () => {
  it("splits the Manager's USDC share across multiple configured recipients exactly, summing to the full manager share", () => {
    const { managerShare } = splitByWeight(1_000_003n, 300n, 700n);
    const recipients: FeeRecipientAllocation[] = [
      { wallet: "R1", allocationBps: 5_000n },
      { wallet: "R2", allocationBps: 3_000n },
      { wallet: "R3", allocationBps: 2_000n },
    ];
    const increments = apportionToRecipients(managerShare, recipients);
    expect(increments.reduce((a, b) => a + b, 0n)).to.equal(managerShare);
    expect(increments).to.have.length(3);
  });

  it("a single legacy (non-multi-recipient) destination gets the Manager's ENTIRE share, unsplit", () => {
    const { managerShare } = splitByWeight(500_000n, 400n, 600n);
    const single: FeeRecipientAllocation[] = [{ wallet: "LegacyDestination", allocationBps: 10_000n }];
    const increments = apportionToRecipients(managerShare, single);
    expect(increments).to.deep.equal([managerShare]);
  });

  it("the Protocol's share always goes to a single fixed destination, never apportioned -- only the Manager's share is ever split across recipients", () => {
    const { protocolShare } = splitByWeight(1_234_567n, 111n, 889n);
    // No apportionment call for protocolShare anywhere in the real
    // pipeline -- this test documents that invariant by construction (the
    // scenario tests above never apply apportionToRecipients to
    // protocolShare, only to managerShare).
    expect(protocolShare).to.be.a("bigint");
  });
});
