// DEC-0251: liquidity terms v2 -- SSR takes 20% of the creator's pool
// earnings (fee and Buy/Sell tax); the creator may share part of the rest,
// fixed at launch, with holders through the basket feed (released over 24h,
// swapped by the keeper into the Reserve's assets). These tests pin the
// off-chain mirrors to the program's own numbers (liquidity_terms.rs unit
// tests and tools/rebalance-litesvm/src/feed.rs) and every builder to the IDL.
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  splitCreatorRevenueV2,
  splitProjectTaxV2,
  holderPart,
  releasedBasketFeed,
  decodeLiquidityTerms,
  findLiquidityTerms,
  findLiquidityRevenue,
  findBasketFeed,
  buildConfigureLiquidityRevenueV2,
  buildDistributeLiquidityRevenueV2,
  buildSwapWithProjectTaxV2,
  buildBasketFeedBegin,
  type LiquidityTermsState,
} from "@ssr/sdk";
import idl from "../packages/sdk/idl/ssr_protocol.json";
import { planBasketFeedLegs, LIQUIDITY_TERMS_SIZE } from "../lib/mainnet/basketFeed";
import { feeTermsToBps, exampleSplit, DEFAULT_FEE_TERMS } from "../src/merge/lib/liquidity/feeTerms";
import { parseLifecycleRequest } from "../api/mainnet/liquidity";
import { isLiquidityTermsV2Live } from "../lib/mainnet/createLiquidity";
import { loadLiquidityTables } from "../lib/mainnet/liquidityLookup";

const PROGRAM = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const k = () => Keypair.generate().publicKey;
const terms = (over: Partial<LiquidityTermsState> = {}): LiquidityTermsState => ({
  reserve: k(), revenue: k(), holderShareBps: 5000, locked: 0n, unlocked: 0n, streamEnd: 0n, lastUpdate: 0n, totalFed: 0n, ...over,
});

describe("DEC-0251 liquidity terms v2: splits match the program", () => {
  it("collected creator fee: SSR 20%, then the holder share of the rest (litesvm: 1,000,000 -> 200,000 / 400,000 / 400,000)", () => {
    expect(splitCreatorRevenueV2(1_000_000n, 5000)).to.deep.equal({ protocol: 200_000n, creator: 400_000n, holders: 400_000n, remainder: 0n });
    expect(splitCreatorRevenueV2(1_000_000n, 0)).to.deep.equal({ protocol: 200_000n, creator: 800_000n, holders: 0n, remainder: 0n });
    expect(splitCreatorRevenueV2(1_000_000n, 10_000).creator).to.equal(0n);
  });
  it("many tiny collections never round SSR's 20% away (carry, as in the program)", () => {
    let carry = 0n, protocol = 0n;
    for (let i = 0; i < 10_000; i++) { const s = splitCreatorRevenueV2(1n, 0, carry); protocol += s.protocol; carry = s.remainder; }
    expect(protocol).to.equal(2_000n);
    expect(carry).to.equal(0n);
  });
  it("project tax: rounded up, SSR 20% (gets the rounding), holder share of the creator's 80%", () => {
    expect(splitProjectTaxV2(1_000_000n, 200, 0)).to.deep.equal({ total: 20_000n, protocol: 4_000n, creator: 16_000n, holders: 0n });
    expect(splitProjectTaxV2(1_000_000n, 200, 5000)).to.deep.equal({ total: 20_000n, protocol: 4_000n, creator: 8_000n, holders: 8_000n });
    expect(splitProjectTaxV2(1_000_000n, 0, 5000).total).to.equal(0n);
    for (let n = 0n; n < 1000n; n++) {
      const s = splitProjectTaxV2(n, 100, 3333);
      expect(s.protocol + s.creator + s.holders).to.equal((n + 99n) / 100n);
    }
    expect(() => splitProjectTaxV2(1n, 201, 0)).to.throw();
  });
  it("holder share is bounded to 0-100% of the creator's portion", () => {
    expect(holderPart(3n, 5000)).to.equal(1n);
    expect(() => holderPart(1n, 10_001)).to.throw();
    expect(() => holderPart(1n, -1)).to.throw();
  });
});

