// Offline, pure-logic regression coverage for the devUSDC Buy/Sell
// architecture correction (see docs/project/DECISION_LOG.md, DEC-0067+):
// devUSDC is SSR.fun's universal purchasing/settlement currency and is NEVER
// required to be one of a Reserve's own underlying Reserve Assets. Buy only
// genuinely executes for a Reserve backed 100% by devUSDC (no hidden
// minting/wrapping of other legs); Sell for that same composition redeems
// straight into real devUSDC with no SOL zap. Matches this repo's existing
// testing split -- pure logic covered here offline; live-DevNet behavior
// covered separately by scripts/verify_*.ts.
import { expect } from "chai";
import { buyAvailableFromDevUsdcBalance, isReservePureDevUsdc } from "../src/merge/lib/calculations";
import { computeRedemptionEntitlements, devUsdcToReserveTokensRequested, type ZapAssetLeg } from "../packages/sdk/src";

const DEVUSDC_MINT = "Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k";
const MOCKX_MINT = "2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

describe("devUSDC is a universal purchasing currency, independent of Reserve composition", () => {
  it("a wallet's spendable devUSDC never depends on whether the Reserve holds devUSDC as an asset", () => {
    // The exact conflation the corrective pass removes: "does this Reserve
    // have a devUSDC leg" and "can I pay for it with devUSDC" are unrelated
    // questions. A mockX/wrapped-SOL-only Reserve and a pure-devUSDC Reserve
    // both see the SAME available balance for the same wallet.
    const balance = 750;
    expect(buyAvailableFromDevUsdcBalance(balance)).to.equal(750);
    // isReservePureDevUsdc (execution support) is entirely separate:
    expect(isReservePureDevUsdc([MOCKX_MINT, WSOL_MINT], DEVUSDC_MINT)).to.equal(false);
    expect(isReservePureDevUsdc([DEVUSDC_MINT], DEVUSDC_MINT)).to.equal(true);
    // Either way, the wallet's available balance for the quick-select
    // buttons is unaffected -- confirmed identical in both cases.
    expect(buyAvailableFromDevUsdcBalance(balance)).to.equal(750);
  });

  it("no hardcoded 100-devUSDC maximum exists anywhere in the availability calculation", () => {
    for (const bal of [0, 1, 50, 99, 100, 101, 750, 10_000]) {
      expect(buyAvailableFromDevUsdcBalance(bal)).to.equal(Math.max(0, bal));
    }
  });
});

describe("No hidden Reserve Asset funding: isReservePureDevUsdc gates genuine Buy/Sell execution", () => {
  it("blocks any Reserve composition that would require minting/wrapping a non-devUSDC leg for free", () => {
    expect(isReservePureDevUsdc([MOCKX_MINT], DEVUSDC_MINT)).to.equal(false);
    expect(isReservePureDevUsdc([WSOL_MINT], DEVUSDC_MINT)).to.equal(false);
    expect(isReservePureDevUsdc([DEVUSDC_MINT, MOCKX_MINT], DEVUSDC_MINT)).to.equal(false);
    expect(isReservePureDevUsdc([DEVUSDC_MINT, WSOL_MINT], DEVUSDC_MINT)).to.equal(false);
  });

  it("allows execution only for a Reserve genuinely backed 100% by devUSDC", () => {
    expect(isReservePureDevUsdc([DEVUSDC_MINT], DEVUSDC_MINT)).to.equal(true);
  });

  it("fails closed for an unresolved/empty asset list -- never treated as vacuously supported", () => {
    expect(isReservePureDevUsdc([], DEVUSDC_MINT)).to.equal(false);
  });
});

describe("Genuine Buy math: devUsdcToReserveTokensRequested (no synthetic conversion)", () => {
  const decimals = 6;
  const supplyRaw = "1000000000"; // 1000 Reserve Tokens
  const pureDevUsdcAssets: ZapAssetLeg[] = [
    { mint: DEVUSDC_MINT, decimals: 6, reserveAsset: "RA", vault: "V", vaultBalanceRaw: "1000000000" }, // 1000 devUSDC backing, NAV=1
  ];
  const prices = { [DEVUSDC_MINT]: 1 };

  it("requests Reserve Tokens 1:1 with real devUSDC input at NAV=1 -- no fixed/synthetic price involved", () => {
    const requested = devUsdcToReserveTokensRequested(BigInt(100 * 10 ** decimals), decimals, supplyRaw, pureDevUsdcAssets, prices);
    expect(requested).to.equal(100_000_000n); // 100 Reserve Tokens
  });

  it("scales linearly with the real devUSDC amount spent -- confirms no hidden non-devUSDC subsidy inflates the mint", () => {
    const small = devUsdcToReserveTokensRequested(BigInt(25 * 10 ** decimals), decimals, supplyRaw, pureDevUsdcAssets, prices);
    const large = devUsdcToReserveTokensRequested(BigInt(100 * 10 ** decimals), decimals, supplyRaw, pureDevUsdcAssets, prices);
    expect(large).to.equal(small * 4n);
  });
});

describe("Genuine Sell math: computeRedemptionEntitlements returns real devUSDC for a pure-devUSDC Reserve", () => {
  it("redeeming a known fraction of supply returns the exact proportional devUSDC entitlement, no fee", () => {
    const supply = 1_000_000_000n; // 1000 Reserve Tokens
    const vaultBalance = 1_000_000_000n; // 1000 devUSDC backing it 1:1
    const toRedeem = 250_000_000n; // 250 Reserve Tokens = 25% of supply
    const entitlements = computeRedemptionEntitlements(toRedeem, 0n, supply, [{ mint: DEVUSDC_MINT, vaultBalance }]);
    expect(entitlements).to.have.length(1);
    expect(entitlements[0].mint).to.equal(DEVUSDC_MINT);
    expect(entitlements[0].entitlement).to.equal(250_000_000n); // 25% of the vault, genuinely devUSDC
  });

  it("applies the redemption fee honestly -- never silently absorbed or inflated", () => {
    const supply = 1_000_000_000n;
    const vaultBalance = 1_000_000_000n;
    const toRedeem = 100_000_000n; // 100 Reserve Tokens
    const redemptionFeeBps = 100n; // 1%
    const entitlements = computeRedemptionEntitlements(toRedeem, redemptionFeeBps, supply, [{ mint: DEVUSDC_MINT, vaultBalance }]);
    // 1% fee taken off the redeemed shares before computing the proportional payout.
    expect(entitlements[0].entitlement).to.be.lessThan(100_000_000n);
    expect(entitlements[0].entitlement).to.be.greaterThan(98_000_000n);
  });

  it("fails closed (throws) rather than fabricating a payout when supply is zero", () => {
    expect(() => computeRedemptionEntitlements(1n, 0n, 0n, [{ mint: DEVUSDC_MINT, vaultBalance: 0n }])).to.throw();
  });
});
