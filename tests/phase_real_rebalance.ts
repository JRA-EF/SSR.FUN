// DEC-0250: a rebalance that really moves the vaults. The program side is
// exercised end to end against the compiled binary by tools/rebalance-litesvm
// (cargo run); these are the offline checks of the planner, the request
// parsing, the removal ordering, the client's cleanup gate and the display.
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { compactRemovalSteps, planRebalance, REBALANCE_DUST_USD, type PlanAsset } from "../lib/mainnet/rebalancePlan";
import { parseRebalanceRequest } from "../api/mainnet/build-rebalance";
import { cleanupAllowed, type RebalanceBuiltTx } from "../src/merge/lib/rebalanceClient";
import { visibleCompositionAssets } from "../src/merge/lib/onChainReserve";

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SOL = "So11111111111111111111111111111111111111112";
const GMA = "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ZEC = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

// The live "testes" Reserve on 2026-10-18: targets moved JUP to 0% and added
// USDC and ZEC, but the vaults never changed.
const testes: PlanAsset[] = [
  { mint: JUP, decimals: 6, balanceRaw: 11_849_154n, priceUsd: 0.28, targetBps: 0 },
  { mint: SOL, decimals: 9, balanceRaw: 32_605_808n, priceUsd: 102.1, targetBps: 3333 },
  { mint: GMA, decimals: 9, balanceRaw: 35_448_094_369n, priceUsd: 0.0938, targetBps: 3333 },
  { mint: USDC, decimals: 6, balanceRaw: 0n, priceUsd: 1, targetBps: 1704 },
  { mint: ZEC, decimals: 8, balanceRaw: 0n, priceUsd: 1090, targetBps: 1630 },
];

describe("DEC-0250 -- rebalance planner", () => {
  it("THE TESTES CASE: sells every JUP into USDC and ZEC, leaves on-target assets alone, then removes JUP", () => {
    const plan = planRebalance(testes);
    expect(plan.unpriced).to.deep.equal([]);
    expect(plan.legs.every((l) => l.sellMint === JUP)).to.equal(true);
    expect(new Set(plan.legs.map((l) => l.buyMint))).to.deep.equal(new Set([USDC, ZEC]));
    const sold = plan.legs.reduce((s, l) => s + l.amountInRaw, 0n);
    expect(sold).to.equal(11_849_154n); // to the last raw unit, so the vault reaches 0
    expect(plan.legs.some((l) => l.sellsAll)).to.equal(true);
    expect(plan.removals).to.deep.equal([JUP]);
  });

  it("splits by value: each buyer gets about its target share", () => {
    const plan = planRebalance(testes);
    const usdTo = (m: string) => plan.legs.filter((l) => l.buyMint === m).reduce((s, l) => s + l.usd, 0);
    const total = plan.totalUsd;
    expect(usdTo(USDC)).to.be.closeTo((total * 1704) / 10_000, REBALANCE_DUST_USD * 2);
    expect(usdTo(ZEC)).to.be.closeTo((total * 1630) / 10_000, REBALANCE_DUST_USD * 2);
  });

  it("does nothing when holdings are within dust of the targets", () => {
    const plan = planRebalance([
      { mint: USDC, decimals: 6, balanceRaw: 5_000_000n, priceUsd: 1, targetBps: 5000 },
      { mint: ZEC, decimals: 8, balanceRaw: 459_000n, priceUsd: 1090, targetBps: 5000 }, // ~$5.003
    ]);
    expect(plan.legs).to.deep.equal([]);
    expect(plan.removals).to.deep.equal([]);
  });

  it("refuses targets that are not exactly 100%", () => {
    expect(() => planRebalance(testes.map((a) => (a.mint === ZEC ? { ...a, targetBps: 1000 } : a)))).to.throw("exactly 100%");
  });

  it("refuses to plan when a held or targeted asset has no price", () => {
    const plan = planRebalance(testes.map((a) => (a.mint === ZEC ? { ...a, priceUsd: null } : a)));
    expect(plan.unpriced).to.deep.equal([ZEC]);
    expect(plan.legs).to.deep.equal([]);
  });

  it("empties a 0% asset even when nothing else is under target (value goes to the largest target)", () => {
    const plan = planRebalance([
      { mint: USDC, decimals: 6, balanceRaw: 10_000_000n, priceUsd: 1, targetBps: 10_000 },
      { mint: JUP, decimals: 6, balanceRaw: 1_000n, priceUsd: 0.28, targetBps: 0 }, // $0.00028 of dust
    ]);
    expect(plan.legs).to.have.length(1);
    expect(plan.legs[0]).to.include({ sellMint: JUP, buyMint: USDC, sellsAll: true });
    expect(plan.legs[0].amountInRaw).to.equal(1_000n);
    expect(plan.removals).to.deep.equal([JUP]);
  });

  it("an empty 0% asset is just removed, no swap", () => {
    const plan = planRebalance([
      { mint: USDC, decimals: 6, balanceRaw: 10_000_000n, priceUsd: 1, targetBps: 10_000 },
      { mint: ZEC, decimals: 8, balanceRaw: 0n, priceUsd: 1090, targetBps: 0 },
    ]);
    expect(plan.legs).to.deep.equal([]);
    expect(plan.removals).to.deep.equal([ZEC]);
  });
});