describe("DEC-0251 basket feed: 24-hour linear release mirrors LiquidityTerms::sync", () => {
  it("nothing at deposit, 1/24 after an hour, all after 24h (litesvm: 400,000 -> 16,666 after 1h)", () => {
    const deposited = { ...terms(), ...releasedBasketFeed(terms(), 1_000n, 400_000n), lastUpdate: 1_000n };
    expect(deposited.unlocked).to.equal(0n);
    expect(deposited.streamEnd).to.equal(1_000n + 86_400n);
    expect(releasedBasketFeed(deposited, 1_000n + 3_600n, 400_000n).unlocked).to.equal(16_666n);
    expect(releasedBasketFeed(deposited, 1_000n + 86_400n + 5n, 400_000n)).to.include({ locked: 0n, unlocked: 400_000n });
  });
  it("a new deposit spreads with the remaining lock over a fresh 24h window", () => {
    const t = terms({ locked: 43_200n, unlocked: 0n, streamEnd: 86_400n, lastUpdate: 43_200n });
    const r = releasedBasketFeed(t, 43_200n, 86_400n);
    expect(r).to.deep.equal({ locked: 86_400n, unlocked: 0n, streamEnd: 43_200n + 86_400n });
  });
  it("never releases more than the feed holds", () => {
    const r = releasedBasketFeed(terms({ locked: 0n, unlocked: 1_000n, lastUpdate: 10n }), 20n, 400n);
    expect(r.unlocked + r.locked <= 400n).to.equal(true);
  });
  it("decodes the on-chain account layout (115 bytes)", () => {
    const reserve = k(), revenue = k(), b = Buffer.alloc(LIQUIDITY_TERMS_SIZE);
    Buffer.from([4, 203, 181, 73, 116, 168, 168, 255]).copy(b, 0);
    reserve.toBuffer().copy(b, 8); revenue.toBuffer().copy(b, 40);
    b.writeUInt16LE(2500, 72); b.writeBigUInt64LE(7n, 74); b.writeBigUInt64LE(8n, 82); b.writeBigInt64LE(9n, 90); b.writeBigInt64LE(10n, 98); b.writeBigUInt64LE(11n, 106);
    const d = decodeLiquidityTerms(b);
    expect(d.reserve.equals(reserve) && d.revenue.equals(revenue)).to.equal(true);
    expect([d.holderShareBps, d.locked, d.unlocked, d.streamEnd, d.lastUpdate, d.totalFed]).to.deep.equal([2500, 7n, 8n, 9n, 10n, 11n]);
    const account = (idl as any).accounts.find((a: any) => a.name === "LiquidityTerms");
    expect(account.discriminator).to.deep.equal([4, 203, 181, 73, 116, 168, 168, 255]);
    b[0] ^= 1;
    expect(() => decodeLiquidityTerms(b)).to.throw();
  });
  it("PDAs: terms seeded by the revenue router, feed is the terms' USDC ATA", () => {
    const reserve = k();
    const revenue = findLiquidityRevenue(reserve, PROGRAM);
    expect(findLiquidityTerms(reserve, PROGRAM).equals(PublicKey.findProgramAddressSync([Buffer.from("liquidity_terms"), revenue.toBuffer()], PROGRAM)[0])).to.equal(true);
    expect(PublicKey.isOnCurve(findBasketFeed(reserve, PROGRAM).toBytes())).to.equal(false);
  });
});

