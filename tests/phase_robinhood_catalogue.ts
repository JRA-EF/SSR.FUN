// The Robinhood Chain asset catalogue's rules (lib/robinhood/catalogueRules.ts)
// and the wiring around them (route, cron, middleware, the Launch form's
// consumption). All offline.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_robinhood_catalogue.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_DEPTH_USD_FOR_OTHER_TOKENS,
  OFFICIAL_STOCK_TOKEN_BEACON,
  OFFICIAL_STOCK_TOKEN_CODE_HASH,
  QUOTES,
  classifyToken,
  dropSymbolImpersonators,
  isRobinhoodNamed,
  selectBestPool,
  sortForPicker,
  spotFromSqrtPrice,
  stripRobinhoodSuffix,
  type PoolFacts,
  type RobinhoodCatalogueToken,
} from "../lib/robinhood/catalogueRules";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" as const;
const FAKE_ARM = "0x5f0e3d5d2A54a3dE59fB5A34FE8D950900Ed3099" as const;
const FIH = "0x4b3A3FF4Ec9D289727e24A8152F406Bada44264D" as const;

describe("classifyToken -- an official stock token is proven by its code, not its name", () => {
  it("accepts the official beacon-proxy code hash as issuer 'robinhood', whatever the pool depth", () => {
    const c = classifyToken({ address: AAPL, name: "Apple • Robinhood Token", symbol: "AAPL", decimals: 18, codeHash: OFFICIAL_STOCK_TOKEN_CODE_HASH, depthUsd: 0.17 });
    expect(c).to.deep.equal({ issuer: "robinhood", eligible: true, ineligibleReason: null, displayName: "Apple" });
    expect(OFFICIAL_STOCK_TOKEN_BEACON).to.match(/^0x[0-9a-f]{40}$/);
  });

  it("refuses a copycat that carries the Robinhood name with different code (the 'ARM' the old list offered)", () => {
    const c = classifyToken({ address: FAKE_ARM, name: "Arm Holdings plc • Robinhood Token", symbol: "ARM", decimals: 18, codeHash: "0xe26ac15dc27c50f1", depthUsd: 50_000 });
    expect(c.issuer).to.equal(null);
    expect(c.eligible).to.equal(false);
    expect(c.ineligibleReason).to.match(/named like a Robinhood stock token/);
    // And one whose code was never read is refused too -- never offered on the name alone.
    expect(classifyToken({ address: FAKE_ARM, name: "Arm Holdings plc · Robinhood Token", symbol: "ARM", decimals: 18, codeHash: null, depthUsd: 50_000 }).eligible).to.equal(false);
  });

  it("accepts any other token with a deep enough pool (a graduated launchpad token), and refuses a dust pool", () => {
    const ok = classifyToken({ address: FIH, name: "Frog In Hood", symbol: "FIH", decimals: 18, codeHash: null, depthUsd: MIN_DEPTH_USD_FOR_OTHER_TOKENS });
    expect(ok).to.deep.equal({ issuer: null, eligible: true, ineligibleReason: null, displayName: "Frog In Hood" });
    const thin = classifyToken({ address: FIH, name: "Frog In Hood", symbol: "FIH", decimals: 18, codeHash: null, depthUsd: MIN_DEPTH_USD_FOR_OTHER_TOKENS - 0.01 });
    expect(thin.eligible).to.equal(false);
    expect(thin.ineligibleReason).to.match(/deepest pool holds under/);
    expect(classifyToken({ address: FIH, name: "Frog In Hood", symbol: "FIH", decimals: 18, codeHash: null, depthUsd: null }).ineligibleReason).to.match(/no pool/);
  });

  it("the quote assets are always eligible, under their plain names", () => {
    expect(classifyToken({ address: QUOTES.USDG.address, name: "Global Dollar", symbol: "USDG", decimals: 6, codeHash: null, depthUsd: null }).eligible).to.equal(true);
    expect(classifyToken({ address: QUOTES.WETH.address, name: "Wrapped Ether", symbol: "WETH", decimals: 18, codeHash: null, depthUsd: 1 }).displayName).to.equal("Wrapped Ether");
  });

  it("recognises both bullet spellings of the suffix and strips it for display", () => {
    expect(isRobinhoodNamed("Apple • Robinhood Token")).to.equal(true);
    expect(isRobinhoodNamed("Apple · Robinhood Token ")).to.equal(true);
    expect(isRobinhoodNamed("Robinhood Token Fan Club")).to.equal(false);
    expect(stripRobinhoodSuffix("Applied Optoelectronics • Robinhood Token")).to.equal("Applied Optoelectronics");
  });
});

