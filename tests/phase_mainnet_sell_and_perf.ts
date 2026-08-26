// Offline regression coverage for DEC-0158: the USDC-settled multi-asset
// Mainnet Sell (redeem in-kind + sell each leg into USDC), live 24h/7d
// Reserve performance (refreshed price series on every sync), honest
// cost-basis accounting, the sell-direction Jupiter proxy, and the
// on-chain candidate-mint enumeration wiring.
//
// Live evidence being pinned here (2026-08-26, Creator's report after the
// first successful one-transaction buy): "7D Performance +0.00%" never
// moved with real asset prices (change24h/change7d were constructed 0 and
// never recomputed; price history only grew on the user's own trades);
// "Sell not yet supported" for CHARLI (no multi-asset redeem path); and
// landing-stats counted only ONE reserve (the Mainnet ledger had ingested
// nothing, so the candidate-mint list was empty) with $0 volume (only USDC
// was priced).
import { expect } from "chai";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildReadOnlyProgram } from "../packages/sdk/src/readOnly";
import { buildDirectMultiAssetRedeemInstructions } from "../packages/sdk/src/directInstructions";
import { computeRedemptionEntitlements } from "../packages/sdk/src/calculations";
import { findTvlAccrual } from "../packages/sdk/src/pda";
import {
  refreshPriceSeries,
  calcRecentChanges,
  weightedAvgCostBasis,
  PRICE_SYNC_MIN_INTERVAL_MS,
  type PricePoint,
} from "../src/merge/lib/calculations";
import { readPendingSell, savePendingSell, clearPendingSell, type PendingSellState } from "../src/merge/lib/multiAssetSellClient";
import jupiterSwapHandler from "../api/mainnet/jupiter-swap";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const SSR = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";
const OWNER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");

describe("Live 24h/7d performance (refreshPriceSeries) -- recomputed from a genuinely growing price history on every sync", () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;

  it("the exact live symptom can no longer occur: a Reserve whose NAV moved over 7 days reports the real percent changes, not +0.00%", () => {
    const now = Date.now();
    let history: PricePoint[] = [];
    // A week of syncs: NAV drifts from 1.00 to 1.03 (a 3% week), with the
    // last 24h moving from 1.01 to 1.03 (~1.98%).
    for (let d = 7; d >= 1; d--) {
      const price = d > 1 ? 1 + (7 - d) * 0.005 : 1.01;
      history = refreshPriceSeries(history, price, now - d * DAY).priceHistory;
    }
    const result = refreshPriceSeries(history, 1.03, now);
    expect(result.change7d).to.be.closeTo(3, 0.2);
    expect(result.change24h).to.be.closeTo(((1.03 - 1.01) / 1.01) * 100, 0.2);
    expect(result.change24h).to.not.equal(0);
  });

  it("throttles routine syncs (a 15s poll can't burn the point budget) but always records a genuine >=0.1% move immediately", () => {
    const now = Date.now();
    const base = refreshPriceSeries([], 1.0, now).priceHistory;
    expect(base).to.have.length(1);
    // 15s later, unchanged price -- no new point
    const unchanged = refreshPriceSeries(base, 1.0, now + 15_000);
    expect(unchanged.priceHistory).to.have.length(1);
    // 15s later, a real 0.5% move -- recorded immediately
    const moved = refreshPriceSeries(base, 1.005, now + 15_000);
    expect(moved.priceHistory).to.have.length(2);
    // after the routine interval, even an unchanged price appends a keep-alive point
    const interval = refreshPriceSeries(base, 1.0, now + PRICE_SYNC_MIN_INTERVAL_MS + 1);
    expect(interval.priceHistory).to.have.length(2);
  });

  it("drops the pre-first-fetch price:0 placeholder instead of using it as a percent-change base, and leaves history untouched when no real NAV is available", () => {
    const now = Date.now();
    const seeded = refreshPriceSeries([{ t: now - DAY, price: 0 }], 1.02, now);
    expect(seeded.priceHistory.every((p) => p.price > 0)).to.equal(true);
    expect(seeded.change24h).to.equal(0); // only one real point -- no fabricated change
    const noNav = refreshPriceSeries(seeded.priceHistory, 0, now + 60_000);
    expect(noNav.priceHistory).to.deep.equal(seeded.priceHistory);
  });

  it("calcRecentChanges picks the earliest point inside each rolling window (the 24h base is not the 7d base)", () => {
    const now = Date.now();
    const history: PricePoint[] = [
      { t: now - 6 * DAY, price: 1.0 },
      { t: now - 20 * HOUR, price: 1.1 },
    ];
    const { change24h, change7d } = calcRecentChanges(history, 1.21, now);
    expect(change7d).to.be.closeTo(21, 0.01);
    expect(change24h).to.be.closeTo(10, 0.01);
  });
});

