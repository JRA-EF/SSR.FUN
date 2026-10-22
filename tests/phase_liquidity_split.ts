// DEC-0255: the holder share's backing/pool split. Pins the SDK builders to
// the IDL, the off-chain cap mirror to the program's `pool_feed_allowed`
// (liquidity_split.rs unit tests, tools/rebalance-litesvm/src/split.rs), the
// keeper's pool-leg planner to constant-product math, and the launch form,
// API and keeper wiring.
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildConfigureLiquiditySplit, buildPoolFeedBegin, buildPoolFeedEnd, decodeLiquiditySplit, findLiquiditySplit, findLiquidityTerms,
  findPoolFeedTicket, findPoolLpMint, findSplitLpAccount, poolFeedRoom, LIQUIDITY_SPLIT_SIZE,
} from "@ssr/sdk";
import idl from "../packages/sdk/idl/ssr_protocol.json";
import { planPoolLeg, poolNavDeviationPct, zapSwapAmount, POOL_INPUT_FEE_PPM } from "../lib/mainnet/poolFeed";
import { feeTermsToBps, exampleSplit, DEFAULT_FEE_TERMS } from "../src/merge/lib/liquidity/feeTerms";
import { parseLifecycleRequest } from "../api/mainnet/liquidity";

const PROGRAM = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const k = () => Keypair.generate().publicKey;

describe("DEC-0255 holder share split: builders match the IDL", () => {
  const ix = (name: string) => (idl as any).instructions.find((i: any) => i.name === name);
  const check = (name: string, built: { data: Buffer; keys: { isSigner: boolean; isWritable: boolean }[] }) => {
    const spec = ix(name);
    expect([...built.data.subarray(0, 8)], name).to.deep.equal(spec.discriminator);
    expect(built.keys.length, name).to.equal(spec.accounts.length);
    spec.accounts.forEach((a: any, i: number) => {
      expect(built.keys[i].isSigner, `${name}.${a.name} signer`).to.equal(!!a.signer);
      expect(built.keys[i].isWritable, `${name}.${a.name} writable`).to.equal(!!a.writable);
    });
  };
  const reserve = k(), pool = k(), mint = k(), keeper = k();
  it("configure_liquidity_split: 1-100% of the holder share, the split PDA hangs off the terms", () => {
    const b = buildConfigureLiquiditySplit({ programId: PROGRAM, manager: k(), reserve, poolShareBps: 3_000 });
    check("configure_liquidity_split", b);
    expect(b.data.readUInt16LE(8)).to.equal(3_000);
    expect(b.keys[3].pubkey.equals(findLiquidityTerms(reserve, PROGRAM)) && b.keys[4].pubkey.equals(findLiquiditySplit(reserve, PROGRAM))).to.equal(true);
    expect(findLiquiditySplit(reserve, PROGRAM).equals(PublicKey.findProgramAddressSync([Buffer.from("liquidity_split"), findLiquidityTerms(reserve, PROGRAM).toBuffer()], PROGRAM)[0])).to.equal(true);
    for (const bad of [0, 10_001, 1.5]) expect(() => buildConfigureLiquiditySplit({ programId: PROGRAM, manager: k(), reserve, poolShareBps: bad })).to.throw();
  });
  it("pool_feed_begin and pool_feed_end: ticket, Raydium LP mint and the split's locked accounts", () => {
    const keeperUsdc = k(), keeperReserveToken = k(), keeperLp = k();
    const b = buildPoolFeedBegin({ programId: PROGRAM, reserve, pool, keeper, settlementKeeperConfig: k(), keeperUsdc, keeperReserveToken, keeperLp, amountIn: 5n, minLp: 1n });
    check("pool_feed_begin", b);
    expect(b.keys[0].pubkey.equals(reserve) && b.keys[9].pubkey.equals(findPoolLpMint(pool)) && b.keys[11].pubkey.equals(findPoolFeedTicket(reserve, PROGRAM))).to.equal(true);
    expect([b.data.readBigUInt64LE(8), b.data.readBigUInt64LE(16)]).to.deep.equal([5n, 1n]);
    expect(() => buildPoolFeedBegin({ programId: PROGRAM, reserve, pool, keeper, settlementKeeperConfig: k(), keeperUsdc, keeperReserveToken, keeperLp, amountIn: 5n, minLp: 0n })).to.throw();
    const e = buildPoolFeedEnd({ programId: PROGRAM, reserve, pool, reserveMint: mint, reserveTokenProgram: TOKEN_2022_PROGRAM_ID, keeper, keeperUsdc, keeperReserveToken, keeperLp });
    check("pool_feed_end", e);
    const split = findLiquiditySplit(reserve, PROGRAM);
    expect(e.keys[0].pubkey.equals(reserve), "first account matches begin's sysvar check").to.equal(true);
    expect(e.keys[11].pubkey.equals(findSplitLpAccount(reserve, pool, PROGRAM))).to.equal(true);
    expect(e.keys[13].pubkey.equals(getAssociatedTokenAddressSync(mint, split, true, TOKEN_2022_PROGRAM_ID))).to.equal(true);
  });
  it("LiquiditySplit decodes at the program's layout and the new errors are appended after 6082", () => {
    const account = (idl as any).accounts.find((a: any) => a.name === "LiquiditySplit");
    const data = Buffer.alloc(LIQUIDITY_SPLIT_SIZE);
    Buffer.from(account.discriminator).copy(data);
    const terms = k();
    terms.toBuffer().copy(data, 8);
    data.writeUInt16LE(3_000, 40); data.writeBigUInt64LE(120_000n, 42); data.writeBigUInt64LE(1_090n, 50);
    expect(decodeLiquiditySplit(data)).to.deep.equal({ terms, poolShareBps: 3_000, poolFed: 120_000n, lpLocked: 1_090n });
    expect(() => decodeLiquiditySplit(Buffer.alloc(LIQUIDITY_SPLIT_SIZE))).to.throw();
    const errors = (idl as any).errors.filter((x: any) => x.code >= 6082).map((x: any) => `${x.code} ${x.name}`);
    expect(errors).to.deep.equal(["6082 BasketFeedExceedsReleased", "6083 LiquiditySplitInvalid", "6084 LiquiditySplitNotAtLaunch", "6085 PoolFeedExceedsShare", "6086 PoolFeedEndMissing", "6087 PoolFeedMinimumNotMet"]);
  });
});

