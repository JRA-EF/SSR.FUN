// DEC-0249: Create Reserve route check, the exact-100% gate, fund-before-
// create, the 20-minute price lock, slippage retries, and the saved draft.
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { allocationGateMessage, splitEvenly } from "../src/merge/lib/basketAllocation";
import { classifyPreflight, needsRouteCheck, runLaunchPreflight, PREFLIGHT_WARN_PRICE_IMPACT_PCT, WRAPPED_SOL_MINT_STR, type PreflightDeps } from "../lib/mainnet/launchPreflight";
import { JUPITER_KEY_REJECTED_MESSAGE, MAINNET_USDC_MINT, MAX_PRICE_IMPACT_PCT, MAX_SLIPPAGE_BPS, jupiterExhaustedResponse, type JupiterQuote } from "../lib/mainnet/jupiter";
import { parsePreflightRequest } from "../api/mainnet/launch-preflight";
import { blockedAssets, checkLaunchRoutes, isLaunchCheckFresh, launchCheckFingerprint, markLaunchFailure, warningAssets, LAUNCH_CHECK_MAX_AGE_MS, type LaunchCheckAsset } from "../src/merge/lib/launchPreflight";
import { isMeaningfulDraft } from "../src/merge/lib/createDraft";
import { LAUNCH_PRICE_LOCK_MS, LAUNCH_SWAP_SLIPPAGE_STEPS_BPS, SeedAssetFundingError } from "../src/merge/lib/createReserveClient";
import { JupiterQuoteError } from "../src/merge/lib/jupiterSwapClient";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const ok = (outAmount: string, priceImpactPct = "0.1"): { kind: "ok"; value: JupiterQuote } => ({
  kind: "ok",
  value: { inAmount: "1000000", outAmount, priceImpactPct, routePlan: [{ swapInfo: { label: "Raydium CLMM" } }] } as JupiterQuote,
});

describe("DEC-0249 -- allocations must total exactly 100%", () => {
  it("passes exactly 100%, including an uneven split", () => {
    expect(allocationGateMessage([0.5, 0.5])).to.equal(null);
    expect(allocationGateMessage(splitEvenly(7))).to.equal(null);
  });
  it("refuses under 100% and says how much is missing", () => {
    const msg = allocationGateMessage([0.4, 0.5]);
    expect(msg).to.contain("90%");
    expect(msg).to.contain("add the missing 10%");
  });
  it("refuses over 100% and says how much to take off", () => {
    const msg = allocationGateMessage([0.6, 0.5]);
    expect(msg).to.contain("110%");
    expect(msg).to.contain("take 10% off");
  });
  it("refuses an empty basket", () => {
    expect(allocationGateMessage([])).to.contain("at least one asset");
  });
});

