// The FULL user lifecycle on a fee-bearing Token-2022 asset: seed, then
// mint_reserve_tokens_in_kind, then redeem -- the two paths the earlier
// gross-up proof did not execute.
//
// What must hold:
//  * every DEPOSIT lands the full pro-rata amount in the vault (the gross-up),
//    so shares never represent more than the Reserve actually received;
//  * a REDEEM debits the vault pro-rata and the redeemer receives that minus
//    the mint's fee -- their own transfer fee, which the UI must disclose.
//
//   RPC=... PROGRAM_ID=... npx tsx scripts/verify_fee_mint_lifecycle.ts
import * as fs from "fs";
import * as os from "os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction, getAccount, getMintLen,
  getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import idlJson from "../packages/sdk/idl/ssr_protocol.json";
import {
  buildCreateReserveInstruction, buildInitializeReserveAssetInstruction, buildSeedReserveInstruction,
  deriveNewReserveAddresses, deriveReserveAssetAddresses,
} from "../packages/sdk/src/createReserveFlow";
import { buildDirectMintInstructions, buildDirectRedeemInstructions } from "../packages/sdk/src/directInstructions";
import { findProtocolConfig } from "../packages/sdk/src/pda";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const FEE_BPS = 100;
const DECIMALS = 6;
const SEED_AMOUNT = 1_000_000n;
const INITIAL_SHARES = 1_000_000_000n;

