// Runs the REAL initialize_reserve_asset instruction, in the freshly built
// program, against REAL mainnet mints cloned into a local validator -- the
// only way to know that validate_asset_mint_extensions accepts and refuses
// what we think it does. `cargo check` proves nothing about behaviour.
//
//   cargo-build-sbf --arch v0 --manifest-path programs/ssr_protocol/Cargo.toml
//
//   solana-test-validator --reset --rpc-port 8899 \
//     --bpf-program 8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9 target/deploy/ssr_protocol.so \
//     --url https://api.mainnet-beta.solana.com \
//     --clone XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB \
//     --clone Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh \
//     --clone PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB \
//     --clone pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn \
//     --clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
//
//   npx tsx scripts/verify_mint_extensions_local.ts
//
// Each case asserts the OUTCOME of a signed transaction, not a simulation of
// our own client logic.
import * as fs from "fs";
import * as os from "os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import idlJson from "../packages/sdk/idl/ssr_protocol.json";
import {
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveNewReserveAddresses,
  deriveReserveAssetAddresses,
} from "../packages/sdk/src/createReserveFlow";
import { findProtocolConfig } from "../packages/sdk/src/pda";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOKEN_CLASSIC = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Each case is a real mainnet mint and what the program must decide about it. */
const CASES: { label: string; mint: string; tokenProgram: PublicKey; expect: "accept" | "reject" }[] = [
  { label: "TSLAx  (xStocks: approved delegate, inert hook, confidential not auto-approve)", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", tokenProgram: TOKEN_2022, expect: "accept" },
  { label: "NVDAx  (xStocks)", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", tokenProgram: TOKEN_2022, expect: "accept" },
  { label: "PUMP   (inert hook, no delegate)", mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", tokenProgram: TOKEN_2022, expect: "accept" },
  { label: "ANDURIL (PreStocks: 100 bps fee + unapproved delegate)", mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB", tokenProgram: TOKEN_2022, expect: "reject" },
  { label: "USDC   (classic SPL, no extensions)", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenProgram: TOKEN_CLASSIC, expect: "accept" },
];

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payer = process.env.FUNDER_KEYPAIR
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR.replace("~", os.homedir()), "utf8"))))
    : Keypair.generate();
  if (!process.env.FUNDER_KEYPAIR) {
    await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
  }

  const provider = new AnchorProvider(connection, { publicKey: payer.publicKey, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t } as never, { commitment: "confirmed" });
  const program = new Program(idlJson as Idl, provider);

  // Protocol + one Reserve to hang assets off.
  const [protocolConfig] = findProtocolConfig(PROGRAM_ID);
  if (!(await connection.getAccountInfo(protocolConfig))) {
    const ix = await program.methods
      // admin_2 must differ from the authority (DuplicateProtocolAdmin).
      .initializeProtocol(Keypair.generate().publicKey, 10, 0, payer.publicKey)
      .accounts({ protocolConfig, authority: payer.publicKey, systemProgram: SystemProgram.programId } as never)
      .instruction();
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], { commitment: "confirmed" });
    console.log("initialize_protocol ok");
  }

  let failures = 0;
  for (const c of CASES) {
    const mint = new PublicKey(c.mint);
    if (!(await connection.getAccountInfo(mint))) {
      console.log(`SKIP  ${c.label}\n      mint not cloned into this validator`);
      failures++;
      continue;
    }

    // A FRESH Reserve per case: one asset at 100% weight each time, so a
    // rejection can only be about the mint. Reusing one Reserve made every
    // case after the first fail on TargetWeightExceedsTotal -- which looked
    // like a pass for the cases that were supposed to be rejected.
    const addresses = await deriveNewReserveAddresses(program as never, PROGRAM_ID);
    const createIx = await buildCreateReserveInstruction(program as never, addresses, payer.publicKey, {
      metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0000000000000000",
      mintFeeBps: 0,
      redemptionFeeBps: 0,
      tvlFeeBps: 0,
      feeDestination: payer.publicKey,
    } as never);
    await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [payer], { commitment: "confirmed" });

    const asset = deriveReserveAssetAddresses(addresses.reserve, mint, PROGRAM_ID, c.tokenProgram);
    const ix = await buildInitializeReserveAssetInstruction(program as never, addresses, asset, payer.publicKey, 10_000);
    let accepted = true;
    let logs: string[] = [];
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], { commitment: "confirmed" });
    } catch (e) {
      accepted = false;
      logs = (e as { logs?: string[] }).logs ?? [];
    }
    const errLine = logs.find((l) => /Error Code/.test(l)) ?? "";
    // A rejection only counts if it is the EXTENSION check refusing it.
    const rejectedForExtension = !accepted && /UnsupportedMintExtension/.test(errLine);
    const ok = c.expect === "accept" ? accepted : rejectedForExtension;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
    console.log(`      expected ${c.expect}, got ${accepted ? "accept" : rejectedForExtension ? "reject (UnsupportedMintExtension)" : `reject for another reason -- ${errLine.slice(0, 110)}`}`);
  }

  console.log(`\n${failures === 0 ? "ALL CASES PASSED" : `${failures} CASE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
