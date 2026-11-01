// DEC-0274: owner decisions on the 2026-10-30 campaign's open items, app-side only (no program upgrade before launch).
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { reserveNameProblem, RESERVE_NAME_MAX_BYTES } from "../src/merge/lib/reserveNameRules";
import { validateReserveMetadataPayload } from "../lib/reserve-metadata/payload";
import { APP_MAX_RESERVE_ASSETS } from "../src/merge/lib/seedBudget";
import { summarizeLiquidity, type LiveLiquidityState } from "../src/merge/lib/liquidity/liveLiquidityClient";
import { netCreatorEarnings } from "../src/merge/lib/liquidity/raydiumCpmm";

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("DEC-0274 campaign 2 follow-ups", () => {
  it("(8) a Reserve name must fit the 32-byte on-chain token name; the 84-character name from the campaign is refused", () => {
    expect(RESERVE_NAME_MAX_BYTES).eq(32);
    expect(reserveNameProblem("a".repeat(32))).eq(null);
    expect(reserveNameProblem("a".repeat(33))).to.match(/33 of 32 bytes/);
    expect(reserveNameProblem("é".repeat(17))).to.match(/34 of 32/);
    expect(reserveNameProblem("Two\nlines")).to.match(/line breaks/);
    expect(() => validateReserveMetadataPayload({ name: "x".repeat(84), ticker: "LONG" })).to.throw(/too long/);
    expect(() => validateReserveMetadataPayload({ name: "Fine", ticker: "ELEVENCHARS" })).to.throw(/at most 10/);
    expect(validateReserveMetadataPayload({ name: "Solana Blue Chips", ticker: "SSRES" }).ticker).eq("SSRES");
    expect(() => validateReserveMetadataPayload({ name: "Fine", ticker: "A B" })).to.throw(/no spaces/);
  });

  it("(6) every Reserve is capped at 10 assets: launch and rebalance add-asset use the same constant", () => {
    expect(APP_MAX_RESERVE_ASSETS).eq(10);
    expect(read("src/merge/pages/ManageDTR.tsx")).to.include("proposedAssetRows.length >= APP_MAX_RESERVE_ASSETS");
    expect(read("lib/mainnet/buildRebalance.ts")).to.match(/heldAfter > APP_MAX_RESERVE_ASSETS/);
  });

  it("(4) creator earnings are shown after Raydium's 5% share: #86's 13,244 raw gross pays the creator 5,033 (38%) with a 50% holder share", () => {
    const net = netCreatorEarnings(13_244n, 50_000n);
    expect(net).eq(12_582n);
    const ssr = net * 2_000n / 10_000n, holders = (net - ssr) * 5_000n / 10_000n;
    expect(net - ssr - holders).eq(5_033n);
    const s = { reserve: "R", creator: "C", treasury: "T", pool: "P", hasPool: true, paused: false, executionEnabled: true, reserveDecimals: 6, lpDecimals: 9,
      usdcBalanceRaw: "0", reserveBalanceRaw: "0", lpBalanceRaw: "0", nativeEarningsUsdcRaw: "12582", stagedEarningsUsdcRaw: "0", creatorShareRate: "50000",
      poolUsdcRaw: "0", poolReserveRaw: "0", lpSupplyRaw: "0", tranches: [] } as LiveLiquidityState;
    const sum = summarizeLiquidity(s, 1);
    expect(sum.raydiumSharePct).eq(5);
    expect(sum.earningsUsdc * 0.8 * 0.5).closeTo(0.005033, 1e-6);
    expect(read("api/mainnet/liquidity.ts")).to.include("nativeEarningsUsdcRaw:netCreatorEarnings(");
  });

  it("(2) the launch text and review state the doubled 0.15% transfer fee", () => {
    expect(read("src/merge/components/LiveLiquidityActions.tsx")).to.include("about 0.30% of the Reserve Tokens you add");
    expect(read("lib/mainnet/createLiquidity.ts")).to.include("reserveToPoolRaw:nav.netReserve.toString()");
    expect(read("src/merge/components/LiveLiquiditySection.tsx")).to.include("charged twice");
  });

  it("(9) a rebalance leg that hit a Jupiter rate limit reports busy, not 'route too large'", () => {
    const src = read("lib/mainnet/buildRebalance.ts");
    expect(src).to.include("jupiterBusy ? \"Jupiter's route service was busy (rate limited)");
  });
});
