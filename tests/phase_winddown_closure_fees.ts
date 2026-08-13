// Offline, pure-logic regression coverage for the 2026-08-13 corrective pass
// (DEC-0093): wind-down redemptions, custom error 2040 on collect_fees, and
// the incorrect 80/20 mint-fee split. Matches this repo's existing testing
// split -- pure logic covered here offline; the live on-chain evidence (real
// DevNet signatures, before/after balances, the exact source of error 2040)
// is recorded in this pass's docs/project/DECISION_LOG.md entry instead, the
// same convention tests/phase_reserve_eligibility.ts documents for the prior
// wind-down-visibility fix this one builds on.
import { expect } from "chai";
import { isRedemptionAllowedForStatus } from "../packages/sdk/src/reserveEligibility";
import { computeFeeShareSplit, BPS_DENOMINATOR } from "../packages/sdk/src/calculations";
import { decodeAnchorFrameworkError, anchorFrameworkErrorRange } from "../packages/sdk/src/anchorFrameworkErrors";
import { decodeSsrProtocolError, describeOnChainError, extractCustomErrorCode } from "../packages/sdk/src/errors";

describe("isRedemptionAllowedForStatus (packages/sdk/src/reserveEligibility.ts) -- bug #1 fix", () => {
  it("allows redemption while Active", () => {
    expect(isRedemptionAllowedForStatus("active")).to.equal(true);
  });

  it("allows redemption while Paused (DEC-0016 -- redemption is exempt from pause)", () => {
    expect(isRedemptionAllowedForStatus("paused")).to.equal(true);
  });

  it("allows redemption while WindDown -- the exact reported bug (Sell was rejected with 'Reserve is not Active (status: windDown)')", () => {
    expect(isRedemptionAllowedForStatus("windDown")).to.equal(true);
  });

  it("does NOT allow redemption for created (never seeded, nothing to redeem)", () => {
    expect(isRedemptionAllowedForStatus("created")).to.equal(false);
  });

  it("does NOT allow redemption for assetsInitializing", () => {
    expect(isRedemptionAllowedForStatus("assetsInitializing")).to.equal(false);
  });

  it("does NOT allow redemption once Closed", () => {
    expect(isRedemptionAllowedForStatus("closed")).to.equal(false);
  });
});

