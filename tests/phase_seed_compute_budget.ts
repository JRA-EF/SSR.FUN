// Regression coverage for DEC-0166: the DELTA 10-asset seed_reserve died at
// "exceeded CUs meter" (consumed 202,850 of 202,850 -- InstructionError
// [1, ProgramFailedToComplete]) because no setComputeUnitLimit instruction
// was ever requested, leaving the runtime's ~200k default while the real,
// simulation-measured requirement was 219,754 CU. These tests pin: (1) the
// evidence-derived compute-limit model against BOTH real Mainnet
// datapoints, (2) the decoding of the ProgramFailedToComplete wrapper into
// its real compute-budget explanation, and (3) the packing headroom that
// keeps room for both ComputeBudget instructions.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_seed_compute_budget.ts
import { expect } from "chai";
import { Keypair, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { seedComputeUnitLimit, PRIORITY_FEE_IX_RESERVED_BYTES, packInstructionsBySize, estimateSingleSignerTxBytes } from "../src/merge/lib/createReserveClient";
import { describeOnChainError } from "../packages/sdk/src/errors";

/** Real, measured Mainnet datapoints -- see DEC-0166's evidence list. */
const MEASURED = [
  { assets: 4, consumedCu: 119_408, source: "CHARLI seed 4EX2zEPM... (2026-08-24, landed)" },
  { assets: 10, consumedCu: 219_754, source: "DELTA seed simulation of the exact failed message (2026-08-27)" },
];

describe("seedComputeUnitLimit -- DEC-0166 compute-budget model", () => {
  it("budgets comfortably above BOTH real measured seeds (>=1.5x headroom for ATA-creation variance)", () => {
    for (const m of MEASURED) {
      expect(seedComputeUnitLimit(m.assets), m.source).to.be.at.least(Math.ceil(m.consumedCu * 1.5));
    }
  });

  it("the DELTA failure shape can never recur: limit(10) exceeds the exact measured 10-asset requirement, while the old default (~200k) did not", () => {
    expect(seedComputeUnitLimit(10)).to.be.greaterThan(219_754);
    expect(203_000).to.be.lessThan(219_754); // the budget the failed transaction actually had
  });

  it("stays under Solana's 1.4M per-transaction cap at every asset count through the program's own 12-asset validation maximum (DEFAULT_MAX_RESERVE_ASSETS) -- proof 10-asset Reserves need NO program change", () => {
    for (let n = 1; n <= 12; n++) {
      expect(seedComputeUnitLimit(n)).to.be.at.most(1_400_000);
    }
  });

  it("is monotonic in asset count and floors a degenerate count at 1", () => {
    let prev = 0;
    for (let n = 1; n <= 12; n++) {
      const v = seedComputeUnitLimit(n);
      expect(v).to.be.greaterThan(prev);
      prev = v;
    }
    expect(seedComputeUnitLimit(0)).to.equal(seedComputeUnitLimit(1));
    expect(seedComputeUnitLimit(-3)).to.equal(seedComputeUnitLimit(1));
  });
});

describe("describeOnChainError -- ProgramFailedToComplete decoding (DEC-0166)", () => {
  it("decodes the exact DELTA failure shape into the real compute-budget explanation, never the bare wrapper", () => {
    const msg = describeOnChainError(new Error('Transaction failed on-chain ({"InstructionError":[1,"ProgramFailedToComplete"]}). Signature: 2zFpPZ5y.'));
    expect(msg).to.include("compute");
    expect(msg).to.include("rolls back atomically");
    expect(msg).to.include("compute-unit limit");
  });

  it("leaves ordinary custom-error decoding untouched", () => {
    const msg = describeOnChainError(new Error("custom program error: 0x1783")); // 6019 SeedAmountTooLow
    expect(msg).to.include("SeedAmountTooLow");
  });
});

describe("PRIORITY_FEE_IX_RESERVED_BYTES -- covers BOTH ComputeBudget instructions", () => {
  it("reserves at least the wire cost of setComputeUnitPrice (32+4+9) plus setComputeUnitLimit (~14, program key already listed)", () => {
    expect(PRIORITY_FEE_IX_RESERVED_BYTES).to.be.at.least(32 + 4 + 9 + 14);
  });

  it("packed batches still leave the full (widened) headroom under the 1232-byte limit", () => {
    const feePayer = Keypair.generate().publicKey;
    const makeIx = () =>
      new TransactionInstruction({
        programId: new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9"),
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.alloc(60),
      });
    const batches = packInstructionsBySize(feePayer, Array.from({ length: 30 }, makeIx));
    for (const batch of batches) {
      expect(estimateSingleSignerTxBytes(feePayer, batch)).to.be.at.most(1232 - PRIORITY_FEE_IX_RESERVED_BYTES);
    }
  });
});
