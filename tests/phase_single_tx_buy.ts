// Offline regression coverage for DEC-0156: the ONE-transaction Mainnet buy
// (every swap + any recovered-SOL re-wrap + ATA creations + the in-kind
// mint composed into a single wallet-signed atomic transaction), the
// universal wrapAndUnwrapSol:false swap build, the recovered-SOL re-wrap
// plan action, and the SPL-Token inner-CPI error decoding.
//
// Live evidence being pinned here (2026-08-26, wallet 6BjTPAWG...):
//  - 10:21:22 swap USDC->wSOL landed (+50,654,504 raw wSOL) [3thjKXxb...]
//  - 10:21:31 swap USDC->SSR landed (+7,966,690,976 raw SSR), but its
//    route hopped through SOL and Jupiter's default cleanup CLOSED the
//    buyer's wSOL ATA (closeAccount 53956dY7... -> owner), sweeping ALL
//    wrapped SOL -- the just-bought leg AND the stranded 51,510,414 raw --
//    into native SOL [n6JMY9xF...]
//  - 10:21:39 the mint failed InstructionError[5,{Custom:1}] = SPL Token
//    "Error: insufficient funds" on the wSOL deposit transfer, because the
//    wSOL ATA had just been emptied and closed [4Mgj2LxT...]
import { expect } from "chai";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  planBuyFunding,
  assessBuyFeasibility,
  buildBuyStateReport,
  DEFAULT_BUY_FEE_LAMPORTS,
  type BuyLegInput,
} from "../src/merge/lib/multiAssetBuyPlan";
import {
  assembleSingleBuyInstructions,
  buildWrapRecoveredSolInstructions,
  compileSingleBuyTransaction,
  deserializeJupiterInstruction,
  isComputeBudgetInstruction,
  SingleTxTooLargeError,
  SINGLE_TX_COMPUTE_UNIT_LIMIT,
  type JupiterInstructionJson,
} from "../src/merge/lib/singleTxBuy";
import { describeOnChainError } from "../packages/sdk/src/errors";
import jupiterSwapHandler from "../api/mainnet/jupiter-swap";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const SSR = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";
const OWNER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");

