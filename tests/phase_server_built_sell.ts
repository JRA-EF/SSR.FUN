// Server-built, sign-many Sell: lib/mainnet/buildSell.ts's decisions and
// full build, exercised OFFLINE with fakes for the RPC, the program's
// account reads, and Jupiter -- the redeem builder, entitlement math, fit
// measurement, and compilation are all real.
import { expect } from "chai";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram, Connection } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildReadOnlyProgram } from "../packages/sdk/src/readOnly";
import { findReserveAsset, findReserveVault } from "../packages/sdk/src/pda";
import { computeRedemptionEntitlements } from "../packages/sdk/src/calculations";
import { buildSellTransactions, planSellLegs, shouldAttemptSingleSell, type BuildSellDeps } from "../lib/mainnet/buildSell";
import { BuildError } from "../lib/mainnet/buildCommon";
import type { JupiterQuote } from "../lib/mainnet/jupiter";

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLET = Keypair.generate().publicKey;
const RESERVE = Keypair.generate().publicKey;
const RESERVE_TOKEN_MINT = Keypair.generate().publicKey;

describe("buildSell.ts -- pure decisions", () => {
  it("planSellLegs: before the redeem lands each swap sells the exact entitlement; after it, min(held, entitlement); USDC is never swapped; legsOnly narrows to the named legs", () => {
    const legs = [
      { mint: USDC, entitlementRaw: 100n, walletHeldRaw: 0n },
      { mint: "A", entitlementRaw: 500n, walletHeldRaw: 0n },
      { mint: "B", entitlementRaw: 700n, walletHeldRaw: 300n },
    ];
    expect(planSellLegs(legs, false, null).map((l) => [l.mint, l.action, l.amountInRaw])).to.deep.equal([[USDC, "usdc", 0n], ["A", "swap", 500n], ["B", "swap", 700n]]);
    expect(planSellLegs(legs, true, null).map((l) => [l.mint, l.action, l.amountInRaw])).to.deep.equal([[USDC, "usdc", 0n], ["A", "skip", 0n], ["B", "swap", 300n]]);
    expect(planSellLegs(legs, false, ["B"]).map((l) => l.action)).to.deep.equal(["usdc", "skip", "swap"]);
  });

  it("the single composition is attempted only for a fresh sale with few legs", () => {
    expect(shouldAttemptSingleSell({ swapLegCount: 2, legsOnly: null, redeemDone: false })).to.equal(true);
    expect(shouldAttemptSingleSell({ swapLegCount: 9, legsOnly: null, redeemDone: false })).to.equal(false);
    expect(shouldAttemptSingleSell({ swapLegCount: 1, legsOnly: null, redeemDone: true })).to.equal(false);
    expect(shouldAttemptSingleSell({ swapLegCount: 1, legsOnly: ["x"], redeemDone: false })).to.equal(false);
  });
});

function tokenAccountInfo(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { data, executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 };
}

