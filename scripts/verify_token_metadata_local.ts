// End-to-end check of set_reserve_token_metadata with real signed
// transactions against EITHER a local test validator OR a throwaway DevNet
// deployment of the freshly built program:
//
//   # local (needs the Windows symlink privilege -- run elevated / Developer Mode):
//   solana-test-validator --reset --rpc-port 8899 \
//     --bpf-program 8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9 target/deploy/ssr_protocol.so \
//     --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s --url https://api.mainnet-beta.solana.com
//   npx ts-node -P scripts/tsconfig.json scripts/verify_token_metadata_local.ts
//
//   # throwaway DevNet deployment (program built with declare_id! = <temp id>):
//   RPC=https://api.devnet.solana.com PROGRAM_ID=<temp id> FUNDER_KEYPAIR=~/.config/solana/devnet-deployer.json \
//     npx ts-node -P scripts/tsconfig.json scripts/verify_token_metadata_local.ts
//
// Why not the real DevNet program: its ProtocolConfig account still has the
// pre-admin_2 86-byte layout, so any instruction loading ProtocolConfig
// (this one included) cannot deserialize it there -- see the 2026-09-17
// decision-log entry.
//
// Exercises: initialize_protocol, create_reserve, set_reserve_token_metadata
// as the Manager (CREATE path), read-back via the SDK decoder,
// set_reserve_token_metadata again with a new name (UPDATE path), the same as
// the protocol authority (admin backfill path), and the rejection of a
// stranger, of a 33-byte name, and of a wrong metadata account.
import * as fs from "fs";
import * as os from "os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import idlJson from "../packages/sdk/idl/ssr_protocol.json";
import {
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildSetReserveTokenMetadataInstruction,
  fetchReserveTokenMetadata,
  findDelegate,
  findProtocolConfig,
  findTokenMetadata,
  fitTokenMetadataName,
  fitTokenMetadataSymbol,
  describeOnChainError,
} from "../packages/sdk/src";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const RPC = process.env.RPC ?? process.env.LOCAL_RPC ?? "http://127.0.0.1:8899";
const TOKEN_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p.replace(/^~/, os.homedir()), "utf8"))));
}