describe("Recovered-SOL re-wrap planning (wrap-recovered-sol) -- the live post-sweep wallet state resumes without a second USDC charge", () => {
  // The literal live state after the 2026-08-26 sweep: the purchase's own
  // recorded swap bought 50,654,504 raw wSOL, the wallet now holds 0
  // wrapped (it was force-unwrapped to native SOL), SSR fully acquired.
  const liveLegs = (): BuyLegInput[] => [
    { mint: WSOL, decimals: 9, requiredRaw: 49_626_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 50_654_504n, priceUsd: 96.52 },
    { mint: SSR, decimals: 6, requiredRaw: 7_883_878_195n, walletHeldRaw: 162_245_027_528n, purchaseAcquiredRaw: 7_966_690_976n, priceUsd: 0.000661 },
  ];

  it("the exact live stranded state plans a re-wrap of the required amount, ZERO further USDC, and no swap -- the $4.89 of wSOL this purchase already bought is restored, never repurchased", () => {
    const plan = planBuyFunding(liveLegs());
    expect(plan.actions.filter((a) => a.kind === "jupiter-swap")).to.have.length(0);
    expect(plan.totalSwapUsdcRaw).to.equal(0n);
    const wrap = plan.actions.find((a) => a.kind === "wrap-recovered-sol");
    expect(wrap?.kind).to.equal("wrap-recovered-sol");
    if (wrap?.kind === "wrap-recovered-sol") expect(wrap.lamports).to.equal(49_626_000n); // capped at the deficit, not the full recorded acquisition
    expect(plan.totalWrapLamports).to.equal(49_626_000n);
    expect(plan.actions.find((a) => a.mint === SSR)?.kind).to.equal("already-funded");
  });

  it("a re-wrap never exceeds the recorded acquired-but-unwrapped amount -- any remainder beyond it is a genuine USDC swap", () => {
    const legs: BuyLegInput[] = [{ mint: WSOL, decimals: 9, requiredRaw: 60_000_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 50_000_000n, priceUsd: 96.52 }];
    const plan = planBuyFunding(legs);
    const wrap = plan.actions.find((a) => a.kind === "wrap-recovered-sol");
    const swap = plan.actions.find((a) => a.kind === "jupiter-swap");
    if (wrap?.kind === "wrap-recovered-sol") expect(wrap.lamports).to.equal(50_000_000n);
    else expect.fail("expected a wrap action");
    if (swap?.kind === "jupiter-swap") expect(swap.deficitRaw).to.equal(10_000_000n);
    else expect.fail("expected a top-up swap for the never-acquired remainder");
  });

  it("a NON-wSOL leg never wraps -- recorded-but-missing amounts of any other asset are a genuine re-swap (there is no 'unwrapped' form to recover)", () => {
    const legs: BuyLegInput[] = [{ mint: SSR, decimals: 6, requiredRaw: 1_000_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 1_000_000n, priceUsd: 0.000661 }];
    const plan = planBuyFunding(legs);
    expect(plan.actions.find((a) => a.kind === "wrap-recovered-sol")).to.equal(undefined);
    expect(plan.actions.filter((a) => a.kind === "jupiter-swap")).to.have.length(1);
  });

  it("feasibility requires the native balance to cover fees PLUS the re-wrap, and the re-wrap is not conflated into the USDC requirement", () => {
    const plan = planBuyFunding(liveLegs());
    const notEnoughSol = assessBuyFeasibility({ plan, walletUsdcRaw: 0n, walletSolLamports: plan.totalWrapLamports });
    expect(notEnoughSol.feasible).to.equal(false); // wrap covered but no headroom for fees
    const enough = assessBuyFeasibility({ plan, walletUsdcRaw: 0n, walletSolLamports: plan.totalWrapLamports + DEFAULT_BUY_FEE_LAMPORTS });
    expect(enough.feasible).to.equal(true); // and ZERO USDC needed -- the purchase already spent it
    expect(enough.requiredUsdcRaw).to.equal(0n);
  });

  it("the failure report's retry summary names the re-wrap for the recorded wSOL and promises no extra USDC for it", () => {
    const report = buildBuyStateReport(
      [
        { mint: WSOL, symbol: "SOL", requiredRaw: 49_626_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 50_654_504n },
        { mint: SSR, symbol: "SSR", requiredRaw: 7_883_878_195n, walletHeldRaw: 162_245_027_528n, purchaseAcquiredRaw: 7_966_690_976n },
      ],
      19_800_000n,
      19_800_000n,
      9_575_600n,
      "the final mint that deposits the acquired assets and delivers your Reserve Tokens",
    );
    expect(report.retrySummary).to.include("re-wrap");
    expect(report.retrySummary).to.include("no extra USDC");
    expect(report.retrySummary).to.not.include("shortfall of: SOL"); // the wSOL shortfall is recovered, not repurchased
  });
});

