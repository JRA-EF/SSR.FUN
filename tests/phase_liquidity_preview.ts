/**
 * Liquidity Module design-preview helpers (DEC-0217/0218, DEC-0222/0223):
 * the pure functions behind the store actions in useAppStore.ts.
 *
 * Covers the DEC-0222 Compound rule (balanced re-add at the real NAV, never a
 * guessed $1 NAV), strengthen-only locks, badge kinds, and the v1 USDC-only
 * Solana pair selector (OPEN-2b).
 */

import { expect } from "chai";
import {
  compoundPreviewPool,
  dexInfoFor,
  hasValidNav,
  liquidityBadgeKind,
  strongerLock,
  type LiquidityPoolPreview,
} from "../src/merge/lib/liquidityPreview";

const T0 = 1_790_000_000_000;

function pool(overrides: Partial<LiquidityPoolPreview> = {}): LiquidityPoolPreview {
  return {
    poolAddress: "PreviewPool111111111111111111111111111111111",
    chain: "solana",
    quoteSymbol: "USDC",
    baseTokens: 5_000,
    quoteUsd: 5_000,
    createdTs: T0,
    lock: { mode: "none" },
    collectedTotalUsd: 0,
    compoundedTotalUsd: 0,
    collectedThroughTs: T0,
    ...overrides,
  };
}

describe("Liquidity preview -- Compound (DEC-0222)", () => {
  it("adds the fees back as balanced liquidity at the given NAV and restarts accrual", () => {
    const next = compoundPreviewPool(pool(), 240, 2, T0 + 1_000);
    expect(next).to.not.equal(null);
    expect(next!.quoteUsd).to.equal(5_120); // half the fees on the USDC side
    expect(next!.baseTokens).to.equal(5_060); // the other half as 60 tokens at NAV $2
    expect(next!.compoundedTotalUsd).to.equal(240);
    expect(next!.collectedThroughTs).to.equal(T0 + 1_000);
    expect(next!.collectedTotalUsd).to.equal(0); // Compound is not Collect
  });

  it("tolerates a persisted pool from before compoundedTotalUsd existed", () => {
    const legacy = pool();
    delete (legacy as Partial<LiquidityPoolPreview>).compoundedTotalUsd;
    const next = compoundPreviewPool(legacy, 10, 1);
    expect(next!.compoundedTotalUsd).to.equal(10);
  });

  it("is a no-op (null) without a valid NAV -- never falls back to $1", () => {
    for (const nav of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compoundPreviewPool(pool(), 240, nav), `nav=${nav}`).to.equal(null);
    }
  });

  it("is a no-op (null) when there is nothing to compound", () => {
    expect(compoundPreviewPool(pool(), 0, 2)).to.equal(null);
    expect(compoundPreviewPool(pool(), -5, 2)).to.equal(null);
    expect(compoundPreviewPool(pool(), Number.NaN, 2)).to.equal(null);
  });

  it("does not mutate the input pool", () => {
    const before = pool();
    const snapshot = { ...before };
    compoundPreviewPool(before, 100, 1);
    expect(before).to.deep.equal(snapshot);
  });

  it("hasValidNav accepts only finite positive numbers", () => {
    expect(hasValidNav(1.23)).to.equal(true);
    expect(hasValidNav(0)).to.equal(false);
    expect(hasValidNav(-0.5)).to.equal(false);
    expect(hasValidNav(Number.NaN)).to.equal(false);
    expect(hasValidNav(Number.POSITIVE_INFINITY)).to.equal(false);
  });
});

describe("Liquidity preview -- locks only strengthen", () => {
  it("permanent beats everything, longer timed beats shorter, timed beats none", () => {
    const timed6 = { mode: "timed" as const, months: 6, unlockTs: T0 + 6 };
    const timed12 = { mode: "timed" as const, months: 12, unlockTs: T0 + 12 };
    expect(strongerLock({ mode: "none" }, timed6)).to.deep.equal(timed6);
    expect(strongerLock(timed12, timed6)).to.deep.equal(timed12);
    expect(strongerLock(timed6, timed12)).to.deep.equal(timed12);
    expect(strongerLock(timed12, { mode: "permanent" })).to.deep.equal({ mode: "permanent" });
    expect(strongerLock({ mode: "none" }, { mode: "none" })).to.deep.equal({ mode: "none" });
  });

  it("badge kind follows the lock, and an expired timed lock reads as unlocked", () => {
    expect(liquidityBadgeKind({ mode: "none" }, T0)).to.equal("unlocked");
    expect(liquidityBadgeKind({ mode: "timed", months: 1, unlockTs: T0 + 1 }, T0)).to.equal("locked");
    expect(liquidityBadgeKind({ mode: "timed", months: 1, unlockTs: T0 - 1 }, T0)).to.equal("unlocked");
    expect(liquidityBadgeKind({ mode: "permanent" }, T0)).to.equal("permanent");
  });
});

describe("Liquidity preview -- chain-aware DEX info (DEC-0223)", () => {
  it("Solana is Raydium, USDC-only in v1, with an architecture-neutral pool label", () => {
    const dex = dexInfoFor("solana");
    expect(dex.name).to.equal("Raydium");
    expect(dex.altPairAvailable).to.equal(false); // OPEN-2b
    expect(dex.poolTypeLabel).to.equal("liquidity pool");
  });

  it("Robinhood is Uniswap with ETH as the alternate pair", () => {
    const dex = dexInfoFor("robinhood");
    expect(dex.name).to.equal("Uniswap");
    expect(dex.altPairSymbol).to.equal("ETH");
    expect(dex.altPairAvailable).to.equal(true);
  });
});