const connection = new Connection(RPC, "confirmed");
const keyPath = process.env.FUNDER_KEYPAIR ?? `${os.homedir()}/.config/solana/ssr-deploy.json`;
const payer = fs.existsSync(keyPath) && RPC !== "http://127.0.0.1:8899"
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))))
  : Keypair.generate();

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`); };

async function main() {
  const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
  if (RPC.includes("127.0.0.1")) {
    await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 50 * LAMPORTS_PER_SOL), "confirmed");
  }
  console.log("cluster:", RPC, "\nprogram:", PROGRAM_ID.toBase58(), "\n");

  // A mint that charges 1% on every transfer.
  const mintKp = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, space: len, lamports: await connection.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferFeeConfigInstruction(mintKp.publicKey, payer.publicKey, payer.publicKey, FEE_BPS, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mintKp.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ), [payer, mintKp], { commitment: "confirmed" });
  const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, mintKp.publicKey, payer.publicKey, false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID)).address;
  await mintTo(connection, payer, mintKp.publicKey, ata, payer, 10_000_000_000n, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);

  const provider = new AnchorProvider(connection, { publicKey: payer.publicKey, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t } as never, { commitment: "confirmed" });
  const idl = { ...(idlJson as unknown as Record<string, unknown>), address: PROGRAM_ID.toBase58() } as unknown as Idl;
  const program = new Program(idl, provider);

  const [protocolConfig] = findProtocolConfig(PROGRAM_ID);
  if (!(await connection.getAccountInfo(protocolConfig))) {
    await sendAndConfirmTransaction(connection, new Transaction().add(
      await program.methods.initializeProtocol(Keypair.generate().publicKey, 10, 0, payer.publicKey)
        .accounts({ protocolConfig, authority: payer.publicKey, systemProgram: SystemProgram.programId } as never).instruction(),
    ), [payer], { commitment: "confirmed" });
  }

  const addresses = await deriveNewReserveAddresses(program as never, PROGRAM_ID);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    await buildCreateReserveInstruction(program as never, addresses, payer.publicKey, {
      metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0000000000000000",
      mintFeeBps: 0, redemptionFeeBps: 0, tvlFeeBps: 0, feeDestination: payer.publicKey,
    } as never),
  ), [payer], { commitment: "confirmed" });
  const asset = deriveReserveAssetAddresses(addresses.reserve, mintKp.publicKey, PROGRAM_ID, TOKEN_2022_PROGRAM_ID);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    await buildInitializeReserveAssetInstruction(program as never, addresses, asset, payer.publicKey, 10_000),
  ), [payer], { commitment: "confirmed" });
  await sendAndConfirmTransaction(connection, new Transaction().add(
    await buildSeedReserveInstruction(program as never, addresses, [asset], payer.publicKey, [SEED_AMOUNT], INITIAL_SHARES),
  ), [payer], { commitment: "confirmed" });

  const vaultAfterSeed = BigInt((await getAccount(connection, asset.vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  check("seed_reserve lands the full amount", vaultAfterSeed === SEED_AMOUNT, `vault ${vaultAfterSeed}, asked ${SEED_AMOUNT}`);

  // ---- mint_reserve_tokens_in_kind ----
  const supplyBefore = BigInt((await connection.getTokenSupply(addresses.reserveTokenMint, "confirmed")).value.amount);
  const depositWanted = 500_000n;
  const leg = { mint: mintKp.publicKey.toBase58(), decimals: DECIMALS, reserveAsset: asset.reserveAsset.toBase58(), vault: asset.vault.toBase58(), vaultBalanceRaw: vaultAfterSeed.toString(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() };
  const walletBeforeMint = BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const mintRes = await buildDirectMintInstructions({
    program: program as never, protocolConfig, protocolFeeDestination: payer.publicKey,
    reserve: addresses.reserve, reserveTokenMint: addresses.reserveTokenMint, mintAuthority: addresses.mintAuthority,
    user: payer.publicKey, assets: [leg] as never, reserveTokenSupplyRaw: supplyBefore.toString(), amountIn: depositWanted,
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(...mintRes.instructions), [payer], { commitment: "confirmed" });

  const vaultAfterMint = BigInt((await getAccount(connection, asset.vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const walletAfterMint = BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const arrived = vaultAfterMint - vaultAfterSeed;
  const debited = walletBeforeMint - walletAfterMint;
  check("mint in-kind: the vault receives the full deposit", arrived === depositWanted, `vault +${arrived}, requested ${depositWanted} (without gross-up: ${depositWanted - depositWanted * BigInt(FEE_BPS) / 10_000n})`);
  check("mint in-kind: the depositor pays the fee", debited > depositWanted, `debited ${debited} for a ${depositWanted} deposit`);

  // ---- redeem ----
  const shares = BigInt((await getAccount(connection, getAssociatedTokenAddressSync(addresses.reserveTokenMint, payer.publicKey), "confirmed")).amount);
  const toRedeem = shares / 4n;
  const supplyNow = BigInt((await connection.getTokenSupply(addresses.reserveTokenMint, "confirmed")).value.amount);
  const legNow = { ...leg, vaultBalanceRaw: vaultAfterMint.toString() };
  const walletBeforeRedeem = BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const redeemRes = await buildDirectRedeemInstructions({
    program: program as never, reserve: addresses.reserve, reserveTokenMint: addresses.reserveTokenMint,
    vaultAuthority: addresses.vaultAuthority, user: payer.publicKey, assets: [legNow] as never,
    reserveTokenSupplyRaw: supplyNow.toString(), redemptionFeeBps: 0n, reserveTokensToRedeem: toRedeem,
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(...redeemRes.instructions), [payer], { commitment: "confirmed" });

  const vaultAfterRedeem = BigInt((await getAccount(connection, asset.vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const walletAfterRedeem = BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const leftVault = vaultAfterMint - vaultAfterRedeem;
  const received = walletAfterRedeem - walletBeforeRedeem;
  const expectedPro = (toRedeem * vaultAfterMint) / supplyNow;
  check("redeem: the vault is debited pro-rata", leftVault > 0n && leftVault <= expectedPro + 1n, `vault -${leftVault}, pro-rata ${expectedPro}`);
  check("redeem: the redeemer receives that MINUS the mint's fee (their own transfer fee -- disclose it)",
    received < leftVault && received >= leftVault - (leftVault * BigInt(FEE_BPS)) / 10_000n - 1n,
    `received ${received} of ${leftVault} debited -- ${(Number(leftVault - received) / Number(leftVault) * 100).toFixed(2)}% withheld`);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${failed === 0 ? "ALL LIFECYCLE CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
