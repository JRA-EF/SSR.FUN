import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  DEVNET_FIXTURES,
  buildReadOnlyProgram,
  fetchReserveOnChain,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
} from "../packages/sdk/src";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);

function loadKeypair(name: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", `${name}-keypair.json`), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const swapAuthority = loadKeypair("manager");
  const deployerSecret = JSON.parse(fs.readFileSync("C:\\Users\\JRA DEVNET\\.config\\solana\\devnet-deployer.json", "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  const newManager = Keypair.generate();

  console.log("New manager (simulating a freshly connected wallet):", newManager.publicKey.toBase58());
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: newManager.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })),
    [deployer],
  );

  const program = buildReadOnlyProgram(connection) as any;

  const addresses = await deriveNewReserveAddresses(program, programId);
  console.log("New reserve address:", addresses.reserve.toBase58(), "reserveId:", addresses.reserveId.toString());

  console.log("\n=== Tx 1: createReserve ===");
  const createIx = await buildCreateReserveInstruction(program, addresses, newManager.publicKey, {
    metadataUri: "https://example.invalid/ssr/e2e-test-reserve.json",
    mintFeeBps: 50,
    redemptionFeeBps: 0,
    tvlFeeBps: 100,
    managerFeeShareBps: 8000,
    protocolFeeShareBps: 2000,
    feeDestination: newManager.publicKey,
  });
  const tx1 = new Transaction().add(createIx);
  const sig1 = await sendAndConfirmTransaction(connection, tx1, [newManager]);
  console.log("createReserve signature:", sig1);

  console.log("\n=== Tx 2: initializeReserveAsset x2 (mockX 60%, mockY 40%) ===");
  const assetX = deriveReserveAssetAddresses(addresses.reserve, new PublicKey(DEVNET_FIXTURES.mints.mintX.address), programId);
  const assetY = deriveReserveAssetAddresses(addresses.reserve, new PublicKey(DEVNET_FIXTURES.mints.mintY.address), programId);
  const initXIx = await buildInitializeReserveAssetInstruction(program, addresses, assetX, newManager.publicKey, 6000);
  const initYIx = await buildInitializeReserveAssetInstruction(program, addresses, assetY, newManager.publicKey, 4000);
  const tx2 = new Transaction().add(initXIx, initYIx);
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [newManager]);
  console.log("initializeReserveAsset signature:", sig2);

  console.log("\n=== Mint seed test assets to new manager's wallet (server-signed faucet step) ===");
  const seedAmounts = [600_000n, 400_000n]; // raw units, 6 decimals each -- $0.6 + $0.4 test value
  const mintTx = new Transaction();
  for (const [i, leg] of [assetX, assetY].entries()) {
    const { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } = await import("@solana/spl-token");
    const ata = getAssociatedTokenAddressSync(leg.mint, newManager.publicKey);
    mintTx.add(createAssociatedTokenAccountIdempotentInstruction(swapAuthority.publicKey, ata, newManager.publicKey, leg.mint));
    mintTx.add(createMintToInstruction(leg.mint, ata, swapAuthority.publicKey, seedAmounts[i]));
  }
  const sigMint = await sendAndConfirmTransaction(connection, mintTx, [swapAuthority]);
  console.log("mint-test-assets signature:", sigMint);

  console.log("\n=== Tx 3: seedReserve ===");
  const initialReserveTokens = 1_000_000n; // 1.0 Reserve Token (6 decimals), $1 initial NAV
  const seedIx = await buildSeedReserveInstruction(program, addresses, [assetX, assetY], newManager.publicKey, seedAmounts, initialReserveTokens);
  const tx3 = new Transaction().add(seedIx);
  const sig3 = await sendAndConfirmTransaction(connection, tx3, [newManager]);
  console.log("seedReserve signature:", sig3);

  console.log("\n=== VERIFY ===");
  const onChain = await fetchReserveOnChain(connection, programId, addresses.reserve, [assetX.mint, assetY.mint]);
  console.log(JSON.stringify(onChain, null, 2));
  const managerRtAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, newManager.publicKey);
  const rtBalance = await getAccount(connection, managerRtAta);
  console.log("new manager Reserve Token balance:", rtBalance.amount.toString());

  console.log("\n=== EXPLORER ===");
  console.log("Reserve account:", `https://explorer.solana.com/address/${addresses.reserve.toBase58()}?cluster=devnet`);
  console.log("createReserve tx:", `https://explorer.solana.com/tx/${sig1}?cluster=devnet`);
  console.log("initializeReserveAsset tx:", `https://explorer.solana.com/tx/${sig2}?cluster=devnet`);
  console.log("seedReserve tx:", `https://explorer.solana.com/tx/${sig3}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