describe("DEC-0250 -- removal order (swap-remove)", () => {
  it("removing the first asset moves the last one into its place", () => {
    expect(compactRemovalSteps([JUP, SOL, GMA, USDC, ZEC], [JUP])).to.deep.equal([{ mint: JUP, lastAssetMint: ZEC }]);
  });
  it("removing the last asset moves nothing", () => {
    expect(compactRemovalSteps([JUP, SOL, ZEC], [ZEC])).to.deep.equal([{ mint: ZEC, lastAssetMint: null }]);
  });
  it("several removals track the order as it changes", () => {
    // [JUP, SOL, GMA, ZEC] remove JUP -> [ZEC, SOL, GMA]; remove ZEC -> [GMA, SOL].
    expect(compactRemovalSteps([JUP, SOL, GMA, ZEC], [JUP, ZEC])).to.deep.equal([
      { mint: JUP, lastAssetMint: ZEC },
      { mint: ZEC, lastAssetMint: GMA },
    ]);
  });
});

describe("DEC-0250 -- request and client gates", () => {
  it("validates the build request", () => {
    expect(() => parseRebalanceRequest({ reserve: "x", signer: JUP, targets: [] })).to.throw("valid addresses");
    expect(() => parseRebalanceRequest({ reserve: JUP, signer: JUP, targets: [] })).to.throw("1 to 24");
    expect(() => parseRebalanceRequest({ reserve: JUP, signer: JUP, targets: [{ mint: ZEC, targetBps: 10_001 }] })).to.throw("0 to 10000");
    expect(parseRebalanceRequest({ reserve: JUP, signer: JUP, targets: [{ mint: ZEC, targetBps: 10_000 }] }).targets).to.deep.equal([{ mint: ZEC, targetBps: 10_000 }]);
  });

  it("removal is only sent when every sale of the removed asset confirmed", () => {
    const tx = (o: Partial<RebalanceBuiltTx>): RebalanceBuiltTx => ({ kind: "swap", base64: "", bytes: 0, lastValidBlockHeight: 0, ...o });
    const cleanup = tx({ kind: "cleanup", removes: [JUP] });
    const ok = [
      { tx: tx({ sellMint: JUP, buyMint: USDC }), status: "confirmed" as const },
      { tx: tx({ sellMint: JUP, buyMint: ZEC }), status: "confirmed" as const },
    ];
    expect(cleanupAllowed(cleanup, ok)).to.equal(true);
    expect(cleanupAllowed(cleanup, [ok[0], { ...ok[1], status: "failed" as const }])).to.equal(false);
  });

  it("the composition hides a 0% asset only once its vault is empty", () => {
    const assets = [
      { mint: JUP, weightBps: 0 },
      { mint: ZEC, weightBps: 0 },
      { mint: USDC, weightBps: 10_000 },
    ];
    expect(visibleCompositionAssets(assets, { [JUP]: "0", [ZEC]: "5", [USDC]: "1" }).map((a) => a.mint)).to.deep.equal([ZEC, USDC]);
  });
});

describe("DEC-0250 -- program and IDL", () => {
  const idl = JSON.parse(readFileSync("packages/sdk/idl/ssr_protocol.json", "utf8")) as { instructions: { name: string }[]; errors: { code: number; name: string }[] };

  it("the SDK IDL carries the three new instructions", () => {
    const names = idl.instructions.map((i) => i.name);
    for (const n of ["rebalance_swap_begin", "rebalance_swap_end", "remove_reserve_asset_compact"]) expect(names).to.include(n);
  });

  it("new errors are appended after every deployed one (no renumbering)", () => {
    const code = (n: string) => idl.errors.find((e) => e.name === n)?.code;
    expect(code("LiquidityPrincipalLocked")).to.equal(6075);
    expect(code("RebalanceSwapEndMissing")).to.equal(6076);
    expect(code("RebalanceSwapMinimumNotMet")).to.equal(6077);
    expect(code("RebalanceSwapExceedsVault")).to.equal(6078);
    expect(code("RebalanceLastAssetMismatch")).to.equal(6079);
  });

  it("begin demands the matching end in the same transaction and SSR's quote signer", () => {
    const src = readFileSync("programs/ssr_protocol/src/instructions/rebalance_swap.rs", "utf8");
    expect(src).to.contain("RebalanceSwapEndMissing");
    expect(src).to.contain("require_fee_quote_signer");
    expect(src).to.contain("permission_flags::EXECUTE_REBALANCE");
    expect(src).to.contain("RebalanceSwapMinimumNotMet");
  });
});