describe("Single-transaction composition (singleTxBuy.ts) -- one wallet approval, atomic, cleanup never included", () => {
  const jupIx = (programId: string, dataBytes: number[]): JupiterInstructionJson => ({
    programId,
    accounts: [
      { pubkey: OWNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: USDC, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(dataBytes).toString("base64"),
  });

  it("deserializes a Jupiter wire instruction faithfully (program, signer/writable flags, data)", () => {
    const ix = deserializeJupiterInstruction(jupIx(SSR, [9, 9, 9]));
    expect(ix.programId.toBase58()).to.equal(SSR);
    expect(ix.keys[0].isSigner).to.equal(true);
    expect(ix.keys[1].isWritable).to.equal(true);
    expect([...ix.data]).to.deep.equal([9, 9, 9]);
  });

  it("builds the recovered-SOL re-wrap as a system transfer of EXACTLY the recorded lamports into the owner's own wSOL ATA, followed by a syncNative", () => {
    const ixs = buildWrapRecoveredSolInstructions(OWNER, 49_626_000n);
    expect(ixs).to.have.length(2);
    expect(ixs[0].programId.equals(SystemProgram.programId)).to.equal(true);
    const wsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL), OWNER);
    expect(ixs[0].keys[1].pubkey.equals(wsolAta)).to.equal(true);
    // SystemProgram.transfer data: u32 instruction index (2) + u64 lamports LE
    const lamports = Buffer.from(ixs[1 - 1].data).readBigUInt64LE(4);
    expect(lamports).to.equal(49_626_000n);
    expect(ixs[1].keys[0].pubkey.equals(wsolAta)).to.equal(true); // syncNative on the same ATA
  });

  it("assembles in the exact safe order -- ONE compute budget pair first, ATA creations, swap setups+swaps (their own compute-budget instructions dropped), the re-wrap, then the mint LAST -- and never any cleanup instruction", () => {
    const ataCreate = SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: OWNER, lamports: 1n }); // stand-in
    const mint = SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: OWNER, lamports: 2n }); // stand-in
    const wrap = buildWrapRecoveredSolInstructions(OWNER, 1_000n);
    const swapSet = {
      setupInstructions: [
        jupIx("ComputeBudget111111111111111111111111111111", [1]), // must be dropped
        jupIx(SSR, [7]),
      ],
      swapInstruction: jupIx(SSR, [42]),
      addressLookupTableAddresses: [],
    };
    const ixs = assembleSingleBuyInstructions({ ataCreateInstructions: [ataCreate], swapSets: [swapSet], wrapInstructions: wrap, mintInstruction: mint });
    // [cuLimit, cuPrice, ataCreate, setup(SSR only), swap, wrap transfer, syncNative, mint]
    expect(ixs).to.have.length(8);
    expect(isComputeBudgetInstruction(ixs[0])).to.equal(true);
    expect(isComputeBudgetInstruction(ixs[1])).to.equal(true);
    expect(ixs.filter(isComputeBudgetInstruction)).to.have.length(2); // the swap's own budget ix was dropped -- duplicates fail the whole transaction
    expect(ixs[ixs.length - 1]).to.equal(mint); // the mint is always last -- it must see every swap/wrap output
    // The compute limit covers the whole composed purchase:
    const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: SINGLE_TX_COMPUTE_UNIT_LIMIT });
    expect(Buffer.compare(ixs[0].data, limitIx.data)).to.equal(0);
  });

  it("compiles a fitting purchase into one v0 transaction, and throws SingleTxTooLargeError (typed, for the sequential fallback) when it genuinely cannot fit", () => {
    const blockhash = PublicKey.default.toBase58();
    const small = compileSingleBuyTransaction({
      payer: OWNER,
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: OWNER, lamports: 1n })],
      lookupTables: [],
    });
    expect(small.serialize().length).to.be.lessThan(1233);
    // 40 unique destination accounts = 1280 bytes of account keys alone --
    // genuinely uncompilable into one transaction without lookup tables.
    const huge = Array.from({ length: 40 }, (_, i) =>
      SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: new PublicKey(Buffer.alloc(32, i + 1)), lamports: BigInt(i + 1) }),
    );
    expect(() =>
      compileSingleBuyTransaction({ payer: OWNER, recentBlockhash: blockhash, instructions: huge, lookupTables: [] }),
    ).to.throw(SingleTxTooLargeError);
  });
});

describe("The complete decoded live Custom(1) failure -- SPL Token InsufficientFunds from an inner CPI, never misread as an ssr_protocol error", () => {
  it("the exact production error shape (InstructionError[5,{Custom:1}]) decodes to SPL Token InsufficientFunds with the inner-CPI attribution and an honest hedge", () => {
    const raw = `Transaction failed on-chain ({"InstructionError":[5,{"Custom":1}]}).`;
    const described = describeOnChainError(new Error(raw));
    expect(described).to.include("SPL Token error 1");
    expect(described).to.include("InsufficientFunds");
    expect(described).to.include("inner CPI");
    expect(described).to.include("most likely"); // hedged -- several native programs share small codes
    expect(described).to.not.include("SsrError::");
    expect(described).to.not.include("drifted"); // the old fallback's misleading IDL-drift guess for small codes
  });

  it("Anchor framework decoding still wins for its own range (3002 unchanged by the SPL table)", () => {
    const described = describeOnChainError(new Error(`Transaction failed on-chain ({"InstructionError":[5,{"Custom":3002}]}).`));
    expect(described).to.include("AccountDiscriminatorMismatch");
    expect(described).to.not.include("SPL Token");
  });
});

