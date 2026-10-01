// Server-built, sign-many Buy (2026-09-08 developer directive):
// lib/mainnet/buildBuy.ts's decisions and full build, exercised OFFLINE with
// fakes for the RPC, the program's account reads, and Jupiter -- the
// instruction builders, the funding plan, the fit measurement, and the
// transaction compilation are all real.
import { expect } from "chai";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram, Connection } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildReadOnlyProgram } from "../packages/sdk/src/readOnly";
import { findReserveAsset, findReserveVault } from "../packages/sdk/src/pda";
import {
  BuildBuyError,
  MINT_TX_COMPUTE_UNIT_LIMIT,
  SINGLE_TX_MAX_SWAP_LEGS,
  applyClientAcquired,
  buildBuyTransactions,
  decideBuyMode,
  hypotheticalLookupTable,
  selectSwapActions,
  shouldAttemptSingle,
  type BuildBuyDeps,
} from "../lib/mainnet/buildBuy";
import type { BuyFundingAction } from "../src/merge/lib/multiAssetBuyPlan";
import type { JupiterQuote } from "../lib/mainnet/jupiter";

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLET = Keypair.generate().publicKey;
const RESERVE = Keypair.generate().publicKey;
const RESERVE_TOKEN_MINT = Keypair.generate().publicKey;

describe("buildBuy.ts -- pure decisions", () => {
  it("attempts the one-transaction composition only for small compositions and never for a legs-only / mint-only rebuild", () => {
    expect(shouldAttemptSingle({ swapLegCount: 1, legsOnly: null, mintOnly: false })).to.equal(true);
    expect(shouldAttemptSingle({ swapLegCount: SINGLE_TX_MAX_SWAP_LEGS, legsOnly: null, mintOnly: false })).to.equal(true);
    expect(shouldAttemptSingle({ swapLegCount: SINGLE_TX_MAX_SWAP_LEGS + 1, legsOnly: null, mintOnly: false })).to.equal(false);
    expect(shouldAttemptSingle({ swapLegCount: 1, legsOnly: ["x"], mintOnly: false })).to.equal(false);
    expect(shouldAttemptSingle({ swapLegCount: 1, legsOnly: null, mintOnly: true })).to.equal(false);
  });

  it("selectSwapActions: all deficient legs by default, only the named legs for an auto-retry rebuild, none for a mint-only rebuild", () => {
    const actions: BuyFundingAction[] = [
      { kind: "already-funded", mint: USDC, countableRaw: 1n, requiredRaw: 1n },
      { kind: "jupiter-swap", mint: "A", deficitRaw: 1n, usdcBudgetRaw: 1n, receiveWrappedSol: false },
      { kind: "jupiter-swap", mint: "B", deficitRaw: 1n, usdcBudgetRaw: 1n, receiveWrappedSol: false },
    ];
    expect(selectSwapActions(actions, null, false).map((a) => a.mint)).to.deep.equal(["A", "B"]);
    expect(selectSwapActions(actions, ["B"], false).map((a) => a.mint)).to.deep.equal(["B"]);
    expect(selectSwapActions(actions, null, true)).to.deep.equal([]);
  });

  it("applyClientAcquired overlays the client's persisted per-purchase acquisitions and nothing else", () => {
    const legs = applyClientAcquired(
      [
        { mint: "A", decimals: 6, requiredRaw: 10n, walletHeldRaw: 50n, purchaseAcquiredRaw: 0n, priceUsd: 1 },
        { mint: "B", decimals: 6, requiredRaw: 10n, walletHeldRaw: 50n, purchaseAcquiredRaw: 0n, priceUsd: 1 },
      ],
      { A: 7n },
    );
    expect(legs[0].purchaseAcquiredRaw).to.equal(7n);
    expect(legs[1].purchaseAcquiredRaw).to.equal(0n);
  });

  it("decideBuyMode: single when it fits with existing tables; single + create-table when only a would-be table makes it fit; batch otherwise; a table is never created when one is already registered", () => {
    expect(decideBuyMode({ attemptedSingle: true, singleFitsWithExistingTables: true, singleFitsWithWouldBeTable: true, mintFitsWithExistingTables: true, mintFitsWithWouldBeTable: true, hasRegisteredAlt: false })).to.deep.equal({ mode: "single", createAlt: false });
    expect(decideBuyMode({ attemptedSingle: true, singleFitsWithExistingTables: false, singleFitsWithWouldBeTable: true, mintFitsWithExistingTables: false, mintFitsWithWouldBeTable: true, hasRegisteredAlt: false })).to.deep.equal({ mode: "single", createAlt: true });
    expect(decideBuyMode({ attemptedSingle: true, singleFitsWithExistingTables: false, singleFitsWithWouldBeTable: true, mintFitsWithExistingTables: true, mintFitsWithWouldBeTable: true, hasRegisteredAlt: true })).to.deep.equal({ mode: "batch", createAlt: false });
    expect(decideBuyMode({ attemptedSingle: false, singleFitsWithExistingTables: false, singleFitsWithWouldBeTable: false, mintFitsWithExistingTables: false, mintFitsWithWouldBeTable: true, hasRegisteredAlt: false })).to.deep.equal({ mode: "batch", createAlt: true });
    expect(decideBuyMode({ attemptedSingle: false, singleFitsWithExistingTables: false, singleFitsWithWouldBeTable: false, mintFitsWithExistingTables: false, mintFitsWithWouldBeTable: false, hasRegisteredAlt: false })).to.deep.equal({ mode: "unfit" });
  });

  it("hypotheticalLookupTable is keyed by the would-be address so a compiled transaction references the real table", () => {
    const key = Keypair.generate().publicKey;
    const t = hypotheticalLookupTable(key, [WALLET, RESERVE]);
    expect(t.key.equals(key)).to.equal(true);
    expect(t.isActive()).to.equal(true);
    expect(t.state.addresses).to.have.length(2);
  });
});