describe("DEC-0249 -- server route classification", () => {
  const input = { mint: BONK, usdcBudgetRaw: 5_000_000n };

  it("Jupiter busy is 'unchecked', never a block", () => {
    expect(classifyPreflight(input, { kind: "exhausted", lastStatus: 429 }, null).status).to.equal("unchecked");
  });

  it("a rejected Jupiter key (401/403) says so -- never 'busy' or 'network error'", () => {
    for (const lastStatus of [401, 403]) {
      const r = classifyPreflight(input, { kind: "exhausted", lastStatus }, null);
      expect(r.status).to.equal("unchecked");
      expect(r.reason).to.equal(JUPITER_KEY_REJECTED_MESSAGE);
      const http = jupiterExhaustedResponse("quote", lastStatus);
      expect(http.error).to.equal(JUPITER_KEY_REJECTED_MESSAGE);
      expect(http.error).to.not.match(/network error|busy/i);
    }
    expect(jupiterExhaustedResponse("quote", 502).error).to.match(/network error/);
  });
  it("no route is 'blocked' and tells the creator to remove or replace it", () => {
    const r = classifyPreflight(input, { kind: "specific-error", message: "Could not find any route" }, null);
    expect(r.status).to.equal("blocked");
    expect(r.reason).to.contain("Could not find any route");
    expect(r.reason).to.contain("Remove it, or replace it");
  });
  it("a price impact the swap proxy would refuse is 'blocked'", () => {
    const r = classifyPreflight(input, ok("100", String(MAX_PRICE_IMPACT_PCT + 1)), ok("1"));
    expect(r.status).to.equal("blocked");
    expect(r.reason).to.contain("Too little trading liquidity");
  });
  it("thin but routable is a 'warning' the creator can continue past", () => {
    const r = classifyPreflight(input, ok("100", String(PREFLIGHT_WARN_PRICE_IMPACT_PCT + 2)), ok("1"));
    expect(r.status).to.equal("warning");
    expect(r.reason).to.contain("You can still continue");
  });
  it("no route back to USDC is a 'warning', not a block", () => {
    const r = classifyPreflight(input, ok("100"), { kind: "specific-error", message: "no route" });
    expect(r.status).to.equal("warning");
    expect(r.canSwapBack).to.equal(false);
  });
  it("a healthy route is 'ok' and carries the venues", () => {
    const r = classifyPreflight(input, ok("100"), ok("1"));
    expect(r.status).to.equal("ok");
    expect(r.route).to.deep.equal(["Raydium CLMM"]);
  });

  it("never quotes USDC or SOL, and sizes the swap-back at the swap-in's output", async () => {
    const calls: { inputMint: string; outputMint: string; amount: bigint }[] = [];
    const deps: PreflightDeps = { quote: async (p) => (calls.push({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount }), ok("777")) };
    const out = await runLaunchPreflight(deps, [
      { mint: MAINNET_USDC_MINT, usdcBudgetRaw: 1n },
      { mint: WRAPPED_SOL_MINT_STR, usdcBudgetRaw: 1n },
      { mint: BONK, usdcBudgetRaw: 2_000_000n },
    ]);
    expect(out.map((r) => r.status)).to.deep.equal(["ok", "ok", "ok"]);
    expect(calls).to.have.length(2);
    expect(calls[0]).to.deep.equal({ inputMint: MAINNET_USDC_MINT, outputMint: BONK, amount: 2_000_000n });
    expect(calls[1]).to.deep.equal({ inputMint: BONK, outputMint: MAINNET_USDC_MINT, amount: 777n });
    expect(needsRouteCheck(BONK)).to.equal(true);
  });

  it("validates the request", () => {
    expect(() => parsePreflightRequest({ assets: [] })).to.throw("at least one");
    expect(() => parsePreflightRequest({ assets: [{ mint: "x", usdcBudgetRaw: "1" }] })).to.throw("Invalid asset mint");
    expect(() => parsePreflightRequest({ assets: [{ mint: BONK, usdcBudgetRaw: "0" }] })).to.throw("positive");
    expect(() => parsePreflightRequest({ assets: [{ mint: BONK, usdcBudgetRaw: "1" }, { mint: BONK, usdcBudgetRaw: "2" }] })).to.throw("once");
    expect(parsePreflightRequest({ assets: [{ mint: BONK, usdcBudgetRaw: "5" }] })).to.deep.equal([{ mint: BONK, usdcBudgetRaw: 5n }]);
  });
});

describe("DEC-0249 -- browser route check", () => {
  const basket: LaunchCheckAsset[] = [
    { symbol: "USDC", mint: MAINNET_USDC_MINT, usdcBudgetUsd: 5, needsSwap: false },
    { symbol: "BONK", mint: BONK, usdcBudgetUsd: 3, needsSwap: true },
    { symbol: "WIF", mint: WIF, usdcBudgetUsd: 2, needsSwap: true },
  ];
  // Every mint reads as classic SPL (no Token-2022 extensions to refuse).
  const connection = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null) } as never;

  it("fingerprints a basket independent of order, and goes stale when it changes or ages", () => {
    expect(launchCheckFingerprint(basket)).to.equal(launchCheckFingerprint([...basket].reverse()));
    const check = { fingerprint: launchCheckFingerprint(basket), checkedAt: 1_000, results: [] };
    expect(isLaunchCheckFresh(check, basket, 1_000 + LAUNCH_CHECK_MAX_AGE_MS - 1)).to.equal(true);
    expect(isLaunchCheckFresh(check, basket, 1_000 + LAUNCH_CHECK_MAX_AGE_MS)).to.equal(false);
    expect(isLaunchCheckFresh(check, [{ ...basket[1], usdcBudgetUsd: 4 }, basket[0], basket[2]], 1_001)).to.equal(false);
  });

  it("maps the server's answer per asset and sends only the assets that are swapped", async () => {
    let sent: unknown = null;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          results: [
            { mint: BONK, status: "blocked", reason: "no route", priceImpactPct: null, route: [] },
            { mint: WIF, status: "warning", reason: "thin", priceImpactPct: 6, route: ["Orca"] },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    const check = await checkLaunchRoutes({ connection, assets: basket, isMainnet: true, fetchImpl });
    expect((sent as { assets: { mint: string; usdcBudgetRaw: string }[] }).assets).to.deep.equal([
      { mint: BONK, usdcBudgetRaw: "3000000" },
      { mint: WIF, usdcBudgetRaw: "2000000" },
    ]);
    expect(check.results.map((r) => [r.symbol, r.status])).to.deep.equal([["USDC", "ok"], ["BONK", "blocked"], ["WIF", "warning"]]);
    expect(blockedAssets(check).map((r) => r.symbol)).to.deep.equal(["BONK"]);
    expect(warningAssets(check).map((r) => r.symbol)).to.deep.equal(["WIF"]);
  });

  it("never blocks on its own outage: unreachable server leaves swapped assets 'unchecked' and USDC 'ok'", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const check = await checkLaunchRoutes({ connection, assets: basket, isMainnet: true, fetchImpl });
    expect(check.results.map((r) => r.status)).to.deep.equal(["ok", "unchecked", "unchecked"]);
    expect(blockedAssets(check)).to.have.length(0);
  });

  it("DevNet has nothing to route", async () => {
    const check = await checkLaunchRoutes({ connection, assets: basket, isMainnet: false });
    expect(check.results.every((r) => r.status === "ok")).to.equal(true);
  });

  it("a swap that failed during launch flags that asset as must-remove, keeping the rest of the check", () => {
    const prior = { fingerprint: "f", checkedAt: 1, results: [{ symbol: "WIF", mint: WIF, status: "ok" as const, reason: "", priceImpactPct: 0.2, route: [] }] };
    const next = markLaunchFailure(prior, { symbol: "BONK", mint: BONK }, "Route broke.", "f2");
    expect(next.fingerprint).to.equal("f2");
    const bonk = next.results.find((r) => r.symbol === "BONK")!;
    expect(bonk.status).to.equal("blocked");
    expect(bonk.failedDuringLaunch).to.equal(true);
    expect(bonk.reason).to.contain("Nothing was created on-chain");
    expect(next.results.find((r) => r.symbol === "WIF")!.status).to.equal("ok");
    expect(markLaunchFailure(null, { symbol: "BONK", mint: BONK }, "x", "f").results).to.have.length(1);
  });
});