describe("api/mainnet/jupiter-swap -- universal wrapAndUnwrapSol:false and the instructions mode (DEC-0156)", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.JUPITER_API_KEY;
  let ipCounter = 0;
  const uniqueIp = () => `10.9.${++ipCounter}.1`; // per-test IPs -- the shared in-memory rate limiter must never couple tests (DEC-0148)

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

  const quoteJson = { inAmount: "5000000", outAmount: "50000000", priceImpactPct: "0.01" };

  function stubJupiter(onSwapBuild: (url: string, bodyJson: Record<string, unknown>) => unknown) {
    const swapBuildBodies: Record<string, unknown>[] = [];
    global.fetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("/quote")) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(quoteJson), json: async () => quoteJson } as unknown as Response;
      }
      const bodyJson = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      swapBuildBodies.push(bodyJson);
      const responseBody = onSwapBuild(u, bodyJson);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(responseBody), json: async () => responseBody } as unknown as Response;
    }) as typeof fetch;
    return swapBuildBodies;
  }

  it("EVERY swap build sends wrapAndUnwrapSol:false -- even a plain non-wSOL output with no receiveWrappedSol flag (the exact live sweep: a USDC->SSR route's cleanup closed the buyer's wSOL ATA and destroyed another leg's funding)", async () => {
    const bodies = stubJupiter(() => ({ swapTransaction: "dGVzdA==", lastValidBlockHeight: 123 }));
    const res = new FakeRes();
    await jupiterSwapHandler(
      { method: "POST", headers: { "x-forwarded-for": uniqueIp() }, body: { outputMint: SSR, amountRaw: "5000000", userPublicKey: OWNER.toBase58() } } as never,
      res as never,
    );
    expect(res.statusCode).to.equal(200);
    expect(bodies).to.have.length(1);
    expect(bodies[0].wrapAndUnwrapSol).to.equal(false);
  });

  it("mode 'instructions' calls Jupiter's swap-instructions endpoint and returns the raw instruction set + lookup-table addresses + real quote amounts", async () => {
    let buildUrl = "";
    stubJupiter((url) => {
      buildUrl = url;
      return {
        swapInstruction: { programId: SSR, accounts: [], data: "" },
        setupInstructions: [{ programId: USDC, accounts: [], data: "" }],
        cleanupInstruction: null,
        addressLookupTableAddresses: ["9xQQ9UUjuUbKpu2E5Pswf8SsjfmEJVrYMdRwLX7spNvu"],
      };
    });
    const res = new FakeRes();
    await jupiterSwapHandler(
      { method: "POST", headers: { "x-forwarded-for": uniqueIp() }, body: { outputMint: SSR, amountRaw: "5000000", userPublicKey: OWNER.toBase58(), mode: "instructions" } } as never,
      res as never,
    );
    expect(res.statusCode).to.equal(200);
    expect(buildUrl).to.include("swap-instructions");
    const body = res.body as Record<string, unknown>;
    expect(body.swapInstruction).to.be.an("object");
    expect(body.setupInstructions).to.have.length(1);
    expect(body.addressLookupTableAddresses).to.deep.equal(["9xQQ9UUjuUbKpu2E5Pswf8SsjfmEJVrYMdRwLX7spNvu"]);
    expect(body.inAmount).to.equal("5000000");
    expect(body.outAmount).to.equal("50000000");
  });

  it("the default mode still returns a full built transaction (existing launch-flow callers unchanged)", async () => {
    stubJupiter(() => ({ swapTransaction: "dGVzdA==", lastValidBlockHeight: 456 }));
    const res = new FakeRes();
    await jupiterSwapHandler(
      { method: "POST", headers: { "x-forwarded-for": uniqueIp() }, body: { outputMint: SSR, amountRaw: "5000000", userPublicKey: OWNER.toBase58() } } as never,
      res as never,
    );
    expect(res.statusCode).to.equal(200);
    const body = res.body as Record<string, unknown>;
    expect(body.swapTransaction).to.equal("dGVzdA==");
    expect(body.lastValidBlockHeight).to.equal(456);
  });
});
