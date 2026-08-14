// Live DevNet verification: a genuinely 0%-configured Mint fee now produces
// a real 0% effective fee (Protocol 0% / Manager 0%) -- the forced 0.5%
// minimum was removed per explicit user follow-up request after DEC-0094.
// Mirrors scripts/verify_manager_fee_recipients_devnet.ts's conventions.
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BN } from "@anchor-lang/core";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"), "utf-8");

import mintTestAssetsHandler from "../api/devnet/mint-test-assets";
import {
  buildReadOnlyProgram,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  DEVNET_FIXTURES,
  DEVUSDC,
  findMintAuthority,
  findProtocolConfig,
} from "../packages/sdk/src";

function resolveRpcUrlForScript(): string {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return "https://api.devnet.solana.com";
  const line = fs.readFileSync(envPath, "utf-8").split("\n").find((l) => l.startsWith("HELIUS_RPC_URL="));
  if (!line) return "https://api.devnet.solana.com";
  return line.slice("HELIUS_RPC_URL=".length).trim().replace(/^['"]|['"]$/g, "") || "https://api.devnet.solana.com";
}

const connection = new Connection(resolveRpcUrlForScript(), "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const program = buildReadOnlyProgram(connection);

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return { status(code: number) { state.statusCode = code; return this; }, json(body: unknown) { state.body = body; }, _state: state };
}

async function send(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  console.log(`  [${label}] signature: ${sig}`);
  console.log(`  [${label}] explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

async function main() {
  const deployerSecret = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  console.log(`Deployer/payer: ${deployer.publicKey.toBase58()}`);
  console.log(`Program: ${programId.toBase58()}`);

  const creator = Keypair.generate();
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })), [deployer], "fund creator");

  const addresses = await deriveNewReserveAddresses(program as any, programId);
  console.log(`Reserve: ${addresses.reserve.toBase58()} (reserveId ${addresses.reserveId.toString()})`);

  const devusdcMint = new PublicKey(DEVUSDC.mint);
  const assetAddr = deriveReserveAssetAddresses(addresses.reserve, devusdcMint, programId);

  const createIx = await buildCreateReserveInstruction(program as any, addresses, creator.publicKey, {
    metadataUri: "https://ssr.fun/r/zero-fee-floor-removed-test",
    mintFeeBps: 0, // genuinely configured to 0% -- must now be a real 0% effective fee
    redemptionFeeBps: 0,
    tvlFeeBps: 0,
    feeDestination: creator.publicKey,
  });
  const registerIx = await buildInitializeReserveAssetInstruction(program as any, addresses, assetAddr, creator.publicKey, 10_000);
  await send(new Transaction().add(createIx, registerIx), [creator], "create_reserve + initialize_reserve_asset");

  const creatorDevusdcAta = getAssociatedTokenAddressSync(devusdcMint, creator.publicKey);
  await mintTestAssetsHandler({ method: "POST", headers: {}, body: { userPubkey: creator.publicKey.toBase58(), mints: [{ mint: devusdcMint.toBase58(), rawAmount: "500000000" }] } } as any, mockRes() as any);
  await send(new Transaction().add(await buildSeedReserveInstruction(program as any, addresses, [assetAddr], creator.publicKey, [2_000_000n], 2_000_000n)), [creator], "seed_reserve");

  const grossRequested = 100_000_000n;
  const creatorRtAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, creator.publicKey);
  const [mintAuthority] = findMintAuthority(addresses.reserve, programId);
  const [protocolConfigPda] = findProtocolConfig(programId);

  const mintIx = await (program.methods as any)
    .mintReserveTokensInKind(new BN(grossRequested.toString()), new BN(0), [new BN(200_000_000)])
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority,
      depositorReserveTokenAccount: creatorRtAta,
      depositor: creator.publicKey,
      managerFeeRecipients: programId, // sentinel -- not migrated
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: assetAddr.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddr.vault, isWritable: true, isSigner: false },
      { pubkey: creatorDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: devusdcMint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(mintIx), [creator], "mint_reserve_tokens_in_kind (Buy, 0% configured)");

  const reserveAfter = await program.account.reserve.fetch(addresses.reserve);
  const pendingManager = BigInt(reserveAfter.feeConfig.pendingManagerFeeShares.toString());
  const pendingProtocol = BigInt(reserveAfter.feeConfig.pendingProtocolFeeShares.toString());
  console.log(`Pending after Buy: manager=${pendingManager} protocol=${pendingProtocol} (expect 0, 0 -- no forced minimum fee)`);

  // seed_reserve already minted 2,000,000 raw units to this same ATA before
  // the Buy -- the depositor's total balance now is that seed amount PLUS
  // whatever the Buy minted, not the Buy amount alone.
  const seedAmount = 2_000_000n;
  const rtBalAfter = BigInt((await connection.getTokenAccountBalance(creatorRtAta)).value.amount);
  const mintedByBuy = rtBalAfter - seedAmount;
  console.log(`Depositor's RT balance after Buy: ${rtBalAfter} (seed ${seedAmount} + Buy ${mintedByBuy})`);
  console.log(`Minted by the Buy itself: ${mintedByBuy} (expect exactly ${grossRequested} -- full amount, zero fee deducted)`);

  if (pendingManager !== 0n || pendingProtocol !== 0n) {
    throw new Error(`FAIL: expected zero pending fees for a genuinely 0%-configured Reserve, got manager=${pendingManager} protocol=${pendingProtocol}`);
  }
  if (mintedByBuy !== grossRequested) {
    throw new Error(`FAIL: expected the Buy to mint the full ${grossRequested} with no fee deducted, got ${mintedByBuy}`);
  }
  console.log("\nCONFIRMED: a genuinely 0%-configured Reserve now charges a real 0% effective fee on-chain -- no forced Protocol minimum.");
}

main().catch((e) => {
  console.error("\nVERIFICATION FAILED:", e);
  process.exit(1);
});
