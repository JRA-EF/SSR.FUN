// The same mint rules, on a LIVE cluster (devnet), against a real deployment
// of the built program -- not a local validator.
//
// Devnet has no xStocks, so the mints are built here to replicate the exact
// configurations found on mainnet, including xStocks' real permanent-delegate
// key, so the allowlist path is genuinely exercised.
//
//   PROGRAM_ID=<deployed id> npx tsx scripts/verify_mint_rules_devnet.ts
import * as fs from "fs";
import * as os from "os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction, createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction, getAccount, getMintLen, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import idlJson from "../packages/sdk/idl/ssr_protocol.json";
import {
  buildCreateReserveInstruction, buildInitializeReserveAssetInstruction, buildSeedReserveInstruction,
  deriveNewReserveAddresses, deriveReserveAssetAddresses,
} from "../packages/sdk/src/createReserveFlow";
import { findProtocolConfig } from "../packages/sdk/src/pda";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);
const XSTOCKS_DELEGATE = new PublicKey("5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq"); // the approved issuer
const DECIMALS = 6;

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/ssr-deploy.json`, "utf8"))));

/** Builds a Token-2022 mint with the given extensions initialised. */
async function makeMint(opts: { delegate?: PublicKey; feeBps?: number; inertHook?: boolean }): Promise<PublicKey> {
  const kp = Keypair.generate();
  const exts: ExtensionType[] = [];
  if (opts.delegate) exts.push(ExtensionType.PermanentDelegate);
  if (opts.feeBps !== undefined) exts.push(ExtensionType.TransferFeeConfig);
  if (opts.inertHook) exts.push(ExtensionType.TransferHook);
  const len = getMintLen(exts);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, space: len, lamports: await connection.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
  );
  // Extension inits must precede InitializeMint.
  if (opts.feeBps !== undefined) tx.add(createInitializeTransferFeeConfigInstruction(kp.publicKey, payer.publicKey, payer.publicKey, opts.feeBps, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID));
  if (opts.delegate) tx.add(createInitializePermanentDelegateInstruction(kp.publicKey, opts.delegate, TOKEN_2022_PROGRAM_ID));
  // programId = default pubkey means NO hook program: the mint declares the
  // extension but nothing runs, exactly like xStocks and PUMP on mainnet.
  if (opts.inertHook) tx.add(createInitializeTransferHookInstruction(kp.publicKey, payer.publicKey, PublicKey.default, TOKEN_2022_PROGRAM_ID));
  tx.add(createInitializeMintInstruction(kp.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID));
  await sendAndConfirmTransaction(connection, tx, [payer, kp], { commitment: "confirmed" });
  return kp.publicKey;
}

async function makeClassicMint(): Promise<PublicKey> {
  const kp = Keypair.generate();
  const len = 82;
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, space: len, lamports: await connection.getMinimumBalanceForRentExemption(len), programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(kp.publicKey, DECIMALS, payer.publicKey, null, TOKEN_PROGRAM_ID),
  ), [payer, kp], { commitment: "confirmed" });
  return kp.publicKey;
}

async function main() {
  console.log("cluster:", RPC, "\nprogram:", PROGRAM_ID.toBase58(), "\npayer  :", payer.publicKey.toBase58(), "\n");
  const provider = new AnchorProvider(connection, { publicKey: payer.publicKey, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t } as never, { commitment: "confirmed" });
  // Anchor takes the program id from the IDL, which carries the MAINNET
  // address -- point it at this throwaway devnet deployment.
  const idl = { ...(idlJson as unknown as Record<string, unknown>), address: PROGRAM_ID.toBase58() } as unknown as Idl;
  const program = new Program(idl, provider);

  const [protocolConfig] = findProtocolConfig(PROGRAM_ID);
  if (!(await connection.getAccountInfo(protocolConfig))) {
    await sendAndConfirmTransaction(connection, new Transaction().add(
      await program.methods.initializeProtocol(Keypair.generate().publicKey, 10, 0, payer.publicKey)
        .accounts({ protocolConfig, authority: payer.publicKey, systemProgram: SystemProgram.programId } as never).instruction(),
    ), [payer], { commitment: "confirmed" });
    console.log("initialize_protocol ok");
  }

  const cases: { label: string; mint: PublicKey; tokenProgram: PublicKey; expect: "accept" | "reject" }[] = [
    { label: "xStocks-like  (approved delegate + inert hook)", mint: await makeMint({ delegate: XSTOCKS_DELEGATE, inertHook: true }), tokenProgram: TOKEN_2022_PROGRAM_ID, expect: "accept" },
    { label: "1% transfer fee", mint: await makeMint({ feeBps: 100 }), tokenProgram: TOKEN_2022_PROGRAM_ID, expect: "accept" },
    { label: "UNAPPROVED delegate (a memecoin)", mint: await makeMint({ delegate: Keypair.generate().publicKey }), tokenProgram: TOKEN_2022_PROGRAM_ID, expect: "reject" },
    { label: "100% transfer fee (uninvertible)", mint: await makeMint({ feeBps: 10_000 }), tokenProgram: TOKEN_2022_PROGRAM_ID, expect: "reject" },
    { label: "classic SPL", mint: await makeClassicMint(), tokenProgram: TOKEN_PROGRAM_ID, expect: "accept" },
  ];

  let failures = 0;
  let feeCase: { mint: PublicKey; addresses: Awaited<ReturnType<typeof deriveNewReserveAddresses>>; asset: ReturnType<typeof deriveReserveAssetAddresses> } | null = null;

  for (const c of cases) {
    const addresses = await deriveNewReserveAddresses(program as never, PROGRAM_ID);
    await sendAndConfirmTransaction(connection, new Transaction().add(
      await buildCreateReserveInstruction(program as never, addresses, payer.publicKey, {
        metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0000000000000000",
        mintFeeBps: 0, redemptionFeeBps: 0, tvlFeeBps: 0, feeDestination: payer.publicKey,
      } as never),
    ), [payer], { commitment: "confirmed" });

    const asset = deriveReserveAssetAddresses(addresses.reserve, c.mint, PROGRAM_ID, c.tokenProgram);
    let accepted = true; let logs: string[] = [];
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(
        await buildInitializeReserveAssetInstruction(program as never, addresses, asset, payer.publicKey, 10_000),
      ), [payer], { commitment: "confirmed" });
    } catch (e) { accepted = false; logs = (e as { logs?: string[] }).logs ?? []; }
    const errLine = logs.find((l) => /Error Code/.test(l)) ?? "";
    const rejectedForExtension = !accepted && /UnsupportedMintExtension/.test(errLine);
    const ok = c.expect === "accept" ? accepted : rejectedForExtension;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
    console.log(`      expected ${c.expect}, got ${accepted ? "accept" : rejectedForExtension ? "reject (UnsupportedMintExtension)" : `reject: ${errLine.slice(0, 100)}`}`);
    if (ok && c.label.startsWith("1%")) feeCase = { mint: c.mint, addresses, asset };
  }

  // The gross-up, on a live cluster.
  if (feeCase) {
    const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, feeCase.mint, payer.publicKey, false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID)).address;
    await mintTo(connection, payer, feeCase.mint, ata, payer, 1_000_000_000n, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const before = BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
    const FUND = 1_000_000n;
    await sendAndConfirmTransaction(connection, new Transaction().add(
      await buildSeedReserveInstruction(program as never, feeCase.addresses, [feeCase.asset], payer.publicKey, [FUND], 1_000_000_000n),
    ), [payer], { commitment: "confirmed" });
    const vault = BigInt((await getAccount(connection, feeCase.asset.vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
    const spent = before - BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
    const ok = vault === FUND && spent > FUND;
    if (!ok) failures++;
    console.log(`\n${ok ? "PASS" : "FAIL"}  fee gross-up: asked ${FUND}, vault holds ${vault} (naive would be 990000), depositor debited ${spent}`);
  }

  console.log(`\n${failures === 0 ? "ALL CASES PASSED ON DEVNET" : `${failures} CASE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
