// Offline coverage for the one-approval buy pass (DEC-0171), driven by the
// live 2026-08-27 four-approval ECHO purchase (tx 23ta8kFQ...): no Reserve
// had a trading lookup table registered, so every composed trade overran
// Solana's 1232-byte wire limit and fell back to the sequential
// multi-approval flow. Measured on Mainnet during the investigation: the
// same ECHO purchase composed WITH a table is 990 bytes, 1 signature, and
// simulates err:null (-10.200018 USDC / +9.891228 ECHO in one transaction).
//
// Covered here, offline:
//  1. chunkAltAddresses -- the create/extend transaction chunking that lets
//     a table for ANY Reserve size (up to the 12-asset product standard) be
//     built without overrunning a transaction.
//  2. wouldFitWithReserveAlt -- the pure fit prediction that gates the buy
//     path's auto-enable step (table rent is only ever spent when the table
//     genuinely buys a one-approval purchase).
//  3. minReserveTokensOut -- real on-chain minimum-output protection wired
//     through the mint builder (previously hardcoded to 1, i.e. disabled).
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_one_approval_buy.ts
import { expect } from "chai";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  chunkAltAddresses,
  buildReserveAltAddresses,
  ALT_FIRST_TX_MAX_ADDRESSES,
  ALT_EXTEND_TX_MAX_ADDRESSES,
} from "../src/merge/lib/reserveAltClient";
import { wouldFitWithReserveAlt, compileSingleBuyTransaction, SingleTxTooLargeError } from "../src/merge/lib/singleTxBuy";
import { buildReadOnlyProgram } from "../packages/sdk/src/readOnly";
import { buildDirectMultiAssetMintInstructions } from "../packages/sdk/src/directInstructions";
import { findProtocolConfig } from "../packages/sdk/src/pda";

const WSOL = "So11111111111111111111111111111111111111112";
const SSR = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";

const key = () => Keypair.generate().publicKey;

describe("reserveAltClient.ts -- chunkAltAddresses (table creation for any Reserve size)", () => {
  it("returns no chunks for an empty list", () => {
    expect(chunkAltAddresses([])).to.deep.equal([]);
  });

  it("a 3-asset Reserve's 24 addresses stay ONE create+extend transaction (the measured live case: ECHO's table, 1,090 bytes)", () => {
    const addresses = Array.from({ length: 24 }, key);
    const chunks = chunkAltAddresses(addresses);
    expect(chunks.length).to.equal(1);
    expect(chunks[0]).to.deep.equal(addresses);
  });

  it("splits past the first-transaction capacity and preserves order with nothing dropped or duplicated", () => {
    const addresses = Array.from({ length: ALT_FIRST_TX_MAX_ADDRESSES + ALT_EXTEND_TX_MAX_ADDRESSES + 3 }, key);
    const chunks = chunkAltAddresses(addresses);
    expect(chunks.length).to.equal(3);
    expect(chunks[0].length).to.equal(ALT_FIRST_TX_MAX_ADDRESSES);
    expect(chunks[1].length).to.equal(ALT_EXTEND_TX_MAX_ADDRESSES);
    expect(chunks[2].length).to.equal(3);
    expect(chunks.flat().map((a) => a.toBase58())).to.deep.equal(addresses.map((a) => a.toBase58()));
  });

  it("the 12-asset product-standard table (16 fixed + 36 per-asset = 52 addresses; DEC-0173 swapped the 2 treasury-destination entries for the 3 fee-vault accounts) needs exactly one follow-up extend", () => {
    const params = {
      ssrProgramId: key(),
      reserve: key(),
      reserveTokenMint: key(),
      mintAuthority: key(),
      vaultAuthority: key(),
      protocolFeeDestination: key(),
      assets: Array.from({ length: 12 }, () => ({ mint: key().toBase58(), reserveAsset: key().toBase58(), vault: key().toBase58() })),
    };
    const addresses = buildReserveAltAddresses(params);
    expect(addresses.length).to.equal(52);
    const chunks = chunkAltAddresses(addresses);
    expect(chunks.length).to.equal(2);
    expect(chunks.flat().length).to.equal(52);
  });
});