describe("DEC-0251 builders match the IDL account order, signer and writable flags", () => {
  const ix = (name: string) => (idl as any).instructions.find((i: any) => i.name === name);
  const check = (name: string, built: { data: Buffer; keys: { isSigner: boolean; isWritable: boolean }[] }, extra = 0) => {
    const spec = ix(name);
    expect([...built.data.subarray(0, 8)], name).to.deep.equal(spec.discriminator);
    expect(built.keys.length, name).to.equal(spec.accounts.length + extra);
    spec.accounts.forEach((a: any, i: number) => {
      expect(built.keys[i].isSigner, `${name}.${a.name} signer`).to.equal(!!a.signer);
      expect(built.keys[i].isWritable, `${name}.${a.name} writable`).to.equal(!!a.writable);
    });
  };
  const reserve = k();
  it("configure_liquidity_revenue_v2", () => {
    const b = buildConfigureLiquidityRevenueV2({ programId: PROGRAM, manager: k(), protocolConfig: k(), reserve, pool: k(), ammConfig: k(), creatorFeeShare: k(), buyTaxBps: 100, sellTaxBps: 200, holderShareBps: 10_000 });
    check("configure_liquidity_revenue_v2", b);
    expect([b.data.readUInt16LE(8), b.data.readUInt16LE(10), b.data.readUInt16LE(12)]).to.deep.equal([100, 200, 10_000]);
    expect(b.keys[4].pubkey.equals(findLiquidityTerms(reserve, PROGRAM)) && b.keys[5].pubkey.equals(findBasketFeed(reserve, PROGRAM))).to.equal(true);
    expect(() => buildConfigureLiquidityRevenueV2({ programId: PROGRAM, manager: k(), protocolConfig: k(), reserve, pool: k(), ammConfig: k(), creatorFeeShare: k(), buyTaxBps: 0, sellTaxBps: 0, holderShareBps: 10_001 })).to.throw();
  });
  it("distribute_liquidity_revenue_v2", () => {
    check("distribute_liquidity_revenue_v2", buildDistributeLiquidityRevenueV2({ programId: PROGRAM, protocolConfig: k(), reserve, staging: k(), protocolDestination: k(), creatorDestination: k(), ammConfig: k(), creatorFeeShare: k() }));
  });
  it("swap_with_project_tax_v2 (+13 native Raydium accounts)", () => {
    const native = Array.from({ length: 13 }, () => ({ pubkey: k(), isSigner: false, isWritable: false }));
    check("swap_with_project_tax_v2", buildSwapWithProjectTaxV2({ programId: PROGRAM, user: k(), protocolConfig: k(), reserve, userUsdc: k(), protocolDestination: k(), creatorDestination: k(), raydiumProgram: k(), nativeSwapAccounts: native, buy: true, amountIn: 1n, minimumNetOut: 1n }), 13);
  });
  it("basket_feed_begin", () => {
    check("basket_feed_begin", buildBasketFeedBegin({ programId: PROGRAM, reserve, keeper: k(), settlementKeeperConfig: k(), keeperUsdc: k(), reserveAssetBuy: k(), vaultBuy: k(), mintBuy: k(), keeperBuyAccount: k(), ticket: k(), amountIn: 5n, minOut: 4n }));
    expect(() => buildBasketFeedBegin({ programId: PROGRAM, reserve, keeper: k(), settlementKeeperConfig: k(), keeperUsdc: k(), reserveAssetBuy: k(), vaultBuy: k(), mintBuy: k(), keeperBuyAccount: k(), ticket: k(), amountIn: 0n, minOut: 4n })).to.throw();
  });
});

describe("DEC-0251 keeper leg planning", () => {
  const assets = [
    { mint: "A", targetWeightBps: 5000, tokenProgram: "t" },
    { mint: "B", targetWeightBps: 3000, tokenProgram: "t" },
    { mint: "C", targetWeightBps: 2000, tokenProgram: "t" },
    { mint: "Z", targetWeightBps: 0, tokenProgram: "t" },
  ];
  it("splits by target weight, remainder to the heaviest, never more than released", () => {
    const legs = planBasketFeedLegs(1_000_001n, assets, 1n);
    expect(legs).to.deep.equal([{ mint: "A", amount: 500_001n }, { mint: "B", amount: 300_000n }, { mint: "C", amount: 200_000n }]);
    expect(legs.reduce((s, l) => s + l.amount, 0n)).to.equal(1_000_001n);
  });
  it("drops legs under the minimum and zero-weight assets; nothing for nothing", () => {
    expect(planBasketFeedLegs(1_000_000n, assets, 250_000n).map((l) => l.mint)).to.deep.equal(["A", "B"]);
    expect(planBasketFeedLegs(0n, assets)).to.deep.equal([]);
    expect(planBasketFeedLegs(1_000_000n, [{ mint: "Z", targetWeightBps: 0, tokenProgram: "t" }])).to.deep.equal([]);
  });
});