// --- Full build with fakes ----------------------------------------------------

function tokenAccountInfo(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 };
}

function dummySwapTx(payer: PublicKey): string {
  const ix = new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message([]);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

interface FakeWorld {
  legs: { mint: PublicKey; decimals: number; vaultRaw: bigint; walletRaw: bigint; price: number }[];
  supplyRaw: bigint;
  walletUsdcRaw: bigint;
  walletSol: number;
  reserveAlt: string | null;
  mintFeeBps: number;
  /** Set to give the fake Reserve a fee destination + metadata (DEC-0198 tax cases). */
  feeDestination?: PublicKey;
}

function makeDeps(world: FakeWorld, spies: { quotes: string[]; builds: string[]; instructionBuilds: string[] }): BuildBuyDeps {
  const connection = new Connection("http://127.0.0.1:1"); // never called: every RPC method used is faked below
  const real = buildReadOnlyProgram(connection) as any;
  const byMint = new Map(world.legs.map((l) => [l.mint.toBase58(), l]));
  const program = {
    programId: PROGRAM_ID,
    methods: real.methods,
    account: {
      reserve: { fetchNullable: async () => ({ reserveTokenMint: RESERVE_TOKEN_MINT, assetCount: world.legs.length, metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef", feeConfig: { mintFeeBps: world.mintFeeBps, feeDestination: world.feeDestination } }) },
      reserveAsset: {
        fetchMultiple: async (pdas: PublicKey[]) =>
          pdas.map((pda) => {
            const leg = world.legs.find((l) => findReserveAsset(RESERVE, l.mint, PROGRAM_ID)[0].equals(pda));
            return leg ? { decimals: leg.decimals, orderIndex: world.legs.indexOf(leg) } : null;
          }),
      },
    },
  };
  const fakeConn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => {
        // The wallet's USDC ATA doubles as the USDC leg's ATA -- answer it first.
        if (getAssociatedTokenAddressSync(new PublicKey(USDC), WALLET).equals(k)) return tokenAccountInfo(new PublicKey(USDC), WALLET, world.walletUsdcRaw);
        for (const l of world.legs) {
          if (findReserveVault(RESERVE, l.mint, PROGRAM_ID)[0].equals(k)) return tokenAccountInfo(l.mint, RESERVE, l.vaultRaw);
          if (getAssociatedTokenAddressSync(l.mint, WALLET).equals(k)) return l.walletRaw > 0n ? tokenAccountInfo(l.mint, WALLET, l.walletRaw) : null;
        }
        return null;
      }),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: world.supplyRaw.toString(), decimals: 6, uiAmount: null, uiAmountString: "0" } }),
    getBalance: async () => world.walletSol,
    getSlot: async () => 123_456,
    getLatestBlockhash: async () => ({ blockhash: "GfVcyD5g4T1yY3aLj7Y5ZQhYjQ1kJ7RkS6oY8cQ8xY7Z", lastValidBlockHeight: 999_999 }),
    getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
  } as unknown as Connection;
  return {
    connection: fakeConn,
    program,
    ssrProgramId: PROGRAM_ID,
    jupiterApiKey: "test-key",
    fetchPrices: async (mints) => new Map(mints.map((m) => [m, { usdPrice: byMint.get(m)?.price ?? null }])),
    jupiterQuote: async (p) => {
      spies.quotes.push(p.outputMint);
      const q: JupiterQuote = { inAmount: p.amount.toString(), outAmount: "1000", priceImpactPct: "0.1", outputMint: p.outputMint };
      return { kind: "ok", value: q };
    },
    jupiterBuildTransaction: async (p) => {
      spies.builds.push(String(p.quote.outputMint));
      return { kind: "ok", value: { swapTransaction: dummySwapTx(WALLET), lastValidBlockHeight: 1 } };
    },
    jupiterBuildInstructions: async (p) => {
      spies.instructionBuilds.push(String(p.quote.outputMint));
      return {
        kind: "ok",
        value: {
          setupInstructions: [],
          swapInstruction: { programId: SystemProgram.programId.toBase58(), accounts: [{ pubkey: WALLET.toBase58(), isSigner: true, isWritable: true }], data: Buffer.from([9]).toString("base64") },
          cleanupInstruction: null,
          addressLookupTableAddresses: [],
        },
      };
    },
    lookupReserveAlt: async () => world.reserveAlt,
  };
}