describe("DEC-0249 -- launch engine", () => {
  const client = readFileSync("src/merge/lib/createReserveClient.ts", "utf8");
  const createFn = client.slice(client.indexOf("export async function createReserveOnChain"), client.indexOf("export async function checkReserveGenuinelyComplete"));

  it("funds every asset BEFORE the Reserve is created, so a bad route creates nothing", () => {
    const fund = createFn.indexOf('params.onProgress("fund-seed-assets")');
    const create = createFn.indexOf('params.onProgress("create-and-register")');
    const seed = createFn.indexOf('params.onProgress("seed")');
    expect(fund).to.be.greaterThan(-1);
    expect(fund).to.be.lessThan(create);
    expect(create).to.be.lessThan(seed);
    // A funding failure carries no Reserve addresses -- CreateDTR.tsx reads that as "nothing created".
    expect(createFn).to.contain('"fund-seed-assets", null, e)');
  });

  it("locks prices for 20 minutes and retries slippage up to the proxy's ceiling", () => {
    expect(LAUNCH_PRICE_LOCK_MS).to.equal(20 * 60 * 1000);
    expect(LAUNCH_SWAP_SLIPPAGE_STEPS_BPS[0]).to.equal(150);
    expect(LAUNCH_SWAP_SLIPPAGE_STEPS_BPS[LAUNCH_SWAP_SLIPPAGE_STEPS_BPS.length - 1]).to.equal(MAX_SLIPPAGE_BPS);
    expect(client).to.contain("priceLockUntil: pending.startedAt + LAUNCH_PRICE_LOCK_MS");
  });

  it("names the asset only for a route problem, never for Jupiter being busy", () => {
    expect(new JupiterQuoteError("x", 502, "no_route").isAssetRouteProblem).to.equal(true);
    expect(new JupiterQuoteError("x", 422, "price_impact").isAssetRouteProblem).to.equal(true);
    expect(new JupiterQuoteError("x", 502, "unavailable").isAssetRouteProblem).to.equal(false);
    expect(new JupiterQuoteError("x", 500, null).isAssetRouteProblem).to.equal(false);
    const e = new SeedAssetFundingError(BONK, "no route");
    expect(e.mint).to.equal(BONK);
  });

  it("the swap proxy tags every failure with a reason the client can act on", () => {
    const proxy = readFileSync("api/mainnet/jupiter-swap.ts", "utf8");
    for (const reason of ["no_route", "price_impact", "route_broken", "unavailable"]) expect(proxy).to.contain(`reason: "${reason}"`);
  });
});

describe("DEC-0249 -- the creator's work is kept", () => {
  it("saves only a draft with something in it", () => {
    expect(isMeaningfulDraft({ name: "", ticker: "", description: "", assets: [] })).to.equal(false);
    expect(isMeaningfulDraft({ name: "", ticker: "", description: "", assets: [{ symbol: "BONK", name: "Bonk", weight: 1 }] })).to.equal(true);
  });

  it("Create Reserve restores the draft, routes a funding failure back to the basket, and clears the draft on launch", () => {
    const page = readFileSync("src/merge/pages/CreateDTR.tsx", "utf8");
    expect(page).to.contain("readCreateDraft(wallet.address)");
    expect(page).to.contain('e.step === "fund-seed-assets" && e.addresses === null');
    expect(page).to.contain("markLaunchFailure(");
    expect(page).to.contain("clearCreateDraft();");
    expect(page).to.contain("allocationProblem !== null");
  });
});
