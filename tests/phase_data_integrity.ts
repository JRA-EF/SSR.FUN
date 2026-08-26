// Offline, pure-logic regression coverage for the corrective DevNet
// data-integrity pass (see docs/project/PROJECT_STATUS.md): purging legacy/
// mock UI state, devUSDC as the default settlement asset, and RPC 429
// resilience for Reserve launching. Matches this repo's existing testing
// split -- pure logic covered here offline; live on-chain behavior (a real
// mint/redeem/launch) is covered by scripts/*.ts verification runs instead.
import { expect } from "chai";
import type { DTR } from "../src/merge/lib/types";
import { mergeDiscoveredReserves } from "../src/merge/lib/onChainReserve";
import { isRateLimitError, withRateLimitRetry } from "../src/merge/lib/createReserveClient";
import { devUsdcToReserveTokensRequested, type ZapAssetLeg } from "../packages/sdk/src";

function makeOnChainDtr(id: string, reserve: string): DTR {
  return {
    id,
    name: id,
    ticker: id.toUpperCase(),
    description: "",
    category: "DevNet Test",
    tags: [],
    logoSeed: id,
    dtrAddress: reserve,
    managerAddress: "11111111111111111111111111111111",
    delegates: [],
    feeConfig: {
      mintFeePct: 0.5,
      tvlFeePct: 1,
      managerBuyTaxPct: 0,
      managerSellTaxPct: 0,
      creatorFeeDestination: "11111111111111111111111111111111",
      feeRecipients: [],
    },
    tokenPrice: 1,
    nav: 1,
    aum: 0,
    liquidityUsdc: 0,
    change24h: 0,
    change7d: 0,
    holders: 0,
    composition: [],
    unallocatedPct: 0,
    isUserCreated: false,
    priceHistory: [{ t: Date.now(), price: 1 }],
    trades: [],
    onChain: {
      programId: "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
      reserveId: "0",
      reserve,
      reserveTokenMint: "11111111111111111111111111111111",
      mintAuthority: "11111111111111111111111111111111",
      vaultAuthority: "11111111111111111111111111111111",
      manager: "11111111111111111111111111111111",
      assets: [],
      status: "active",
      totalTargetWeightBps: 10_000,
      reserveTokenSupplyRaw: "0",
      vaultBalancesRaw: {},
    },
  };
}

function makeLegacyDtr(id: string): DTR {
  const d = makeOnChainDtr(id, "n/a");
  return { ...d, onChain: undefined };
}

describe("Corrective pass -- legacy/mock Reserve exclusion (mergeDiscoveredReserves)", () => {
  it("never includes a non-onChain (legacy/seed/simulated) DTR regardless of what discovery returns", () => {
    const legacy = makeLegacyDtr("blue");
    const { dtrs } = mergeDiscoveredReserves([legacy], [], true);
    expect(dtrs.find((d) => d.id === "blue")).to.equal(undefined);
  });

  it("fails closed: drops a previously-known on-chain DTR that's missing from a fully-verified discovery pass (genuinely closed)", () => {
    const closed = makeOnChainDtr("closed-one", "AAA");
    const { dtrs } = mergeDiscoveredReserves([closed], [], true);
    expect(dtrs).to.have.length(0);
  });

  it("does NOT drop a previously-known on-chain DTR missing from a pass that itself had unresolved issues (transient failure, not a real closure)", () => {
    const maybeTransient = makeOnChainDtr("maybe-transient", "BBB");
    const { dtrs } = mergeDiscoveredReserves([maybeTransient], [], false);
    expect(dtrs.find((d) => d.onChain?.reserve === "BBB")).to.not.equal(undefined);
  });

  it("keeps a genuinely re-discovered on-chain DTR, preserves its session-accumulated price history, and EXTENDS it with the fresh NAV (DEC-0158: history now grows on every discovery pass, not only on the user's own trades)", () => {
    const existing = { ...makeOnChainDtr("live-one", "CCC"), priceHistory: [{ t: 1, price: 1 }, { t: 2, price: 1.1 }, { t: 3, price: 1.2 }] };
    const fresh = makeOnChainDtr("live-one", "CCC");
    const { dtrs } = mergeDiscoveredReserves([existing], [fresh], true);
    expect(dtrs).to.have.length(1);
    // The accumulated points survive...
    expect(dtrs[0].priceHistory.slice(0, 3)).to.deep.equal(existing.priceHistory);
    // ...and the fresh pass's NAV is appended so 24h/7d performance has real data to work from.
    expect(dtrs[0].priceHistory.length).to.be.greaterThan(3);
    expect(dtrs[0].priceHistory[dtrs[0].priceHistory.length - 1].price).to.equal(fresh.nav);
  });
});