describe("selectBestPool / spotFromSqrtPrice / sortForPicker", () => {
  const pool = (over: Partial<PoolFacts>): PoolFacts => ({ pool: "0x0000000000000000000000000000000000000001", token: FIH, quote: "USDG", fee: 3000, quoteBalance: 0, liquidity: 1n, sqrtPriceX96: null, ...over });

  it("picks the pool holding the most quote value, valuing WETH pools at the ETH price, and ignores pools with no in-range liquidity", () => {
    const best = selectBestPool(
      [pool({ pool: "0x0000000000000000000000000000000000000001", quoteBalance: 900 }), pool({ pool: "0x0000000000000000000000000000000000000002", quote: "WETH", quoteBalance: 1 }), pool({ pool: "0x0000000000000000000000000000000000000003", quoteBalance: 1_000_000, liquidity: 0n })],
      2_000,
    );
    expect(best!.pool.pool).to.equal("0x0000000000000000000000000000000000000002");
    expect(best!.depthUsd).to.equal(2_000);
    expect(selectBestPool([pool({ quote: "WETH", quoteBalance: 5 })], null)).to.equal(null);
  });

  it("spotFromSqrtPrice: a 1:1 pool of two 18-decimal tokens prices at 1 either way round", () => {
    const one = 2n ** 96n; // sqrt(1) * 2^96
    const low = "0x0000000000000000000000000000000000000001" as const;
    const high = "0xffffffffffffffffffffffffffffffffffffffff" as const;
    expect(spotFromSqrtPrice(one, low, 18, { symbol: "WETH", address: high, decimals: 18 })).to.be.closeTo(1, 1e-12);
    expect(spotFromSqrtPrice(one, high, 18, { symbol: "WETH", address: low, decimals: 18 })).to.be.closeTo(1, 1e-12);
    // AAPL (18 dec) vs USDG (6 dec). USDG's address is the lower one, so it is
    // token0 and sqrtPriceX96 encodes sqrt(AAPL raw per USDG raw): at 250 USDG
    // per AAPL that is 1e18 / 250e6 = 4e9.
    const sqrt = BigInt(Math.round(Math.sqrt(4e9) * 2 ** 96));
    expect(spotFromSqrtPrice(sqrt, AAPL, 18, QUOTES.USDG)).to.be.closeTo(250, 0.01);
  });

  it("dropSymbolImpersonators: a fake USDG/WETH or a fake stock-token symbol is dropped; the real ones and ordinary duplicates stay", () => {
    const t = (address: string, symbol: string, issuer: "robinhood" | null): RobinhoodCatalogueToken => ({ address: address as `0x${string}`, symbol, name: symbol, decimals: 18, issuer, pool: null, depthUsd: 1, priceUsd: null });
    const kept = dropSymbolImpersonators([
      t(QUOTES.USDG.address, "USDG", null),
      t("0x0000000000000000000000000000000000000001", "USDG", null),
      t("0x0000000000000000000000000000000000000002", "weth", null),
      t(QUOTES.WETH.address, "WETH", null),
      t(AAPL, "AAPL", "robinhood"),
      t("0x0000000000000000000000000000000000000003", "AAPL", null),
      t("0x0000000000000000000000000000000000000004", "PEPE", null),
      t("0x0000000000000000000000000000000000000005", "PEPE", null),
    ]);
    expect(kept.map((x) => x.address)).to.deep.equal([QUOTES.USDG.address, QUOTES.WETH.address, AAPL, "0x0000000000000000000000000000000000000004", "0x0000000000000000000000000000000000000005"]);
  });

  it("sortForPicker: USDG, WETH, stock tokens A-Z, then the rest by depth", () => {
    const t = (symbol: string, issuer: "robinhood" | null, depthUsd: number | null): RobinhoodCatalogueToken => ({ address: FIH, symbol, name: symbol, decimals: 18, issuer, pool: null, depthUsd, priceUsd: null });
    const sorted = sortForPicker([t("ZZZ", null, 5), t("NVDA", "robinhood", 1), t("WETH", null, 99), t("AAA", null, 50), t("AAPL", "robinhood", 1000), t("USDG", null, null)]);
    expect(sorted.map((x) => x.symbol)).to.deep.equal(["USDG", "WETH", "AAPL", "NVDA", "AAA", "ZZZ"]);
  });
});

