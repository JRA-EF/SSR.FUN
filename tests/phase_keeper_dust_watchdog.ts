// DEC-0270: the fee keeper accrues TVL fees before anything that needs Jupiter,
// lets dust wait instead of retrying it every hour, and a run that never
// completes pages the team through a separate watchdog.
import { expect } from "chai";
import { readFileSync } from "node:fs";
import {
  KEEPER_MIN_DISTRIBUTE_USD, KEEPER_MIN_REDEEM_USD, KEEPER_MIN_SWAP_USD, KEEPER_UNPRICED_RETRY_UTC_HOUR,
  navPerReserveTokenUsd, stagedLegDecision, stagedUsdcWorthDistributing, vaultDecision,
} from "../lib/mainnet/keeperDust";
import { KEEPER_STALE_AFTER_MINUTES, keeperStaleMinutes } from "../lib/ops-alerts/keeperHeartbeat";
import { STEP_TITLES } from "../lib/ops-alerts/alertsPure";

const src = (p: string) => readFileSync(p, "utf8");
const NOT_RETRY_HOUR = (KEEPER_UNPRICED_RETRY_UTC_HOUR + 5) % 24;

describe("DEC-0270 keeper dust rules", () => {
  it("thresholds sit above what a keeper transaction costs (~$0.013)", () => {
    expect(KEEPER_MIN_SWAP_USD).to.equal(0.05);
    expect(KEEPER_MIN_REDEEM_USD).to.equal(0.05);
    expect(KEEPER_MIN_DISTRIBUTE_USD).to.equal(0.02);
  });
  it("a staged leg moves only when it is worth at least $0.05", () => {
    // 1,000 raw of a 6-decimal token at $1 = $0.001: dust (live: Reserve 8's 60 raw USDC-sized leftovers).
    expect(stagedLegDecision(1_000n, 6, 1, NOT_RETRY_HOUR)).to.equal("dust");
    expect(stagedLegDecision(50_000n, 6, 1, NOT_RETRY_HOUR)).to.equal("move");
    expect(stagedLegDecision(49_999n, 6, 1, NOT_RETRY_HOUR)).to.equal("dust");
    expect(stagedLegDecision(0n, 6, 1, NOT_RETRY_HOUR)).to.equal("dust");
  });
  it("an unpriced leg is tried once a day, not every hour", () => {
    expect(stagedLegDecision(10n ** 12n, 6, null, NOT_RETRY_HOUR)).to.equal("unpriced-wait");
    expect(stagedLegDecision(10n ** 12n, 6, NaN, NOT_RETRY_HOUR)).to.equal("unpriced-wait");
    expect(stagedLegDecision(10n ** 12n, 6, null, KEEPER_UNPRICED_RETRY_UTC_HOUR)).to.equal("move");
  });
  it("staged USDC is distributed from $0.02", () => {
    expect(stagedUsdcWorthDistributing(0n)).to.equal(false);
    expect(stagedUsdcWorthDistributing(19_999n)).to.equal(false);
    expect(stagedUsdcWorthDistributing(20_000n)).to.equal(true);
  });
  it("vault shares are valued at the Reserve's NAV from its own vaults", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    // 10 USDC + 1 JUP at $0.50 backing 10 Reserve Tokens -> $1.05 each.
    const nav = navPerReserveTokenUsd(
      [{ assetMint: usdc, decimals: 6, vaultBalanceRaw: "10000000" }, { assetMint: "JUP", decimals: 6, vaultBalanceRaw: "1000000" }],
      "10000000",
      (m) => (m === usdc ? 1 : 0.5),
    );
    expect(nav).to.be.closeTo(1.05, 1e-9);
    expect(navPerReserveTokenUsd([{ assetMint: "X", decimals: 6, vaultBalanceRaw: "5" }], "10", () => null)).to.equal(null);
    expect(navPerReserveTokenUsd([], "0", () => 1)).to.equal(null);
    // Live Reserve 59: 14,761 raw vault shares at ~$1 = $0.0148 -> waits.
    expect(vaultDecision(14_761n, 1, NOT_RETRY_HOUR)).to.equal("dust");
    expect(vaultDecision(50_000n, 1, NOT_RETRY_HOUR)).to.equal("move");
    expect(vaultDecision(50_000n, null, NOT_RETRY_HOUR)).to.equal("unpriced-wait");
  });
});