describe("DEC-0255 holder share split: the numbers", () => {
  it("pool room mirrors pool_feed_allowed (LiteSVM: 30% of 400,000 released = 120,000, in any order)", () => {
    expect(poolFeedRoom({ poolShareBps: 3_000, poolFed: 0n }, 400_000n)).to.equal(120_000n);
    expect(poolFeedRoom({ poolShareBps: 3_000, poolFed: 110_000n }, 400_000n)).to.equal(10_000n);
    expect(poolFeedRoom({ poolShareBps: 3_000, poolFed: 120_000n }, 400_000n)).to.equal(0n);
    expect(poolFeedRoom({ poolShareBps: 10_000, poolFed: 0n }, 1n)).to.equal(1n);
    // Backing took the pool's part while off NAV: the pool may catch up to its share, never past it.
    expect(poolFeedRoom({ poolShareBps: 3_000, poolFed: 0n }, 10_000n)).to.equal(3_000n);
  });
  it("zap swap: the USDC left and the tokens bought match the pool's ratio after the swap", () => {
    const U = 13_500_000n, T = 1_760_000n, A = 270_000n;
    const s = zapSwapAmount(A, U);
    const net = s * (1_000_000n - POOL_INPUT_FEE_PPM) / 1_000_000n, out = T * net / (U + net);
    const ratioPool = Number(U + s) / Number(T - out), ratioHeld = Number(A - s) / Number(out);
    expect(Math.abs(ratioHeld / ratioPool - 1)).to.be.lessThan(0.002);
    // With the 1% input fee a zap swaps slightly more than half.
    expect(s > A / 2n && s < A / 2n + A / 100n).to.equal(true);
  });
  it("pool leg plan: every bound is what the keeper is sure to hold, the LP ask leaves a margin", () => {
    const fee = { epoch: 0n, maximumFee: 10n ** 15n, transferFeeBasisPoints: 15 };
    const s = { usdc: 13_500_000n, tokens: 1_760_000n, lpSupply: 4_800_000n, fee };
    const p = planPoolLeg(270_000n, s)!;
    expect(p.swapIn + p.maxUsdc).to.equal(270_000n);
    expect(p.maxTokens).to.equal(p.minTokensOut);
    const usdcNeeded = (p.lp * (s.usdc + p.swapIn) + s.lpSupply - 1n) / s.lpSupply;
    expect(usdcNeeded <= p.maxUsdc, "the deposit never asks for more USDC than is left after the swap").to.equal(true);
    expect(Number(usdcNeeded) / Number(p.maxUsdc)).to.be.greaterThan(0.98);
    expect(planPoolLeg(1n, s)).to.equal(null);
    expect(planPoolLeg(270_000n, { ...s, usdc: 0n })).to.equal(null);
  });
  it("NAV guard: deviation of the pool price from backing value, null without a usable NAV", () => {
    expect(poolNavDeviationPct(13_500_000n, 1_760_000n, 1.06)).to.be.closeTo((13.5 / 1.76 / 1.06 - 1) * 100, 1e-9);
    expect(poolNavDeviationPct(1_005_000n, 1_000_000n, 1)).to.be.closeTo(0.5, 1e-9);
    expect(poolNavDeviationPct(1n, 0n, 1)).to.equal(null);
    expect(poolNavDeviationPct(1n, 1n, 0)).to.equal(null);
  });
});

