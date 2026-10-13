// DEC-0240: SSR's Raydium-approved pool payer co-signs only pool launches
// that refund it in full, and only as the transaction's fee payer.
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { coSignPoolPayer, loadPoolPayer, poolPayerRefund, POOL_PAYER_REFUND_MARGIN_LAMPORTS, PoolPayerUnavailable } from "../lib/mainnet/poolPayer";
import { SSR_POOL_PAYER } from "../src/merge/lib/liquidity/raydiumCpmm";

function txWithFeePayer(feePayer: PublicKey): string {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

describe("DEC-0240 pool payer co-signing", () => {
  it("refund transfer goes from the creator to the approved payer, measured cost plus the margin", () => {
    const creator = Keypair.generate().publicKey;
    const ix = poolPayerRefund(creator, 150_000_000n);
    expect(ix.programId.equals(SystemProgram.programId)).to.equal(true);
    expect(ix.keys[0].pubkey.equals(creator)).to.equal(true);
    expect(ix.keys[1].pubkey.equals(SSR_POOL_PAYER)).to.equal(true);
    expect(ix.data.readBigUInt64LE(4)).to.equal(150_000_000n + POOL_PAYER_REFUND_MARGIN_LAMPORTS);
  });

  it("refuses to sign when the simulation shows any net SOL cost for the payer", () => {
    const payer = Keypair.generate();
    expect(() => coSignPoolPayer(txWithFeePayer(payer.publicKey), payer, 1n)).to.throw(/cost SSR's pool payer SOL/);
  });

  it("refuses to sign a transaction where the payer is not the fee payer", () => {
    const payer = Keypair.generate();
    expect(() => coSignPoolPayer(txWithFeePayer(Keypair.generate().publicKey), payer, 0n)).to.throw(/not this transaction's fee payer/);
  });

  it("signs a fully refunded launch without changing the message", () => {
    const payer = Keypair.generate();
    const unsigned = txWithFeePayer(payer.publicKey);
    const signed = VersionedTransaction.deserialize(Buffer.from(coSignPoolPayer(unsigned, payer, -20_000n), "base64"));
    expect(Buffer.from(signed.message.serialize()).equals(Buffer.from(VersionedTransaction.deserialize(Buffer.from(unsigned, "base64")).message.serialize()))).to.equal(true);
    expect(signed.signatures[0].some((b) => b !== 0)).to.equal(true);
  });

  it("refuses a configured key that is not Raydium's approved SSR payer, and a missing one", () => {
    expect(() => loadPoolPayer({ SSR_RAYDIUM_POOL_PAYER_SECRET: JSON.stringify(Array.from(Keypair.generate().secretKey)) } as any)).to.throw(PoolPayerUnavailable);
    expect(() => loadPoolPayer({} as any)).to.throw(PoolPayerUnavailable);
  });
});