function dummySwapTx(payer: PublicKey): string {
  const ix = new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message([]);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

interface World {
  legs: { mint: PublicKey; decimals: number; vaultRaw: bigint; walletRaw: bigint }[];
  supplyRaw: bigint;
  walletRtRaw: bigint;
  redemptionFeeBps: number;
  feeDestination?: PublicKey;
}

function world(legCount: number, overrides: Partial<World> = {}): World {
  const legs = [{ mint: new PublicKey(USDC), decimals: 6, vaultRaw: 1_000_000n, walletRaw: 0n }];
  for (let i = 1; i < legCount; i++) legs.push({ mint: Keypair.generate().publicKey, decimals: 6, vaultRaw: 5_000_000n, walletRaw: 0n });
  return { legs, supplyRaw: 10_000_000n, walletRtRaw: 2_000_000n, redemptionFeeBps: 50, ...overrides };
}

function makeDeps(w: World, spies: { quotes: string[]; builds: string[]; instructionBuilds: string[] }): BuildSellDeps {
  const real = buildReadOnlyProgram(new Connection("http://127.0.0.1:1")) as any;
  const program = {
    programId: PROGRAM_ID,
    methods: real.methods,
    account: {
      reserve: { fetchNullable: async () => ({ reserveTokenMint: RESERVE_TOKEN_MINT, assetCount: w.legs.length, metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef", feeConfig: { mintFeeBps: 100, redemptionFeeBps: w.redemptionFeeBps, feeDestination: w.feeDestination } }) },
      reserveAsset: {
        fetchMultiple: async (pdas: PublicKey[]) =>
          pdas.map((pda) => {
            const leg = w.legs.find((l) => findReserveAsset(RESERVE, l.mint, PROGRAM_ID)[0].equals(pda));
            return leg ? { decimals: leg.decimals, orderIndex: w.legs.indexOf(leg) } : null;
          }),
      },
    },
  };
  const fakeConn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => {
        if (getAssociatedTokenAddressSync(RESERVE_TOKEN_MINT, WALLET).equals(k)) return tokenAccountInfo(RESERVE_TOKEN_MINT, WALLET, w.walletRtRaw);
        if (getAssociatedTokenAddressSync(new PublicKey(USDC), WALLET).equals(k)) return tokenAccountInfo(new PublicKey(USDC), WALLET, 0n);
        for (const l of w.legs) {
          if (findReserveVault(RESERVE, l.mint, PROGRAM_ID)[0].equals(k)) return tokenAccountInfo(l.mint, RESERVE, l.vaultRaw);
          if (getAssociatedTokenAddressSync(l.mint, WALLET).equals(k)) return l.walletRaw > 0n ? tokenAccountInfo(l.mint, WALLET, l.walletRaw) : null;
        }
        return null;
      }),
    getTokenSupply: async () => ({ context: { slot: 1 }, value: { amount: w.supplyRaw.toString(), decimals: 6, uiAmount: null, uiAmountString: "0" } }),
    getBalance: async () => 100_000_000,
    getSlot: async () => 123_456,
    getLatestBlockhash: async () => ({ blockhash: "GfVcyD5g4T1yY3aLj7Y5ZQhYjQ1kJ7RkS6oY8cQ8xY7Z", lastValidBlockHeight: 999_999 }),
    getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
  } as unknown as Connection;
  return {
    connection: fakeConn,
    program,
    ssrProgramId: PROGRAM_ID,
    jupiterApiKey: "test-key",
    jupiterQuote: async (p) => {
      spies.quotes.push(`${p.inputMint}>${p.outputMint}:${p.amount}`);
      const q: JupiterQuote = { inAmount: p.amount.toString(), outAmount: "12345", priceImpactPct: "0.1", outputMint: p.outputMint };
      return { kind: "ok", value: q };
    },
    jupiterBuildTransaction: async (p) => {
      spies.builds.push(String(p.quote.inAmount));
      return { kind: "ok", value: { swapTransaction: dummySwapTx(WALLET), lastValidBlockHeight: 1 } };
    },
    jupiterBuildInstructions: async (p) => {
      spies.instructionBuilds.push(String(p.quote.inAmount));
      return { kind: "ok", value: { setupInstructions: [], swapInstruction: { programId: SystemProgram.programId.toBase58(), accounts: [{ pubkey: WALLET.toBase58(), isSigner: true, isWritable: true }], data: Buffer.from([9]).toString("base64") }, cleanupInstruction: null, addressLookupTableAddresses: [] } };
    },
    lookupReserveAlt: async () => null,
  };
}

const input = (w: World, extra: Partial<Parameters<typeof buildSellTransactions>[1]> = {}) => ({
  reserve: RESERVE,
  wallet: WALLET,
  reserveTokensToRedeem: 1_000_000n,
  slippageBps: 150,
  assetMints: w.legs.map((l) => l.mint),
  legsOnly: null,
  redeemDone: false,
  taxOnly: null,
  ...extra,
});

describe("buildSell.ts -- full build (fakes for RPC/program reads/Jupiter; real redeem builder, entitlement math, fit measurement)", () => {
  it("a 10-asset Reserve: every non-USDC leg quoted once for EXACTLY its entitlement, no single attempt, table prepended, [redeem, swap x9], one shared blockhash", async () => {
    const w = world(10);
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r = await buildSellTransactions(makeDeps(w, spies), input(w));
    expect(r.mode).to.equal("batch");
    expect(spies.instructionBuilds).to.have.length(0);
    expect(spies.quotes).to.have.length(9);
    const expected = computeRedemptionEntitlements(1_000_000n, BigInt(w.redemptionFeeBps), w.supplyRaw, w.legs.map((l) => ({ mint: l.mint.toBase58(), vaultBalance: l.vaultRaw })));
    for (let i = 1; i < 10; i++) expect(spies.quotes).to.include(`${w.legs[i].mint.toBase58()}>${USDC}:${expected[i].entitlement}`);
    const kinds = r.transactions.map((t) => t.kind);
    expect(kinds[0]).to.equal("alt-create");
    expect(kinds.indexOf("redeem")).to.be.greaterThan(0);
    expect(kinds.indexOf("redeem")).to.be.lessThan(kinds.indexOf("swap"));
    expect(kinds.filter((k) => k === "swap")).to.have.length(9);
    for (const t of r.transactions) {
      const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));
      expect(tx.message.recentBlockhash).to.equal(r.blockhash);
      expect(t.bytes).to.be.at.most(1232);
    }
    expect(r.plan.entitlementsRaw).to.deep.equal(expected.map((e) => e.entitlement.toString()));
  });

  it("a small Reserve attempts the single composition and returns ONE transaction when it fits", async () => {
    const w = world(2);
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r = await buildSellTransactions(makeDeps(w, spies), input(w));
    expect(spies.instructionBuilds).to.have.length(1);
    expect(r.mode).to.equal("single");
    expect(r.transactions.filter((t) => t.kind === "single")).to.have.length(1);
    expect(r.transactions.map((t) => t.kind)).to.not.include("redeem");
  });

  it("redeemDone (resume): no redeem transaction, no table, swaps sell what the wallet actually holds (never more than the entitlement), and legsOnly narrows the rebuild", async () => {
    const w = world(4);
    w.legs[1].walletRaw = 10n; // holds a little of leg 1
    w.legs[2].walletRaw = 1_000_000_000n; // holds far more than the entitlement of leg 2
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r = await buildSellTransactions(makeDeps(w, spies), input(w, { redeemDone: true }));
    expect(r.transactions.map((t) => t.kind)).to.not.include("redeem");
    expect(r.transactions.map((t) => t.kind)).to.not.include("alt-create");
    const expected = computeRedemptionEntitlements(1_000_000n, BigInt(w.redemptionFeeBps), w.supplyRaw, w.legs.map((l) => ({ mint: l.mint.toBase58(), vaultBalance: l.vaultRaw })));
    expect(spies.quotes).to.include(`${w.legs[1].mint.toBase58()}>${USDC}:10`);
    expect(spies.quotes).to.include(`${w.legs[2].mint.toBase58()}>${USDC}:${expected[2].entitlement}`);
    expect(spies.quotes).to.have.length(2); // leg 3 holds nothing -> skipped
    const spies2 = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const r2 = await buildSellTransactions(makeDeps(w, spies2), input(w, { redeemDone: true, legsOnly: [w.legs[2].mint.toBase58()] }));
    expect(r2.transactions.map((t) => t.mint)).to.deep.equal([w.legs[2].mint.toBase58()]);
  });

  it("Sell tax (DEC-0198): batch mode appends ONE 'tax' transaction last, on the swaps' minimum out + the USDC entitlement; single mode folds the transfers in; legsOnly carries none; taxOnly rebuilds just the tax on the given base", async () => {
    const manager = Keypair.generate().publicKey;
    const w = world(10, { feeDestination: manager });
    const spies = { quotes: [] as string[], builds: [] as string[], instructionBuilds: [] as string[] };
    const deps: BuildSellDeps = { ...makeDeps(w, spies), lookupTradeTax: async () => ({ buyTaxPct: 0, sellTaxPct: 1 }) };
    const r = await buildSellTransactions(deps, input(w));
    expect(r.mode).to.equal("batch");
    expect(r.transactions[r.transactions.length - 1].kind).to.equal("tax");
    expect(r.transactions.filter((t) => t.kind === "tax")).to.have.length(1);
    const swaps = r.plan.legs.filter((l) => l.action === "swap").length;
    const usdcEntitlement = BigInt(r.plan.entitlementsRaw[0]);
    const expectedBase = BigInt(swaps) * ((12_345n * (10_000n - 150n)) / 10_000n) + usdcEntitlement;
    expect(BigInt(r.plan.tradeTax!.baseUsdcRaw)).to.equal(expectedBase);
    expect(BigInt(r.plan.tradeTax!.taxUsdcRaw)).to.equal(expectedBase / 100n);
    const taxTx = VersionedTransaction.deserialize(Buffer.from(r.transactions[r.transactions.length - 1].base64, "base64"));
    expect(taxTx.message.compiledInstructions).to.have.length(2 + 4); // budget x2 + [ATA, transfer] x2
    // single mode: transfers folded into the one transaction, no separate tax tx.
    const small = world(2, { feeDestination: manager });
    const single = await buildSellTransactions({ ...makeDeps(small, spies), lookupTradeTax: async () => ({ buyTaxPct: 0, sellTaxPct: 1 }) }, input(small));
    expect(single.mode).to.equal("single");
    expect(single.transactions.some((t) => t.kind === "tax")).to.equal(false);
    expect(single.plan.tradeTax).to.not.equal(null);
    // legsOnly: no tax.
    const legs = await buildSellTransactions(deps, input(w, { redeemDone: true, legsOnly: [w.legs[1].mint.toBase58()] }));
    expect(legs.plan.tradeTax).to.equal(null);
    expect(legs.transactions.some((t) => t.kind === "tax")).to.equal(false);
    // taxOnly: exactly one tax transaction on the persisted base, no quotes.
    const before = spies.quotes.length;
    const only = await buildSellTransactions(deps, input(w, { redeemDone: true, taxOnly: { baseUsdcRaw: 5_000_000n } }));
    expect(spies.quotes.length).to.equal(before);
    expect(only.transactions.map((t) => t.kind)).to.deep.equal(["tax"]);
    expect(only.plan.tradeTax!.taxUsdcRaw).to.equal("50000");
    // Rate 0 -> nothing.
    const none = await buildSellTransactions({ ...deps, lookupTradeTax: async () => ({ buyTaxPct: 0, sellTaxPct: 0 }) }, input(w));
    expect(none.plan.tradeTax).to.equal(null);
    expect(none.transactions.some((t) => t.kind === "tax")).to.equal(false);
  });

  it("refuses (422) when the wallet holds fewer Reserve Tokens than the sale", async () => {
    const w = world(3, { walletRtRaw: 5n });
    try {
      await buildSellTransactions(makeDeps(w, { quotes: [], builds: [], instructionBuilds: [] }), input(w));
      expect.fail("expected BuildError");
    } catch (e) {
      expect(e).to.be.instanceOf(BuildError);
      expect((e as BuildError).status).to.equal(422);
    }
  });
});