describe("DEC-0270 keeper wiring", () => {
  const cron = src("api/mainnet/fee-settlement-cron.ts");
  it("TVL accruals run before settlement", () => {
    const jobB = cron.indexOf("// Job B: TVL accrual FIRST");
    const jobA = cron.indexOf("// Job A: settlement");
    expect(jobB).to.be.greaterThan(0);
    expect(jobA).to.be.greaterThan(jobB);
    expect(cron).to.match(/Math\.min\(ACCRUAL_CONCURRENCY, accrualQueue\.length\)/);
  });
  it("settlement skips dust Reserves, dust vaults, dust legs and dust USDC", () => {
    expect(cron).to.match(/for \(const c of candidates\.filter\(\(c\) => planOf\.get\(c\.reserve\)\?\.actionable\)\)/);
    expect(cron).to.match(/vaultTotal > 0n && planOf\.get\(c\.reserve\)\?\.vault === "move"/);
    expect(cron).to.match(/status: dust === "dust" \? "skipped-dust" : "skipped-unpriced"/);
    expect(cron).to.match(/if \(!stagedUsdcWorthDistributing\(stagedUsdc\)\)/);
  });
  it("the budget stays under the 300 s function limit", () => {
    expect(cron).to.match(/const BUDGET_MS = 240_000;/).and.match(/export const config = \{ maxDuration: 300 \};/);
    expect(JSON.parse(src("vercel.json")).functions["api/mainnet/*.ts"].maxDuration).to.equal(300);
  });
  it("every completed run writes the heartbeat; a thrown run pages at once", () => {
    expect(cron).to.match(/writeKeeperHeartbeat\(getSql\(\), siteLabel\(\), summary\)/);
    expect(cron).to.match(/step: "keeper-crash"/);
    expect(STEP_TITLES["keeper-crash"]).to.be.a("string");
  });
});

describe("DEC-0270 keeper watchdog", () => {
  it("a run older than 75 minutes is stale", () => {
    const now = new Date("2026-10-28T13:30:00Z");
    expect(KEEPER_STALE_AFTER_MINUTES).to.equal(75);
    expect(keeperStaleMinutes(new Date("2026-10-28T12:16:00Z"), now)).to.equal(null); // 74 min: the 13:15 run may still be going
    expect(keeperStaleMinutes(new Date("2026-10-28T12:10:00Z"), now)).to.equal(80);
  });
  it("is scheduled every 15 minutes, passes the site gate, and alerts as keeper-stale", () => {
    const crons = JSON.parse(src("vercel.json")).crons as { path: string; schedule: string }[];
    expect(crons.find((c) => c.path === "/api/mainnet/keeper-watchdog")?.schedule).to.equal("*/15 * * * *");
    expect(src("middleware.ts")).to.include("'/api/mainnet/keeper-watchdog'");
    const wd = src("api/mainnet/keeper-watchdog.ts");
    expect(wd).to.match(/step: "keeper-stale"/).and.match(/timingSafeEqual/);
    expect(STEP_TITLES["keeper-stale"]).to.be.a("string");
  });
  it("imports nothing the keeper bundle needs beyond ops-alerts, so a broken keeper cannot take it down", () => {
    const imports = [...src("api/mainnet/keeper-watchdog.ts").matchAll(/^import [^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.filter((p) => p.startsWith("."))).to.deep.equal(["../devnet/_lib/apiTypes", "../../lib/ops-alerts/alerts", "../../lib/ops-alerts/keeperHeartbeat"]);
  });
});
