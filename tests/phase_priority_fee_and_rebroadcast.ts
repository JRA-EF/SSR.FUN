// Offline coverage for the 2026-08-27 DELTA-launch incident fix (see
// createReserveClient.ts's "Priority fees + rebroadcast" section comment):
// app-built transactions used to go out with NO priority fee, submitted
// exactly once -- the 10-asset seed transaction (and the Resume attempt's
// lookup-table transactions after it) were silently dropped by Mainnet with
// no ledger record. These tests pin the pure parts: the fee-bid selection
// and the packing headroom reserved for the prepended priority instruction.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_priority_fee_and_rebroadcast.ts
import { expect } from "chai";
import { Keypair, TransactionInstruction, PublicKey } from "@solana/web3.js";
import {
  pickPriorityFeeMicroLamports,
  PRIORITY_FEE_FLOOR_MICROLAMPORTS,
  PRIORITY_FEE_CEILING_MICROLAMPORTS,
  PRIORITY_FEE_IX_RESERVED_BYTES,
  packInstructionsBySize,
  estimateSingleSignerTxBytes,
} from "../src/merge/lib/createReserveClient";

describe("pickPriorityFeeMicroLamports -- fee-bid selection from recent prioritization fees", () => {
  it("returns the floor when the RPC reports no observations at all", () => {
    expect(pickPriorityFeeMicroLamports([])).to.equal(PRIORITY_FEE_FLOOR_MICROLAMPORTS);
  });

  it("returns the floor when every observed slot had zero fees -- a zero bid is never copied, because zero-fee slots say 'there was room', not 'zero wins under load'", () => {
    expect(pickPriorityFeeMicroLamports([0, 0, 0, 0])).to.equal(PRIORITY_FEE_FLOOR_MICROLAMPORTS);
  });

  it("picks the 75th percentile of the NONZERO observations", () => {
    // nonzero sorted: [100000, 200000, 300000, 400000] -- p75 index floor(4*0.75)=3 -> 400000
    expect(pickPriorityFeeMicroLamports([0, 300000, 100000, 0, 400000, 200000])).to.equal(400000);
  });

  it("clamps a quiet market up to the floor and an outlier-spiked market down to the ceiling", () => {
    expect(pickPriorityFeeMicroLamports([1, 2, 3])).to.equal(PRIORITY_FEE_FLOOR_MICROLAMPORTS);
    expect(pickPriorityFeeMicroLamports([50_000_000, 80_000_000])).to.equal(PRIORITY_FEE_CEILING_MICROLAMPORTS);
  });

  it("ignores non-finite garbage from the RPC rather than propagating NaN into a fee bid", () => {
    expect(pickPriorityFeeMicroLamports([NaN, Infinity, -5])).to.equal(PRIORITY_FEE_FLOOR_MICROLAMPORTS);
  });

  it("floor and ceiling are sane: nonzero, floor < ceiling, ceiling bounds a 1.4M-CU transaction's priority cost under 0.001 SOL", () => {
    expect(PRIORITY_FEE_FLOOR_MICROLAMPORTS).to.be.greaterThan(0);
    expect(PRIORITY_FEE_FLOOR_MICROLAMPORTS).to.be.lessThan(PRIORITY_FEE_CEILING_MICROLAMPORTS);
    const worstCaseLamports = (1_400_000 * PRIORITY_FEE_CEILING_MICROLAMPORTS) / 1_000_000;
    expect(worstCaseLamports).to.be.lessThan(1_000_000); // < 0.001 SOL
  });
});

describe("PRIORITY_FEE_IX_RESERVED_BYTES -- packing headroom for the prepended priority instruction", () => {
  const feePayer = Keypair.generate().publicKey;
  const makeIx = (dataBytes: number) =>
    new TransactionInstruction({
      programId: new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9"),
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
      data: Buffer.alloc(dataBytes),
    });

  it("every packed batch leaves at least the reserved headroom under the 1232-byte wire limit, so adding the real priority instruction at signing time can never overflow", () => {
    const ixs = Array.from({ length: 30 }, () => makeIx(60));
    const batches = packInstructionsBySize(feePayer, ixs);
    expect(batches.length).to.be.greaterThan(1);
    for (const batch of batches) {
      expect(estimateSingleSignerTxBytes(feePayer, batch)).to.be.at.most(1232 - PRIORITY_FEE_IX_RESERVED_BYTES);
    }
  });

  it("the reservation is a genuine upper bound on a real setComputeUnitPrice instruction's wire cost (32-byte program key + header + 9 data bytes)", () => {
    expect(PRIORITY_FEE_IX_RESERVED_BYTES).to.be.at.least(32 + 4 + 9);
  });
});