function world(legCount: number, overrides: Partial<FakeWorld> = {}): FakeWorld {
  const legs = [{ mint: new PublicKey(USDC), decimals: 6, vaultRaw: 1_000_000n, walletRaw: 0n, price: 1 }];
  for (let i = 1; i < legCount; i++) legs.push({ mint: Keypair.generate().publicKey, decimals: 6, vaultRaw: 5_000_000n, walletRaw: 0n, price: 0.5 });
  return { legs, supplyRaw: 10_000_000n, walletUsdcRaw: 50_000_000n, walletSol: 100_000_000, reserveAlt: null, mintFeeBps: 100, ...overrides };
}

const baseInput = (w: FakeWorld) => ({
  reserve: RESERVE,
  wallet: WALLET,
  reserveTokensRequested: 1_000_000n,
  slippageBps: 200,
  assetMints: w.legs.map((l) => l.mint),
  acquiredRawByMint: {},
  legsOnly: null,
  mintOnly: false,
});

describe("buildBuy.ts -- full build (fakes for RPC/program reads/Jupiter; real builders, real fit measurement)", () => {
  it("a 10-asset Reserve with no registered table: quotes EVERY leg in parallel once, skips the single attempt, prepends the table setup, one swap per deficient leg, ONE v0 mint last, all sharing one blockhash", async () => {
    const w = world(10);
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r = await buildBuyTransactions(makeDeps(w, spies), baseInput(w));
    expect(r.mode).to.equal("batch");
    expect(spies.quotes).to.have.length(9); // every non-USDC leg, exactly once
    expect(spies.instructionBuilds).to.have.length(0); // single attempt skipped outright above SINGLE_TX_MAX_SWAP_LEGS
    expect(spies.builds).to.have.length(9);
    const kinds = r.transactions.map((t) => t.kind);
    expect(kinds[0]).to.equal("alt-create");
    expect(kinds.filter((k) => k === "swap")).to.have.length(9);
    expect(kinds[kinds.length - 1]).to.equal("mint");
    expect(r.altToRegister).to.be.a("string");
    for (const t of r.transactions) {
      const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
      expect(tx.message.recentBlockhash).to.equal(r.blockhash);
      expect(t.lastValidBlockHeight).to.equal(r.lastValidBlockHeight);
      expect(t.bytes).to.be.at.most(1232);
    }
    expect(r.plan.legs).to.have.length(10);
    expect(r.plan.legs[0].action).to.equal("already-funded"); // the USDC leg
    expect(r.timings.quotesMs).to.be.a("number");
  });

  it("a 10-asset Reserve WITH a registered table never creates another one (mint compiled against the registered table)", async () => {
    const w = world(10, { reserveAlt: Keypair.generate().publicKey.toBase58() });
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    // The registered table must be readable: fake it with the exact contents the builder expects.
    const deps = makeDeps(w, spies);
    const { buildReserveAltAddresses } = await import("../src/merge/lib/reserveAltClient");
    const { findVaultAuthority } = await import("../packages/sdk/src/pda");
    const addresses = buildReserveAltAddresses({
      ssrProgramId: PROGRAM_ID,
      reserve: RESERVE,
      reserveTokenMint: RESERVE_TOKEN_MINT,
      mintAuthority: PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), RESERVE.toBuffer()], PROGRAM_ID)[0],
      vaultAuthority: findVaultAuthority(RESERVE, PROGRAM_ID)[0],
      protocolFeeDestination: PublicKey.default,
      assets: w.legs.map((l) => ({ mint: l.mint.toBase58(), reserveAsset: findReserveAsset(RESERVE, l.mint, PROGRAM_ID)[0].toBase58(), vault: findReserveVault(RESERVE, l.mint, PROGRAM_ID)[0].toBase58() })),
    });
    (deps.connection as any).getAddressLookupTable = async () => ({ context: { slot: 1 }, value: hypotheticalLookupTable(new PublicKey(w.reserveAlt!), addresses) });
    const r = await buildBuyTransactions(deps, baseInput(w));
    expect(r.mode).to.equal("batch");
    expect(r.transactions.map((t) => t.kind)).to.not.include("alt-create");
    expect(r.altToRegister).to.equal(null);
    expect(r.transactions[r.transactions.length - 1].kind).to.equal("mint");
  });

  it("a small Reserve attempts the single composition (instruction builds, not transaction builds) and returns mode single with ONE transaction when it fits", async () => {
    const w = world(2);
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r = await buildBuyTransactions(makeDeps(w, spies), baseInput(w));
    expect(spies.instructionBuilds).to.have.length(1);
    expect(r.mode).to.equal("single");
    const nonAlt = r.transactions.filter((t) => t.kind !== "alt-create" && t.kind !== "alt-extend");
    expect(nonAlt).to.have.length(1);
    expect(nonAlt[0].kind).to.equal("single");
    expect(spies.builds).to.have.length(0); // no transaction builds were wasted
  });

  it("legsOnly rebuilds exactly those swaps and no mint; mintOnly rebuilds only the mint with no quotes at all", async () => {
    const w = world(10);
    const only = w.legs[3].mint.toBase58();
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r = await buildBuyTransactions(makeDeps(w, spies), { ...baseInput(w), legsOnly: [only] });
    expect(spies.quotes).to.deep.equal([only]);
    expect(r.transactions.filter((t) => t.kind === "swap").map((t) => t.mint)).to.deep.equal([only]);
    expect(r.transactions.map((t) => t.kind)).to.not.include("mint");

    const spies2 = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r2 = await buildBuyTransactions(makeDeps(w, spies2), { ...baseInput(w), mintOnly: true });
    expect(spies2.quotes).to.have.length(0);
    expect(r2.transactions.filter((t) => t.kind === "swap")).to.have.length(0);
    expect(r2.transactions[r2.transactions.length - 1].kind).to.equal("mint");
  });

  it("legs this purchase already acquired (client-reported, still held) are not swapped again -- only the genuine shortfall is", async () => {
    const w = world(4);
    const funded = w.legs[1];
    funded.walletRaw = 10_000_000n; // holds plenty...
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    // ...but only what THIS purchase acquired counts: 10_000_000 acquired covers the requirement.
    const r = await buildBuyTransactions(makeDeps(w, spies), { ...baseInput(w), acquiredRawByMint: { [funded.mint.toBase58()]: 10_000_000n } });
    expect(spies.quotes).to.not.include(funded.mint.toBase58());
    expect(r.plan.legs.find((l) => l.mint === funded.mint.toBase58())!.action).to.equal("already-funded");
    // Same holding, but NOT acquired by this purchase: it is never consumed in place of USDC.
    const spies2 = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    await buildBuyTransactions(makeDeps(w, spies2), baseInput(w));
    expect(spies2.quotes).to.include(funded.mint.toBase58());
  });

  it("refuses (422, nothing built, no quotes) when the wallet cannot fund the plan", async () => {
    const w = world(3, { walletUsdcRaw: 10n });
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    try {
      await buildBuyTransactions(makeDeps(w, spies), baseInput(w));
      expect.fail("expected BuildBuyError");
    } catch (e) {
      expect(e).to.be.instanceOf(BuildBuyError);
      expect((e as BuildBuyError).status).to.equal(422);
      expect((e as BuildBuyError).message).to.include("USDC short");
    }
    expect(spies.quotes).to.have.length(0);
  });

  it("refuses (422) a leg whose quote's price impact exceeds the backstop, naming the asset", async () => {
    const w = world(3);
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const deps = makeDeps(w, spies);
    const bad = w.legs[2].mint.toBase58();
    deps.jupiterQuote = async (p) => ({ kind: "ok", value: { inAmount: "1", outAmount: "1", priceImpactPct: p.outputMint === bad ? "40" : "0.1", outputMint: p.outputMint } });
    try {
      await buildBuyTransactions(deps, baseInput(w));
      expect.fail("expected BuildBuyError");
    } catch (e) {
      expect((e as BuildBuyError).status).to.equal(422);
      expect((e as BuildBuyError).message).to.include(bad);
    }
  });

  it("Buy tax (DEC-0198): with a 1% manager rate the mint transaction ends with [create ATA, transfer] x2 paying 50/50 to the Treasury and the fee destination; a legs-only rebuild carries none; the wallet must cover purchase + tax", async () => {
    const manager = Keypair.generate().publicKey;
    const w = world(10, { feeDestination: manager });
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const deps: BuildBuyDeps = { ...makeDeps(w, spies), lookupTradeTax: async () => ({ buyTaxPct: 1, sellTaxPct: 0 }) };
    const r = await buildBuyTransactions(deps, baseInput(w));
    expect(r.plan.tradeTax).to.not.equal(null);
    expect(r.plan.tradeTax!.taxBps).to.equal(100);
    expect(BigInt(r.plan.tradeTax!.protocolUsdcRaw) + BigInt(r.plan.tradeTax!.managerUsdcRaw)).to.equal(BigInt(r.plan.tradeTax!.taxUsdcRaw));
    expect(BigInt(r.plan.tradeTax!.taxUsdcRaw)).to.equal(BigInt(r.plan.tradeTax!.baseUsdcRaw) / 100n);
    expect(r.plan.tradeTax!.managerDestination).to.equal(manager.toBase58());
    const mint = r.transactions.find((t) => t.kind === "mint")!;
    const tx = VersionedTransaction.deserialize(Buffer.from(mint.base64, "base64"));
    const ixs = tx.message.compiledInstructions;
    const tokenProgram = TOKEN_PROGRAM_ID.toBase58();
    const last4 = ixs.slice(-4).map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? "lut");
    expect(last4[1]).to.equal(tokenProgram);
    expect(last4[3]).to.equal(tokenProgram);
    // A swaps-only rebuild never carries the tax.
    const legs = await buildBuyTransactions(deps, { ...baseInput(w), legsOnly: [w.legs[1].mint.toBase58()] });
    expect(legs.plan.tradeTax).to.equal(null);
    expect(legs.transactions.every((t) => t.kind === "swap" || t.kind === "alt-create" || t.kind === "alt-extend")).to.equal(true);
    // Rate 0 -> no tax, no extra instructions.
    const none = await buildBuyTransactions({ ...deps, lookupTradeTax: async () => ({ buyTaxPct: 0, sellTaxPct: 0 }) }, baseInput(w));
    expect(none.plan.tradeTax).to.equal(null);
    // Wallet that covers the purchase but not purchase + tax -> 422 naming the tax.
    const poor = world(10, { feeDestination: manager, walletUsdcRaw: 0n });
    const poorDeps: BuildBuyDeps = { ...makeDeps(poor, spies), lookupTradeTax: async () => ({ buyTaxPct: 1, sellTaxPct: 0 }) };
    let err: unknown = null;
    try {
      await buildBuyTransactions(poorDeps, { ...baseInput(poor), mintOnly: true });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(BuildBuyError);
    expect((err as Error).message).to.match(/Buy tax/);
  });

  it("the mint transaction carries the compute budget (priority fee) first", async () => {
    const w = world(10);
    const r = await buildBuyTransactions(makeDeps(w, { quotes: [], builds: [], instructionBuilds: [] }), { ...baseInput(w), mintOnly: true });
    const mint = r.transactions.find((t) => t.kind === "mint")!;
    const tx = VersionedTransaction.deserialize(Buffer.from(mint.base64, "base64"));
    const budgetProgram = "ComputeBudget111111111111111111111111111111";
    const first = tx.message.compiledInstructions[0];
    expect(tx.message.staticAccountKeys[first.programIdIndex].toBase58()).to.equal(budgetProgram);
    void MINT_TX_COMPUTE_UNIT_LIMIT;
  });
});