describe("DEC-0251 chain probe: v2 switches on when the upgrade executes", () => {
  const sim = (err: unknown) => ({ simulateTransaction: async () => ({ value: { err } }) }) as any;
  it("unknown instruction (custom 101) means the program predates v2", async () => {
    expect(await isLiquidityTermsV2Live(sim({ InstructionError: [0, { Custom: 101 }] }), k(), PROGRAM)).to.equal(false);
  });
  it("any other answer (account errors) means the instruction exists", async () => {
    expect(await isLiquidityTermsV2Live(sim({ InstructionError: [0, { Custom: 3005 }] }), k(), PROGRAM)).to.equal(true);
    expect(await isLiquidityTermsV2Live(sim({ InstructionError: [0, { Custom: 1010 }] }), k(), PROGRAM)).to.equal(true);
  });
});

describe("Liquidity lookup tables: a saved table that was never created", () => {
  it("is skipped instead of blocking the review (its setup transaction expired before landing)", async () => {
    const connection = { getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 100 }, value: [null] }) } as any;
    expect(await loadLiquidityTables(connection, k(), [k()])).to.deep.equal([]);
  });
  it("still refuses an address that exists but is not a lookup table", async () => {
    const connection = { getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 100 }, value: [{ owner: k(), data: Buffer.alloc(0) }] }) } as any;
    let error = "";
    try { await loadLiquidityTables(connection, k(), [k()]); } catch (e) { error = String(e); }
    expect(error).to.include("Liquidity lookup table unavailable");
  });
});

describe("DEC-0251 liquidity launch inputs", () => {
  it("the launch form sends a zero holder share unless the creator opts in", () => {
    expect(feeTermsToBps(DEFAULT_FEE_TERMS)).to.deep.equal({ buyTaxBps: 0, sellTaxBps: 0, holderShareBps: 0 });
    expect(feeTermsToBps({ buyTaxPct: 1.25, sellTaxPct: 2, shareWithHolders: true, holderSharePct: 50 })).to.deep.equal({ buyTaxBps: 125, sellTaxBps: 200, holderShareBps: 5000 });
  });
  it("the per-$1,000 example adds up to what the creator earns, SSR exactly 20%", () => {
    const s = exampleSplit(1, { ...DEFAULT_FEE_TERMS, shareWithHolders: true, holderSharePct: 50 });
    const earned = 1000 * (0.75 * 0.95 + 1) / 100;
    expect(s.ssr + s.creator + s.holders).to.be.closeTo(earned, 1e-9);
    expect(s.ssr).to.be.closeTo(earned * 0.2, 1e-9);
    expect(s.holders).to.be.closeTo(s.creator, 1e-9);
  });
  it("the API accepts a 0-100% holder share and rejects anything else", () => {
    const body = { action: "create", reserve: k().toBase58(), actor: k().toBase58(), maximumSolRaw: "50000000", maximumUsdcRaw: "1000000", lock: "unlocked", slippageBps: 50 };
    expect(parseLifecycleRequest(body).holderShareBps).to.equal(0);
    expect(parseLifecycleRequest({ ...body, holderShareBps: 10_000 }).holderShareBps).to.equal(10_000);
    for (const bad of [-1, 10_001, 12.5, "5000"]) expect(() => parseLifecycleRequest({ ...body, holderShareBps: bad })).to.throw();
  });
});
