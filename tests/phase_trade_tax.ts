// DEC-0257: the creator's trade tax carried by the Reserve Token's transfer
// fee. Pins the SDK builders to the IDL, the split mirror to the program's
// `trade_tax_split` (trade_tax.rs unit tests, tools/rebalance-litesvm/src/
// tradetax.rs), the launch transaction (enable after the terms) and the
// keeper/API/launch-form wiring.
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildCollectTradeTax, buildEnableTradeTax, decodeTradeTax, findLiquidityRevenue, findLiquidityTerms, findReserveTokenMint,
  findTradeTax, splitTradeTax, MAX_TRADE_TAX_HARVEST_SOURCES, TRADE_TAX_SIZE,
} from "@ssr/sdk";
import idl from "../packages/sdk/idl/ssr_protocol.json";
import { isTradeTaxLive } from "../lib/mainnet/createLiquidity";

const PROGRAM = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const k = () => Keypair.generate().publicKey;

describe("DEC-0257 trade tax: builders match the IDL", () => {
  const ix = (name: string) => (idl as any).instructions.find((i: any) => i.name === name);
  const check = (name: string, built: { data: Buffer; keys: { isSigner: boolean; isWritable: boolean }[] }, fixed: number) => {
    const spec = ix(name);
    expect([...built.data.subarray(0, 8)], name).to.deep.equal(spec.discriminator);
    expect(spec.accounts.length, name).to.equal(fixed);
    spec.accounts.forEach((a: any, i: number) => {
      expect(built.keys[i].isSigner, `${name}.${a.name} signer`).to.equal(!!a.signer);
      expect(built.keys[i].isWritable, `${name}.${a.name} writable`).to.equal(!!a.writable);
    });
  };
  const reserve = k();
  it("enable_trade_tax: manager-signed, writes the revenue (wrapper rates zeroed), the TradeTax PDA and the mint", () => {
    const b = buildEnableTradeTax({ programId: PROGRAM, manager: k(), reserve });
    check("enable_trade_tax", b, 11);
    expect(b.keys.length).to.equal(11);
    expect(b.keys[3].pubkey.equals(findLiquidityRevenue(reserve, PROGRAM)) && b.keys[4].pubkey.equals(findLiquidityTerms(reserve, PROGRAM))).to.equal(true);
    expect(b.keys[5].pubkey.equals(findTradeTax(reserve, PROGRAM))).to.equal(true);
    expect(findTradeTax(reserve, PROGRAM).equals(PublicKey.findProgramAddressSync([Buffer.from("trade_tax"), reserve.toBuffer()], PROGRAM)[0])).to.equal(true);
    expect(b.keys[6].pubkey.equals(findReserveTokenMint(reserve, PROGRAM)[0])).to.equal(true);
  });
  it("collect_trade_tax: fixed treasuries' Token-2022 ATAs, then the harvest sources", () => {
    const protocolTreasury = k(), creatorTreasury = k(), sources = [k(), k()];
    const b = buildCollectTradeTax({ programId: PROGRAM, reserve, protocolTreasury, creatorTreasury, payer: k(), harvestSources: sources });
    check("collect_trade_tax", b, 14);
    const mint = findReserveTokenMint(reserve, PROGRAM)[0];
    const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true, TOKEN_2022_PROGRAM_ID);
    expect(b.keys[5].pubkey.equals(ata(findTradeTax(reserve, PROGRAM))), "staging").to.equal(true);
    expect(b.keys[7].pubkey.equals(ata(protocolTreasury)) && b.keys[9].pubkey.equals(ata(creatorTreasury))).to.equal(true);
    expect(b.keys.slice(14).map((x) => x.pubkey.toBase58())).to.deep.equal(sources.map((s) => s.toBase58()));
    expect(b.keys.slice(14).every((x) => x.isWritable && !x.isSigner)).to.equal(true);
    expect(() => buildCollectTradeTax({ programId: PROGRAM, reserve, protocolTreasury, creatorTreasury, payer: k(), harvestSources: Array.from({ length: MAX_TRADE_TAX_HARVEST_SOURCES + 1 }, k) })).to.throw();
  });
  it("TradeTax decodes at the program's layout; errors 6088-6090 appended after DEC-0255's", () => {
    const account = (idl as any).accounts.find((a: any) => a.name === "TradeTax");
    const data = Buffer.alloc(TRADE_TAX_SIZE);
    Buffer.from(account.discriminator).copy(data);
    const [r, rev, t] = [k(), k(), k()];
    r.toBuffer().copy(data, 8); rev.toBuffer().copy(data, 40); t.toBuffer().copy(data, 72);
    data.writeUInt16LE(100, 104); data.writeUInt16LE(15, 106); data.writeUInt16LE(5_000, 108);
    data.writeBigUInt64LE(3_500n, 110); data.writeBigUInt64LE(4_000n, 118); data.writeBigUInt64LE(4_000n, 126);
    const d = decodeTradeTax(data);
    expect([d.reserve.equals(r), d.revenue.equals(rev), d.treasury.equals(t)]).to.deep.equal([true, true, true]);
    expect([d.taxBps, d.protocolBps, d.holderShareBps, d.totalProtocol, d.totalCreator, d.totalBurned]).to.deep.equal([100, 15, 5_000, 3_500n, 4_000n, 4_000n]);
    const errors = (idl as any).errors.filter((e: any) => e.code >= 6088).map((e: any) => [e.code, e.name]);
    expect(errors).to.deep.equal([[6088, "TradeTaxInvalid"], [6089, "TradeTaxNotAtLaunch"], [6090, "TradeTaxActive"]]);
  });
});