describe("singleTxBuy.ts -- wouldFitWithReserveAlt (fit prediction before spending table rent)", () => {
  const payer = key();
  /** An instruction whose accounts are all drawn from `pool` -- compressible when the pool is the table's contents. */
  const ixFrom = (pool: PublicKey[], count: number, dataBytes: number) =>
    new TransactionInstruction({
      programId: pool[0],
      keys: pool.slice(1, 1 + count).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      data: Buffer.alloc(dataBytes),
    });

  it("predicts a fit when the would-be table covers the composition's accounts", () => {
    const pool = Array.from({ length: 40 }, key);
    const instructions = Array.from({ length: 4 }, () => ixFrom(pool, 30, 40));
    expect(wouldFitWithReserveAlt({ payer, instructions, reserveAltAddresses: pool, swapLookupTables: [] })).to.equal(true);
    // ...and the same composition genuinely overruns WITHOUT the table --
    // the exact situation the auto-enable step exists for.
    expect(() =>
      compileSingleBuyTransaction({ payer, recentBlockhash: SystemProgram.programId.toBase58(), instructions, lookupTables: [] }),
    ).to.throw(SingleTxTooLargeError);
  });

  it("predicts NO fit for a composition whose accounts the table cannot cover (many-leg Reserves) -- no rent is spent on a table that can't help", () => {
    const tableAddresses = Array.from({ length: 20 }, key);
    // 12 instructions x 25 distinct never-in-table accounts each -- the
    // 10-asset shape measured to overrun regardless of any table.
    const instructions = Array.from({ length: 12 }, () => ixFrom([key(), ...Array.from({ length: 25 }, key)], 25, 60));
    expect(wouldFitWithReserveAlt({ payer, instructions, reserveAltAddresses: tableAddresses, swapLookupTables: [] })).to.equal(false);
  });
});

describe("directInstructions.ts -- minReserveTokensOut wired to the on-chain min_reserve_tokens_out (previously hardcoded 1)", () => {
  const build = async (minReserveTokensOut?: bigint) => {
    const connection = new Connection("http://localhost:9999"); // never contacted -- .instruction() builds offline
    const program = buildReadOnlyProgram(connection);
    const { instructions } = await buildDirectMultiAssetMintInstructions({
      program,
      protocolConfig: findProtocolConfig(program.programId)[0],
      protocolFeeDestination: new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5"),
      reserve: new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb"),
      reserveTokenMint: new PublicKey("J4XbyjS6iPHRQ8oPAAAc2GhmP3549ga9gZiu8MR5iimq"),
      mintAuthority: new PublicKey("FAjR5aMW9j8fZwFw9nDxkhjU3fjDAGq8Taniby6rmrZ5"),
      user: new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen"),
      assets: [
        { mint: WSOL, decimals: 9, reserveAsset: "6k3bmpVsP9T6mYHmJbJoGguQrrv7rB3wH8zqSRYo8kpa", vault: "9xQQ9UUjuUbKpu2E5Pswf8SsjfmEJVrYMdRwLX7spNvu", vaultBalanceRaw: "101896089" },
        { mint: SSR, decimals: 6, reserveAsset: "5wfs7tUrkvVzUPKst5mk7pHpMvvoZaskpkKSwk2huAfo", vault: "34hNxsxqBWH9czMKpng6zqcsmpg8SA4NeznenyF7VqH8", vaultBalanceRaw: "16187960040" },
      ],
      reserveTokenSupplyRaw: "19900000",
      reserveTokensRequested: 100000n,
      ...(minReserveTokensOut !== undefined ? { minReserveTokensOut } : {}),
    });
    return instructions[instructions.length - 1];
  };
  // Anchor data layout: 8-byte discriminator, u64 reserve_tokens_requested,
  // u64 min_reserve_tokens_out, then the vec<u64> caps.
  const minOutOf = (ix: TransactionInstruction) => Buffer.from(ix.data).readBigUInt64LE(16);

  it("encodes the caller's expected net output as the on-chain minimum", async () => {
    expect(minOutOf(await build(98_995n))).to.equal(98_995n);
  });

  it("defaults to the pre-existing 1 when not provided (backward compatibility for older callers)", async () => {
    expect(minOutOf(await build())).to.equal(1n);
  });
});
