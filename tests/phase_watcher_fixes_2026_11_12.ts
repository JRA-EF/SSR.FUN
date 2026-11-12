// DEC-0290: fixes from the 2026-11-12 Error watcher review.
//  - a Jupiter swap failing a pre-sign simulation is named as Jupiter, not as an SsrError with the same code
//  - a redemption's payout is read from its own transactions when the saved baseline hides it
//  - a swap route lookup table that no longer exists is skipped, not fatal
import { expect } from "chai";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { describeSimulationFailure, failingProgramId, JUPITER_V6_PROGRAM_ID } from "../lib/mainnet/simulationError";
import { usdcDeltaFromSignatures } from "../src/merge/lib/multiAssetSellClient";
import { fetchLookupTables } from "../src/merge/lib/singleTxBuy";

const payer = Keypair.generate().publicKey;
const SSR = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const JUP = new PublicKey(JUPITER_V6_PROGRAM_ID);

function tx(programs: PublicKey[]): VersionedTransaction {
  const ixs = programs.map((p) => new TransactionInstruction({ programId: p, keys: [], data: Buffer.alloc(0) }));
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}

describe("DEC-0290 simulation failures name the failing program", () => {
  const t = tx([SSR, SSR, JUP]);

  it("finds the program of the failing instruction", () => {
    expect(failingProgramId(t, { InstructionError: [2, { Custom: 6001 }] })).to.equal(JUPITER_V6_PROGRAM_ID);
    expect(failingProgramId(t, { InstructionError: [0, { Custom: 6001 }] })).to.equal(SSR.toBase58());
    expect(failingProgramId(t, "BlockhashNotFound")).to.equal(null);
  });

  it("explains Jupiter 6001 as slippage, never as SsrError::ZeroValue", () => {
    const msg = describeSimulationFailure(t, { InstructionError: [2, { Custom: 6001 }] });
    expect(msg).to.contain("slippage");
    expect(msg).to.contain("Jupiter error 6001");
    expect(msg).to.not.contain("ZeroValue");
  });

  it("still decodes SSR's own 6001 when ssr_protocol failed", () => {
    expect(describeSimulationFailure(t, { InstructionError: [0, { Custom: 6001 }] })).to.contain("ZeroValue");
  });
});

describe("DEC-0290 redemption payout read from its own transactions", () => {
  const owner = "BZTq8VZrpvxFza1TWb5gbWPtGmwN56hUoWJNDC2bmTDd";
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const row = (amount: string, o = owner, mint = usdc) => ({ accountIndex: 1, mint, owner: o, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: "" } });
  const txs: Record<string, unknown> = {
    // the live TESTR swap leg: 5,849,606 -> 6,048,769 raw
    leg: { meta: { err: null, preTokenBalances: [row("5849606"), row("9", "someoneElse")], postTokenBalances: [row("6048769"), row("1", "someoneElse")] } },
    failed: { meta: { err: { InstructionError: [0, "x"] }, preTokenBalances: [row("0")], postTokenBalances: [row("500")] } },
  };
  const conn = { getTransaction: async (sig: string) => (txs[sig] ?? null) } as unknown as Pick<Connection, "getTransaction">;

  it("sums only the owner's USDC across confirmed transactions, once per signature", async () => {
    expect(await usdcDeltaFromSignatures(conn, ["leg", "leg", "failed", "missing"], owner, usdc)).to.equal(199163n);
  });
});

describe("DEC-0290 swap route lookup tables", () => {
  it("skips a table that no longer exists instead of failing the build", async () => {
    const live = Keypair.generate().publicKey;
    const conn = {
      getAddressLookupTable: async (k: PublicKey) => ({ value: k.equals(live) ? ({ key: live } as unknown) : null }),
    } as unknown as Connection;
    const tables = await fetchLookupTables(conn, [live.toBase58(), Keypair.generate().publicKey.toBase58(), live.toBase58()]);
    expect(tables).to.have.length(1);
  });

  it("still throws when the RPC read itself fails", async () => {
    const conn = { getAddressLookupTable: async () => { throw new Error("429"); } } as unknown as Connection;
    let threw = false;
    try { await fetchLookupTables(conn, [Keypair.generate().publicKey.toBase58()]); } catch { threw = true; }
    expect(threw).to.equal(true);
  });
});