describe("Corrective pass -- RPC 429 resilience (createReserveClient.ts)", () => {
  it("isRateLimitError recognizes the real error shape @solana/web3.js throws for a 429 (HTTP status prefix + the RPC's own message)", () => {
    // Matches the actual live error observed this pass: `Error: 429 Too Many
    // Requests:  {"jsonrpc":"2.0","error":{"code": 429, "message":"Connection
    // rate limits exceeded"}, ...}` -- web3.js always prefixes the HTTP
    // status text, which is what this check keys on.
    expect(isRateLimitError(new Error('429 Too Many Requests:  {"jsonrpc":"2.0","error":{"code": 429, "message":"Connection rate limits exceeded"}}'))).to.equal(true);
  });

  it("isRateLimitError does not misclassify an unrelated error as rate-limiting", () => {
    expect(isRateLimitError(new Error("Invalid public key input"))).to.equal(false);
    expect(isRateLimitError(new Error("insufficient funds"))).to.equal(false);
  });

  it("withRateLimitRetry retries ONLY on a genuine rate-limit error, up to the bound, then succeeds", async () => {
    let attempts = 0;
    const result = await withRateLimitRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("429 Too Many Requests");
        return "ok";
      },
      5,
      1, // tiny delay so the test runs fast
    );
    expect(result).to.equal("ok");
    expect(attempts).to.equal(3);
  });

  it("withRateLimitRetry does NOT retry a non-rate-limit error -- fails fast instead of masking a real bug in a pointless retry loop", async () => {
    let attempts = 0;
    try {
      await withRateLimitRetry(
        async () => {
          attempts += 1;
          throw new Error("Invalid account data");
        },
        5,
        1,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).to.equal("Invalid account data");
    }
    expect(attempts).to.equal(1);
  });

  it("withRateLimitRetry gives up after maxRetries and rethrows the rate-limit error rather than retrying forever", async () => {
    let attempts = 0;
    try {
      await withRateLimitRetry(
        async () => {
          attempts += 1;
          throw new Error("429 Too Many Requests");
        },
        2,
        1,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).to.include("429");
    }
    expect(attempts).to.equal(3); // initial attempt + 2 retries, then gives up
  });
});

describe("Corrective pass -- devUSDC default settlement asset (devUsdcToReserveTokensRequested)", () => {
  const devUsdcDecimals = 6;

  it("computes the requested Reserve Token amount from a real devUSDC amount, no SOL-style price conversion", () => {
    const assets: ZapAssetLeg[] = [
      { mint: "devUSDCmintPlaceholder1111111111111111111111", decimals: 6, reserveAsset: "x", vault: "y", vaultBalanceRaw: "1000000000" }, // 1000 devUSDC in the vault
    ];
    const supplyRaw = "1000000000"; // 1000 Reserve Tokens outstanding, NAV = 1 (1000 USD backing / 1000 tokens)
    const prices = { "devUSDCmintPlaceholder1111111111111111111111": 1 };
    const devUsdcAmountRaw = BigInt(100 * 10 ** devUsdcDecimals); // 100 devUSDC in
    const requested = devUsdcToReserveTokensRequested(devUsdcAmountRaw, devUsdcDecimals, supplyRaw, assets, prices);
    expect(requested).to.equal(100_000_000n); // 100 Reserve Tokens (6 decimals) at NAV=1
  });

  it("scales proportionally with the devUSDC amount, matching a real $1-peg, not a fabricated rate", () => {
    const assets: ZapAssetLeg[] = [
      { mint: "m", decimals: 6, reserveAsset: "x", vault: "y", vaultBalanceRaw: "2000000000" }, // 2000 USD backing
    ];
    const supplyRaw = "1000000000"; // 1000 tokens -> NAV = 2
    const prices = { m: 1 };
    const small = devUsdcToReserveTokensRequested(BigInt(10 * 10 ** devUsdcDecimals), devUsdcDecimals, supplyRaw, assets, prices);
    const double = devUsdcToReserveTokensRequested(BigInt(20 * 10 ** devUsdcDecimals), devUsdcDecimals, supplyRaw, assets, prices);
    expect(double).to.equal(small * 2n);
  });

  it("never returns zero for a positive input (floors to at least 1 raw unit rather than silently rounding to nothing)", () => {
    const assets: ZapAssetLeg[] = [{ mint: "m", decimals: 6, reserveAsset: "x", vault: "y", vaultBalanceRaw: "1000000000000" }];
    const requested = devUsdcToReserveTokensRequested(1n, devUsdcDecimals, "1000000000", assets, { m: 1 });
    expect(requested).to.be.greaterThan(0n);
  });
});