describe("DEC-0255 holder share split: launch form, API and keeper", () => {
  it("the form sends the pool share only when sharing with holders; the example splits the holders' part", () => {
    expect(DEFAULT_FEE_TERMS.poolSharePct).to.equal(0);
    expect(feeTermsToBps({ ...DEFAULT_FEE_TERMS, shareWithHolders: true, holderSharePct: 50, poolSharePct: 30 })).to.deep.include({ holderShareBps: 5_000, poolShareBps: 3_000 });
    expect(feeTermsToBps({ ...DEFAULT_FEE_TERMS, shareWithHolders: false, poolSharePct: 30 }).poolShareBps).to.equal(0);
    const e = exampleSplit(0, { ...DEFAULT_FEE_TERMS, shareWithHolders: true, holderSharePct: 50, poolSharePct: 30 });
    expect(e.backing + e.pool).to.be.closeTo(e.holders, 1e-12);
    expect(e.pool / e.holders).to.be.closeTo(0.3, 1e-12);
  });
  it("the API refuses a pool share without a holder share or outside 0-100%", () => {
    const base = { action: "create", reserve: k().toBase58(), actor: k().toBase58(), maximumSolRaw: "300000000", maximumUsdcRaw: "1000000" };
    expect(parseLifecycleRequest({ ...base, holderShareBps: 5_000, poolShareBps: 3_000 }).poolShareBps).to.equal(3_000);
    expect(parseLifecycleRequest(base).poolShareBps).to.equal(0);
    expect(() => parseLifecycleRequest({ ...base, poolShareBps: 3_000 })).to.throw(/holder share/);
    expect(() => parseLifecycleRequest({ ...base, holderShareBps: 5_000, poolShareBps: 10_001 })).to.throw();
  });
  it("the launch puts the split in the same transaction as the terms, and only once the program has it", () => {
    const cpmm = readFileSync("src/merge/lib/liquidity/raydiumCpmm.ts", "utf8");
    expect(cpmm).to.contain("instructions:[initialize,configure,...split]");
    const create = readFileSync("lib/mainnet/createLiquidity.ts", "utf8");
    expect(create).to.contain("global:configure_liquidity_split");
    expect(create).to.contain("poolShareBps===0||await isLiquiditySplitLive(");
    const form = readFileSync("src/merge/components/LiveLiquidityActions.tsx", "utf8");
    expect(form).to.contain("split=v2&&state.splitAvailable===true");
  });
  it("the keeper runs the pool leg before backing, only within 1% of NAV, and passes prices", () => {
    const feed = readFileSync("lib/mainnet/basketFeed.ts", "utf8");
    expect(feed.indexOf("2a. DEC-0255")).to.be.lessThan(feed.indexOf("planBasketFeedLegs(released, assets)"));
    expect(feed).to.contain("Math.abs(deviation) > POOL_NAV_LIMIT_PCT");
    expect(readFileSync("api/mainnet/fee-settlement-cron.ts", "utf8")).to.contain("prices: fetchJupiterPrices");
  });
});