describe("computeFeeShareSplit (packages/sdk/src/calculations.ts) -- bug #3 fix (rounding-completeness, config-driven split)", () => {
  it("splits a 985340n-share fee 50/50 exactly when configured 5000/5000 -- the user's exact reported scenario, corrected", () => {
    // Mirrors the reported Buy: total mint fee accrued was 985340 raw
    // Reserve Token base units (0.985340 VVVV). A genuinely 50/50-configured
    // Reserve must land on an exact half-and-half split (985340 is even, so
    // no rounding remainder even arises here).
    const { managerFeeShares, protocolFeeShares } = computeFeeShareSplit(985_340n, 5_000n, 5_000n);
    expect(managerFeeShares).to.equal(492_670n);
    expect(protocolFeeShares).to.equal(492_670n);
    expect(managerFeeShares + protocolFeeShares).to.equal(985_340n);
  });

  it("splits an odd total 50/50 with the single unit of rounding dust landing deterministically on the protocol (the exact-remainder side), never lost", () => {
    const { managerFeeShares, protocolFeeShares } = computeFeeShareSplit(985_341n, 5_000n, 5_000n);
    expect(managerFeeShares).to.equal(492_670n); // floor(985341 * 5000 / 10000)
    expect(protocolFeeShares).to.equal(492_671n); // exact remainder, never independently rounded
    expect(managerFeeShares + protocolFeeShares).to.equal(985_341n);
  });

  it("honors a real live-observed 80/20 configured split exactly -- proves the split is config-driven, not a hardcoded 50/50", () => {
    const { managerFeeShares, protocolFeeShares } = computeFeeShareSplit(1_000_000n, 8_000n, 2_000n);
    expect(managerFeeShares).to.equal(800_000n);
    expect(protocolFeeShares).to.equal(200_000n);
  });

  it("honors an arbitrary other valid split (37%/63%) exactly, confirming general config-driven behavior", () => {
    const { managerFeeShares, protocolFeeShares } = computeFeeShareSplit(1_000_000n, 3_700n, 6_300n);
    expect(managerFeeShares).to.equal(370_000n);
    expect(protocolFeeShares).to.equal(630_000n);
    expect(managerFeeShares + protocolFeeShares).to.equal(1_000_000n);
  });

  it("the sum of every distributed share always equals the total assessed fee, across a wide sweep of totals and splits", () => {
    const splits: [bigint, bigint][] = [
      [5_000n, 5_000n],
      [8_000n, 2_000n],
      [1n, 9_999n],
      [9_999n, 1n],
      [3_333n, 6_667n],
    ];
    for (const [m, p] of splits) {
      for (const total of [0n, 1n, 3n, 7n, 1_000n, 985_340n, 985_341n, 123_456_789n]) {
        const { managerFeeShares, protocolFeeShares } = computeFeeShareSplit(total, m, p);
        expect(managerFeeShares + protocolFeeShares, `total=${total} m=${m} p=${p}`).to.equal(total);
      }
    }
  });

  it("rejects a configured split that doesn't sum to BPS_DENOMINATOR -- create_reserve.rs now enforces this on-chain, so this should never happen for a real Reserve", () => {
    expect(() => computeFeeShareSplit(1_000_000n, 4_000n, 4_000n)).to.throw(/must equal BPS_DENOMINATOR/);
  });

  it("BPS_DENOMINATOR is 10000, matching programs/ssr_protocol/src/constants.rs", () => {
    expect(BPS_DENOMINATOR).to.equal(10_000n);
  });
});

describe("Error 2040 decoding (packages/sdk/src/anchorFrameworkErrors.ts + errors.ts) -- bug #2 diagnosis", () => {
  it("decodes 2040 as Anchor's own ConstraintDuplicateMutableAccount, not an ssr_protocol error", () => {
    const decoded = decodeAnchorFrameworkError(2040);
    expect(decoded).to.not.equal(null);
    expect(decoded?.name).to.equal("ConstraintDuplicateMutableAccount");
  });

  it("2040 is NOT defined in ssr_protocol's own custom-error table (confirms it's a framework error, not a custom one)", () => {
    expect(decodeSsrProtocolError(2040)).to.equal(null);
  });

  it("2040 falls in Anchor's account-constraint error range", () => {
    expect(anchorFrameworkErrorRange(2040)).to.equal("Anchor account-constraint error (#[account(...)] validation)");
  });

  it("describeOnChainError explains a raw Custom(2040) failure honestly, naming Anchor as the source (not ssr_protocol, not a foreign program)", () => {
    const raw = { InstructionError: [2, { Custom: 2040 }] };
    const message = describeOnChainError(raw);
    expect(message).to.match(/ConstraintDuplicateMutableAccount/);
    expect(message).to.match(/Anchor/);
    expect(message).to.match(/framework-level/);
  });

  it("extractCustomErrorCode parses the exact reported shape ([2, {Custom: 2040}])", () => {
    expect(extractCustomErrorCode({ InstructionError: [2, { Custom: 2040 }] })).to.equal(2040);
  });
});

describe("PendingFeesNotCollected (bug #5, closure safeguard) -- decodable as a real ssr_protocol error", () => {
  it("decodes 6043 as PendingFeesNotCollected against the committed IDL", () => {
    const decoded = decodeSsrProtocolError(6043);
    expect(decoded).to.not.equal(null);
    expect(decoded?.name).to.equal("PendingFeesNotCollected");
    expect(decoded?.msg).to.match(/collect_fees/);
  });

  it("describeOnChainError surfaces it by name for a raw Custom(6043) failure", () => {
    const message = describeOnChainError({ InstructionError: [1, { Custom: 6043 }] });
    expect(message).to.match(/PendingFeesNotCollected/);
  });
});