describe("DEC-0257 trade tax: split mirrors trade_tax_split", () => {
  it("before the tax takes effect everything is protocol fee", () => {
    expect(splitTradeTax(10_000n, 15, 15, 5_000)).to.deep.equal({ protocol: 10_000n, creator: 0n, burned: 0n });
  });
  it("1.15%: SSR 0.15% + 20% of the tax, creator 80%, holder share of it burned", () => {
    expect(splitTradeTax(115_000n, 115, 15, 0)).to.deep.equal({ protocol: 35_000n, creator: 80_000n, burned: 0n });
    expect(splitTradeTax(115_000n, 115, 15, 2_000)).to.deep.equal({ protocol: 35_000n, creator: 64_000n, burned: 16_000n });
    // LiteSVM run: 11,500 withheld with a 50% holder share.
    expect(splitTradeTax(11_500n, 115, 15, 5_000)).to.deep.equal({ protocol: 3_500n, creator: 4_000n, burned: 4_000n });
  });
  it("conserves every unit", () => {
    for (const w of [1n, 7n, 999n, 1_234_567n, 6_148_914_691_236_517_205n]) for (const [fee, hs] of [[215, 10_000], [115, 3_333], [16, 1]]) {
      const s = splitTradeTax(w, fee, 15, hs);
      expect(s.protocol + s.creator + s.burned).to.equal(w);
    }
  });
});

describe("DEC-0257 trade tax: launch, keeper and UI wiring", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("the launch puts enable_trade_tax after the terms, only once the program has it, at the larger side's rate", () => {
    const pool = src("src/merge/lib/liquidity/raydiumCpmm.ts");
    expect(pool).to.match(/instructions:\[initialize,configure,\.\.\.split,\.\.\.tradeTax\]/);
    const create = src("lib/mainnet/createLiquidity.ts");
    expect(create).to.match(/const tradeTax=termsV2&&Math\.max\(p\.buyTaxBps,p\.sellTaxBps\)>0&&await isTradeTaxLive/);
    expect(create).to.match(/termsV2,poolShareBps,tradeTax\}\)/);
    expect(src("lib/mainnet/atomicPool.ts")).to.match(/tradeTax\?:boolean;\}/);
  });
  it("probes the deployed program like the other launch features (custom 101 = not live)", async () => {
    const conn = (err: unknown) => ({ simulateTransaction: async () => ({ value: { err } }) });
    expect(await isTradeTaxLive(conn({ InstructionError: [0, { Custom: 101 }] }) as any, k(), PROGRAM)).to.equal(false);
    expect(await isTradeTaxLive(conn({ InstructionError: [0, "NotEnoughAccountKeys"] }) as any, k(), PROGRAM)).to.equal(true);
  });
  it("the keeper splits trade-taxed mints with collect_trade_tax, never the protocol-only sweep", () => {
    const cron = src("api/mainnet/fee-settlement-cron.ts");
    expect(cron).to.match(/const tradeTax = tradeTaxAccount \? decodeTradeTax\(tradeTaxAccount\.data\) : null;/);
    expect(cron).to.match(/\? buildCollectTradeTax\(\{[^}]*creatorTreasury: tradeTax\.treasury/);
  });
  it("the admin rate script skips trade-taxed mints", () => {
    expect(src("scripts/update_reserve_transfer_fee.ts")).to.match(/if \(pending > MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS\)/);
  });
  it("the launch form offers one Trade tax and sends it as both sides", () => {
    const form = src("src/merge/components/LiquidityFeeTerms.tsx");
    expect(form).to.match(/label="Trade tax"[^>]*onChange=\{v=>set\(\{buyTaxPct:v,sellTaxPct:v\}\)\}/);
    expect(form).to.match(/on any venue \(Jupiter, Raydium, bots\)/);
    expect(src("src/merge/components/LiveLiquidityActions.tsx")).to.match(/tradeTax\?\{\.\.\.t,sellTaxPct:t\.buyTaxPct\}:t/);
  });
});