describe("wiring", () => {
  it("the catalogue route is a public GET, the cron is scheduled with a long budget, and the hand-generated list is gone", () => {
    const mw = read("middleware.ts");
    const allow = mw.slice(mw.indexOf("const PUBLIC_READ_API_PATHS"), mw.indexOf("function isPublicReadApi"));
    expect(allow).to.include("'/api/robinhood/asset-catalogue'");
    const vercel = JSON.parse(read("vercel.json"));
    expect(vercel.crons.some((c: { path: string }) => c.path === "/api/robinhood/catalogue-refresh-cron")).to.equal(true);
    expect(vercel.functions["api/robinhood/catalogue-refresh-cron.ts"].maxDuration).to.equal(300);
    expect(read("api/robinhood/asset-catalogue.ts")).to.include("loadRobinhoodCatalogue");
    expect(read("api/robinhood/catalogue-refresh-cron.ts")).to.include("CRON_SECRET");
    const generated = read("src/merge/lib/robinhoodAssets.generated.ts");
    expect((generated.match(/address: "0x/g) ?? []).length).to.equal(2);
  });

  it("the Launch form composes from the live catalogue, with sliders, and never asks for a share count", () => {
    const form = read("src/merge/components/robinhood/RobinhoodCreateForm.tsx");
    expect(form).to.include("useRobinhoodAssetCatalogue(");
    expect(form).to.include("<Slider");
    expect(form).to.include("Unallocated USDG Reserve");
    expect(form).to.include("Initial Reserve Value (USDG)");
    expect(form).to.not.include("Initial shares");
    expect(form).to.not.include("initialShares:");
    expect(form).to.not.include("<datalist");
    expect(form).to.include("planLaunch(");
    expect(form).to.include("quoteLaunch(");
    expect(form).to.include("executeLaunch(");
    expect(form).to.include("Primary Fee Destination Wallet");
    expect(form).to.include("Additional Fee Recipients");
    expect(form).to.include("Co-Managers");
    expect(form).to.include("Wallet Cost Summary");
    expect(form).to.include("Reserve Metadata URL");
  });

  it("the launch sequence buys with USDG on Uniswap, approves exactly what it spends, and deploys 1:1 shares", () => {
    const launch = read("src/merge/lib/evmLaunch.ts");
    expect(launch).to.include("UNISWAP_V3_SWAP_ROUTER_02");
    expect(launch).to.include("initialShares: plan.initialShares");
    expect(launch).to.include("feeRecipients: input.feeRecipients");
    expect(launch).to.include("coManagers: input.coManagers");
    const swap = read("src/merge/lib/evmSwap.ts");
    expect(swap).to.include('"0xcaf681a66d020601342297493863e78c959e5cb2"');
    expect(swap).to.include('"0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"');
    expect(swap).to.include("amountOutMinimum: minOut");
    const reserve = read("src/merge/lib/evmReserve.ts");
    expect(reserve, "approve is simulated, gas is explicit, non-zero allowances are reset").to.include("pc.simulateContract(call)");
    expect(reserve).to.include("estimateContractGas(call)");
    expect(reserve).to.include("await send(0n)");
    expect(reserve).to.include("feeRecipients: input.feeRecipients.length > 0 ? input.feeRecipients");
  });
});