async function fund(connection: Connection, funder: Keypair | null, kp: Keypair, sol: number) {
  if (funder) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
    await sendAndConfirmTransaction(connection, tx, [funder], { commitment: "confirmed" });
  } else {
    const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

async function send(connection: Connection, ixs: Parameters<Transaction["add"]>[0][], signers: Keypair[]): Promise<string> {
  return sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}

async function expectFailure(label: string, p: Promise<unknown>, needle: RegExp) {
  try {
    await p;
  } catch (e) {
    const msg = describeOnChainError(e) + " " + (e instanceof Error ? e.message : String(e));
    assert(needle.test(msg), `${label}: failed for the wrong reason: ${msg.slice(0, 400)}`);
    console.log(`  ok  ${label} rejected: ${msg.match(needle)?.[0]}`);
    return;
  }
  throw new Error(`${label}: expected failure, but succeeded`);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const funder = process.env.FUNDER_KEYPAIR ? loadKeypair(process.env.FUNDER_KEYPAIR) : null;
  const authority = Keypair.generate();
  const admin2 = Keypair.generate();
  const manager = Keypair.generate();
  const stranger = Keypair.generate();
  const readOnly = { publicKey: stranger.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
  const provider = new AnchorProvider(connection, readOnly as any, { commitment: "confirmed" });
  const program = new Program({ ...(idlJson as Idl), address: PROGRAM_ID.toBase58() } as Idl, provider) as any;

  // DevNet funding via transfers from the funder (airdrops are rate-limited); local via airdrop.
  const perWallet = funder ? 0.05 : 5;
  await fund(connection, funder, authority, perWallet);
  await fund(connection, funder, manager, perWallet);
  await fund(connection, funder, stranger, funder ? 0.02 : 2);
  console.log(`program=${PROGRAM_ID.toBase58()} rpc=${RPC}`);
  console.log(`authority=${authority.publicKey.toBase58()} manager=${manager.publicKey.toBase58()}`);

  // 1. initialize_protocol (fresh program).
  const [protocolConfig] = findProtocolConfig(PROGRAM_ID);
  const initIx = await program.methods
    .initializeProtocol(admin2.publicKey, 12, 0, authority.publicKey)
    .accounts({ protocolConfig, authority: authority.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  await send(connection, [initIx], [authority]);
  console.log("  ok  initialize_protocol");

  // 2. create_reserve with an app-style metadata URI.
  const addresses = await deriveNewReserveAddresses(program, PROGRAM_ID);
  const metadataUri = "https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef";
  const createIx = await buildCreateReserveInstruction(program, addresses, manager.publicKey, {
    metadataUri,
    mintFeeBps: 100,
    redemptionFeeBps: 0,
    tvlFeeBps: 100,
    feeDestination: manager.publicKey,
  });
  await send(connection, [createIx], [manager]);
  console.log(`  ok  create_reserve reserve=${addresses.reserve.toBase58()} mint=${addresses.reserveTokenMint.toBase58()}`);
  assert((await fetchReserveTokenMetadata(connection, addresses.reserveTokenMint)) === null, "no metadata before publish");

  const [managerDelegate] = findDelegate(addresses.reserve, manager.publicKey, PROGRAM_ID);
  const uri = `https://ssr.fun/api/mainnet/token-metadata?id=0123456789abcdef&reserve=${addresses.reserve.toBase58()}`;
  const fields = { name: fitTokenMetadataName("Strategic Solana Reserve"), symbol: fitTokenMetadataSymbol("SSRSol"), uri };
  const [metadataPda] = findTokenMetadata(addresses.reserveTokenMint);
  const accountsFor = (signer: PublicKey, delegate: PublicKey, metadata: PublicKey = metadataPda) => ({
    protocolConfig,
    reserve: addresses.reserve,
    reserveTokenMint: addresses.reserveTokenMint,
    mintAuthority: addresses.mintAuthority,
    metadata,
    delegate,
    signer,
    tokenMetadataProgram: TOKEN_METADATA_PROGRAM,
    systemProgram: SystemProgram.programId,
    rent: RENT,
  });

  // 3. Stranger cannot publish.
  const [strangerDelegate] = findDelegate(addresses.reserve, stranger.publicKey, PROGRAM_ID);
  await expectFailure(
    "stranger",
    (async () => {
      const ix = await buildSetReserveTokenMetadataInstruction(program, PROGRAM_ID, addresses.reserve, addresses.reserveTokenMint, stranger.publicKey, strangerDelegate, fields);
      return send(connection, [ix], [stranger]);
    })(),
    /AccountNotInitialized|Unauthorized|permission|NotReserveManager|[Dd]elegate|3012|6003|600[0-9]|60[0-9][0-9]/,
  );

  // 4. Manager publishes (CREATE path).
  const createMetaIx = await buildSetReserveTokenMetadataInstruction(program, PROGRAM_ID, addresses.reserve, addresses.reserveTokenMint, manager.publicKey, managerDelegate, fields);
  const sig1 = await send(connection, [createMetaIx], [manager]);
  const after1 = await fetchReserveTokenMetadata(connection, addresses.reserveTokenMint);
  assert(after1, "metadata account exists after publish");
  assert(after1.name === "Strategic Solana Reserve", `name: ${after1.name}`);
  assert(after1.symbol === "SSRSol", `symbol: ${after1.symbol}`);
  assert(after1.uri === uri, `uri: ${after1.uri}`);
  assert(after1.mint === addresses.reserveTokenMint.toBase58(), "mint");
  assert(after1.updateAuthority === addresses.mintAuthority.toBase58(), `update authority is the mint-authority PDA: ${after1.updateAuthority}`);
  assert(after1.isMutable, "is_mutable");
  const raw = await connection.getAccountInfo(metadataPda);
  assert(raw && raw.owner.equals(TOKEN_METADATA_PROGRAM), "metadata account owned by the Token Metadata program");
  console.log(`  ok  set_reserve_token_metadata CREATE by manager ${sig1} -> "${after1.name}" (${after1.symbol})`);

  // 5. Manager updates (UPDATE path).
  const updIx = await buildSetReserveTokenMetadataInstruction(program, PROGRAM_ID, addresses.reserve, addresses.reserveTokenMint, manager.publicKey, managerDelegate, {
    ...fields,
    name: "Strategic Solana Reserve II",
  });
  const sig2 = await send(connection, [updIx], [manager]);
  const after2 = await fetchReserveTokenMetadata(connection, addresses.reserveTokenMint);
  assert(after2 && after2.name === "Strategic Solana Reserve II" && after2.symbol === "SSRSol", `updated name: ${after2?.name}`);
  console.log(`  ok  set_reserve_token_metadata UPDATE by manager ${sig2} -> "${after2!.name}"`);

  // 6. Protocol authority updates (admin backfill path; its delegate PDA never exists).
  const [authorityDelegate] = findDelegate(addresses.reserve, authority.publicKey, PROGRAM_ID);
  const adminIx = await buildSetReserveTokenMetadataInstruction(program, PROGRAM_ID, addresses.reserve, addresses.reserveTokenMint, authority.publicKey, authorityDelegate, fields);
  const sig3 = await send(connection, [adminIx], [authority]);
  const after3 = await fetchReserveTokenMetadata(connection, addresses.reserveTokenMint);
  assert(after3 && after3.name === "Strategic Solana Reserve", `admin restored name: ${after3?.name}`);
  console.log(`  ok  set_reserve_token_metadata UPDATE by protocol authority (admin path) ${sig3}`);

  // 7. Over-long name is rejected by the program with the named error.
  await expectFailure(
    "33-byte name",
    (async () => {
      const ix = await program.methods.setReserveTokenMetadata("x".repeat(33), "SSRSol", uri).accounts(accountsFor(manager.publicKey, managerDelegate)).instruction();
      return send(connection, [ix], [manager]);
    })(),
    /TokenMetadataNameInvalid|6062/,
  );

  // 8. Wrong metadata account is rejected.
  await expectFailure(
    "wrong metadata PDA",
    (async () => {
      const ix = await program.methods
        .setReserveTokenMetadata("Strategic Solana Reserve", "SSRSol", uri)
        .accounts(accountsFor(manager.publicKey, managerDelegate, Keypair.generate().publicKey))
        .instruction();
      return send(connection, [ix], [manager]);
    })(),
    /TokenMetadataAddressMismatch|6065/,
  );

  console.log("ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