describe("Honest cost basis (weightedAvgCostBasis) -- Unrealized P&L can no longer be structurally ~$0", () => {
  it("a first buy sets the basis to the actual price paid; a second buy at a different price moves it to the weighted average", () => {
    const first = weightedAvgCostBasis(0, 0, 10, 1.0);
    expect(first).to.equal(1.0);
    const second = weightedAvgCostBasis(10, 1.0, 10, 1.1);
    expect(second).to.be.closeTo(1.05, 1e-9);
  });

  it("the DEC-0149 live symptom, reconstructed: buying at $1.03 then the price rising to $1.04 shows real P&L against the $1.03 basis (a sync overwriting the basis to $1.04 would have shown $0.00)", () => {
    const basis = weightedAvgCostBasis(0, 0, 9.5288, 1.03);
    const pnl = (1.04 - basis) * 9.5288;
    expect(pnl).to.be.closeTo(0.0953, 0.001);
    expect(pnl).to.be.greaterThan(0);
  });
});

describe("Multi-asset in-kind redeem builder (buildDirectMultiAssetRedeemInstructions) -- the deployed account shape, entitlements included", () => {
  it("builds ATA creates first + ONE redeem last, pays every leg to the redeemer's own ATAs, uses the manager_fee_recipients None sentinel, and returns computeRedemptionEntitlements' exact floor-rounded amounts", async () => {
    const connection = new Connection("http://localhost:9999"); // never contacted -- .instruction() builds offline
    const program = buildReadOnlyProgram(connection);
    const RESERVE = new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb"); // CHARLI
    const RT_MINT = new PublicKey("J4XbyjS6iPHRQ8oPAAAc2GhmP3549ga9gZiu8MR5iimq");
    const assets = [
      { mint: WSOL, decimals: 9, reserveAsset: "6k3bmpVsP9T6mYHmJbJoGguQrrv7rB3wH8zqSRYo8kpa", vault: "9xQQ9UUjuUbKpu2E5Pswf8SsjfmEJVrYMdRwLX7spNvu", vaultBalanceRaw: "101896089" },
      { mint: SSR, decimals: 6, reserveAsset: "5wfs7tUrkvVzUPKst5mk7pHpMvvoZaskpkKSwk2huAfo", vault: "34hNxsxqBWH9czMKpng6zqcsmpg8SA4NeznenyF7VqH8", vaultBalanceRaw: "16187960040" },
    ];
    const { instructions, entitlementsRaw } = await buildDirectMultiAssetRedeemInstructions({
      program,
      reserve: RESERVE,
      reserveTokenMint: RT_MINT,
      vaultAuthority: new PublicKey("FAjR5aMW9j8fZwFw9nDxkhjU3fjDAGq8Taniby6rmrZ5"),
      user: OWNER,
      assets,
      reserveTokenSupplyRaw: "19900000",
      redemptionFeeBps: 100n,
      reserveTokensToRedeem: 9_500_000n,
    });
    expect(instructions).to.have.length(3); // 2 ATA creates + the redeem
    const redeemIx = instructions[instructions.length - 1];
    // 9 fixed accounts + 5 per leg
    expect(redeemIx.keys.length).to.equal(9 + 2 * 5);
    expect(redeemIx.keys[5].pubkey.toBase58()).to.equal(program.programId.toBase58()); // manager_fee_recipients "None" sentinel
    // Each leg pays the redeemer's OWN ATA (position 3 within each 5-tuple of remaining accounts)
    expect(redeemIx.keys[9 + 2].pubkey.equals(getAssociatedTokenAddressSync(new PublicKey(WSOL), OWNER))).to.equal(true);
    expect(redeemIx.keys[9 + 5 + 2].pubkey.equals(getAssociatedTokenAddressSync(new PublicKey(SSR), OWNER))).to.equal(true);
    // Entitlements match the shared floor-rounded math exactly
    const expected = computeRedemptionEntitlements(9_500_000n, 100n, 19_900_000n, [
      { mint: WSOL, vaultBalance: 101_896_089n },
      { mint: SSR, vaultBalance: 16_187_960_040n },
    ]);
    expect(entitlementsRaw).to.deep.equal(expected.map((e) => e.entitlement));
    expect(entitlementsRaw.every((e) => e > 0n)).to.equal(true);
    void findTvlAccrual; // referenced for parity with the mint-shape test suite
  });

  it("refuses a single-asset Reserve (that path is buildDirectRedeemInstructions')", async () => {
    const connection = new Connection("http://localhost:9999");
    const program = buildReadOnlyProgram(connection);
    try {
      await buildDirectMultiAssetRedeemInstructions({
        program,
        reserve: OWNER,
        reserveTokenMint: OWNER,
        vaultAuthority: OWNER,
        user: OWNER,
        assets: [{ mint: SSR, decimals: 6, reserveAsset: SSR, vault: SSR, vaultBalanceRaw: "1" }],
        reserveTokenSupplyRaw: "1",
        redemptionFeeBps: 0n,
        reserveTokensToRedeem: 1n,
      });
      expect.fail("expected a throw");
    } catch (e) {
      expect(String(e)).to.include("genuinely multi-asset");
    }
  });
});

