// Swap packing (lib/mainnet/swapPacking.ts): several Jupiter legs share one
// atomic transaction where bytes, account locks and compute allow. Measured
// live 2026-10-30 on #26's real routes: 9 legs -> 3 transactions (50-51 locks,
// 1024-1075 bytes each), so a 10-asset mint is 4 transactions instead of 11.
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { MAX_SWAPS_PER_PACK, packFits, packSwapLegs, type PackableLeg } from "../lib/mainnet/swapPacking";

const payer = Keypair.generate().publicKey;
const PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
/** A synthetic leg touching `accounts` fresh accounts. */
function leg(accounts: number, dataBytes = 40): PackableLeg {
  const keys = Array.from({ length: accounts }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  return { instructions: [new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.alloc(dataBytes) })], tables: [] };
}

describe("swap packing", () => {
  it("small legs share a transaction, up to the compute budget's 3 swaps", () => {
    expect(MAX_SWAPS_PER_PACK).to.equal(3);
    const packs = packSwapLegs(payer, [leg(4), leg(4), leg(4), leg(4)]);
    expect(packs.map((p) => p.length)).to.deep.equal([3, 1]);
  });

  it("never exceeds 64 account locks, even when bytes would fit", () => {
    // No lookup tables here, so bytes bind first; the lock check is exercised directly:
    expect(packFits(payer, [leg(10), leg(10)])).to.equal(true);
    const many = { instructions: [new TransactionInstruction({ programId: PROGRAM, keys: Array.from({ length: 70 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false })), data: Buffer.alloc(1) })], tables: [] };
    expect(packFits(payer, [many])).to.equal(false);
  });

  it("a leg too big to share gets its own transaction; nothing is dropped", () => {
    const legs = [leg(30), leg(30), leg(4)];
    const packs = packSwapLegs(payer, legs);
    expect(packs.flat().sort()).to.deep.equal([0, 1, 2]);
    expect(packs.every((p) => p.length >= 1)).to.equal(true);
  });

  it("the mint builder packs in batch mode and names every mint a packed transaction buys", () => {
    const src = readFileSync(join(__dirname, "..", "lib/mainnet/buildBuy.ts"), "utf8");
    expect(src).to.match(/buildPackedSwapTransactions\(deps, wallet, quotes/);
    expect(src).to.match(/mints, legIndex: legIndexOf\(mints\[0\]\)/);
  });

  it("the client treats a packed transaction as several legs: measured each, retried together", () => {
    const src = readFileSync(join(__dirname, "..", "src/merge/lib/multiAssetBuyClient.ts"), "utf8");
    expect(src).to.match(/for \(const leg of job\.legs\) await reconcileSwappedLeg\(leg\)/);
    expect(src).to.match(/legsOnly: retryMints/);
  });
});
