// Mint panel "Max" must leave room for what the server-built mint requires
// (assessBuyFeasibility's requiredUsdcRaw: swap budgets with the 2% buffer,
// any USDC leg, plus the USDC mint fee). Beta report 2026-11: Max filled the
// whole 2.90 USDC balance and the server refused "holds 2.90 but needs ~2.90".
import { expect } from "chai";
import { MAINNET_USDC_MINT } from "@ssr/sdk";
import {
  assessBuyFeasibility,
  planBuyFunding,
  maxMintUsdForUsdcBalance,
  mintUsdcPerDollar,
  BUY_SWAP_BUFFER_FRACTION,
} from "../src/merge/lib/multiAssetBuyPlan";

const OTHER_MINT = "So11111111111111111111111111111111111111112";

/** Server-side USDC requirement for a mint of `amountUsd`, split between a priced non-USDC leg and a USDC leg. */
function serverRequirement(amountUsd: number, usdcShare: number, feeBps: number, walletUsdc: number) {
  const usdcPart = BigInt(Math.floor(amountUsd * usdcShare * 1e6));
  const otherPart = BigInt(Math.floor(amountUsd * (1 - usdcShare) * 1e6));
  const legs = [
    { mint: OTHER_MINT, decimals: 6, requiredRaw: otherPart, walletHeldRaw: 0n, purchaseAcquiredRaw: 0n, priceUsd: 1 },
    ...(usdcPart > 0n ? [{ mint: MAINNET_USDC_MINT, decimals: 6, requiredRaw: usdcPart, walletHeldRaw: 0n, purchaseAcquiredRaw: 0n, priceUsd: 1 }] : []),
  ].filter((l) => l.requiredRaw > 0n);
  const plan = planBuyFunding(legs);
  const depositRaw = usdcPart + otherPart;
  const usdcMintFeeRaw = (depositRaw * BigInt(feeBps) + 9_999n) / 10_000n;
  return assessBuyFeasibility({ plan, walletUsdcRaw: BigInt(Math.round(walletUsdc * 1e6)), walletSolLamports: 1_000_000_000n, usdcMintFeeRaw });
}

describe("Mint panel Max (maxMintUsdForUsdcBalance) -- stays inside the server's USDC requirement", () => {
  it("per-dollar factor = swapped share * (1 + buffer) + USDC share + fee", () => {
    expect(mintUsdcPerDollar({ effectiveMintFeeBps: 50, usdcValueShare: 0 })).to.be.closeTo(1 + BUY_SWAP_BUFFER_FRACTION + 0.005, 1e-12);
    expect(mintUsdcPerDollar({ effectiveMintFeeBps: 50, usdcValueShare: 1 })).to.be.closeTo(1.005, 1e-12);
    expect(mintUsdcPerDollar({ effectiveMintFeeBps: 100, usdcValueShare: Number.NaN })).to.be.closeTo(1.03, 1e-12);
  });

  it("the reported 2.90 USDC wallet: Max is feasible on the server, the whole balance is not", () => {
    const factor = mintUsdcPerDollar({ effectiveMintFeeBps: 50, usdcValueShare: 0 });
    const max = maxMintUsdForUsdcBalance(2.9, factor);
    expect(max).to.be.greaterThan(2.7);
    expect(serverRequirement(max, 0, 50, 2.9).feasible).to.equal(true);
    expect(serverRequirement(2.9, 0, 50, 2.9).feasible).to.equal(false);
  });

  it("is feasible across balances, fee rates and USDC shares", () => {
    for (const balance of [0.5, 1, 2.9, 10, 137.42, 5000]) {
      for (const feeBps of [50, 100, 250]) {
        for (const share of [0, 0.3, 1]) {
          const max = maxMintUsdForUsdcBalance(balance, mintUsdcPerDollar({ effectiveMintFeeBps: feeBps, usdcValueShare: share }));
          expect(serverRequirement(max, share, feeBps, balance).feasible, `${balance} USDC, ${feeBps} bps, share ${share}`).to.equal(true);
        }
      }
    }
  });

  it("returns 0 for an empty wallet and never a fraction of a cent", () => {
    expect(maxMintUsdForUsdcBalance(0, 1.025)).to.equal(0);
    const max = maxMintUsdForUsdcBalance(12.3456, 1.025);
    expect(Math.round(max * 100)).to.equal(max * 100);
  });
});