describe("Pending-sale persistence (ssr_pending_sells_v1) -- refresh/reconnect recovery for the sequential fallback", () => {
  const store = new Map<string, string>();
  before(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  after(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  beforeEach(() => store.clear());

  const state = (wallet: string, reserve: string): PendingSellState => ({
    wallet,
    reserve,
    startedAt: 1_756_200_000_000,
    reserveTokensToRedeem: "9500000",
    preRedeemRtRaw: "29300000",
    preSaleUsdcRaw: "155888659",
    redeemSignature: "SigRedeem111",
    redeemConfirmed: true,
    legSwaps: { [WSOL]: { signature: "SigWsolSell111", confirmed: true }, [SSR]: { signature: "SigSsrSell111" } },
  });

  it("an interrupted sale round-trips completely: the redeem signature, per-leg swap progress, and the double-redeem baseline all survive", () => {
    savePendingSell(state("walletA", "reserveA"));
    const back = readPendingSell("walletA", "reserveA");
    expect(back?.redeemSignature).to.equal("SigRedeem111");
    expect(back?.redeemConfirmed).to.equal(true); // a landed redeem is never re-submitted (Reserve Tokens never burned twice)
    expect(back?.legSwaps[WSOL].confirmed).to.equal(true); // a landed swap is never repeated
    expect(back?.legSwaps[SSR].confirmed).to.equal(undefined); // the unfinished leg is exactly what resumes
  });

  it("sales of two different Reserves coexist; wallet/reserve isolation holds; corrupt JSON reads as no pending sale", () => {
    savePendingSell(state("walletA", "reserveA"));
    savePendingSell(state("walletA", "reserveB"));
    expect(readPendingSell("walletA", "reserveB")).to.not.equal(null);
    clearPendingSell("walletA", "reserveA");
    expect(readPendingSell("walletA", "reserveA")).to.equal(null);
    expect(readPendingSell("walletA", "reserveB")).to.not.equal(null);
    expect(readPendingSell("walletB", "reserveB")).to.equal(null);
    store.set("ssr_pending_sells_v1", "{corrupt");
    expect(readPendingSell("walletA", "reserveB")).to.equal(null);
  });
});

describe("api/mainnet/jupiter-swap -- the sell direction (asset -> USDC), USDC-settled only", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.JUPITER_API_KEY;
  let ipCounter = 100;
  const uniqueIp = () => `10.8.${++ipCounter}.1`;

  beforeEach(() => {
    process.env.JUPITER_API_KEY = "test-key";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = originalKey;
  });

  class FakeRes {
    statusCode = 0;
    body: unknown = null;
    status(code: number) {
      this.statusCode = code;
      return this;
    }
    json(b: unknown) {
      this.body = b;
    }
  }

  it("a non-USDC inputMint may ONLY swap into USDC -- any other output is a 400, never forwarded upstream", async () => {
    let upstreamCalled = false;
    global.fetch = (async () => {
      upstreamCalled = true;
      throw new Error("must not be called");
    }) as typeof fetch;
    const res = new FakeRes();
    await jupiterSwapHandler(
      { method: "POST", headers: { "x-forwarded-for": uniqueIp() }, body: { inputMint: SSR, outputMint: WSOL, amountRaw: "1000000", userPublicKey: OWNER.toBase58() } } as never,
      res as never,
    );
    expect(res.statusCode).to.equal(400);
    expect(upstreamCalled).to.equal(false);
  });

  it("asset -> USDC quotes with the real inputMint in the upstream quote URL and still builds with wrapAndUnwrapSol:false", async () => {
    let quoteUrl = "";
    let buildBody: Record<string, unknown> = {};
    const quoteJson = { inAmount: "7882479035", outAmount: "5210000", priceImpactPct: "0.02" };
    global.fetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("/quote")) {
        quoteUrl = u;
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(quoteJson), json: async () => quoteJson } as unknown as Response;
      }
      buildBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      const responseBody = { swapTransaction: "dGVzdA==", lastValidBlockHeight: 99 };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(responseBody), json: async () => responseBody } as unknown as Response;
    }) as typeof fetch;
    const res = new FakeRes();
    await jupiterSwapHandler(
      { method: "POST", headers: { "x-forwarded-for": uniqueIp() }, body: { inputMint: SSR, outputMint: USDC, amountRaw: "7882479035", userPublicKey: OWNER.toBase58() } } as never,
      res as never,
    );
    expect(res.statusCode).to.equal(200);
    expect(quoteUrl).to.include(`inputMint=${SSR}`);
    expect(quoteUrl).to.include(`outputMint=${USDC}`);
    expect(buildBody.wrapAndUnwrapSol).to.equal(false);
  });
});
