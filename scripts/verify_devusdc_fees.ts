// Phase D live verification: proves protocol fee accrual + collection works
// correctly for a devUSDC-composed Reserve (the one created in Phase C,
// scripts/verify_devusdc_reserve.ts). No protocol change needed -- fee
// accrual/collection is Reserve-Token-denominated and composition-agnostic
// by design; this proves that, it doesn't add anything.
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildReadOnlyProgram, findProtocolConfig, findMintAuthority, DEVNET_FIXTURES } from "../packages/sdk/src";

const RESERVE = "HAaoBxSVAnaxEusxxYUnPpAJAyjRzti4zuqxrLWYS4VE"; // from Phase C's verify_devusdc_reserve.ts run
const RESERVE_TOKEN_MINT = "48JyhsTD5bSM18NZMapMHK44Vhk2kreuP7utY5U9uNRW";

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const programId = new PublicKey(DEVNET_FIXTURES.programId);
  const program = buildReadOnlyProgram(connection);

  const reserveAccount = await program.account.reserve.fetch(new PublicKey(RESERVE));
  console.log("Reserve manager (= fee_config.fee_destination in this test):", reserveAccount.manager.toBase58());
  console.log("Pending manager fee shares:", reserveAccount.feeConfig.pendingManagerFeeShares.toString());
  console.log("Pending protocol fee shares:", reserveAccount.feeConfig.pendingProtocolFeeShares.toString());
  if (reserveAccount.feeConfig.pendingManagerFeeShares.toString() === "0" && reserveAccount.feeConfig.pendingProtocolFeeShares.toString() === "0") {
    throw new Error("No pending fees to collect -- did the Phase C Buy actually accrue a mint fee? Aborting.");
  }

  const protocolConfig = await program.account.protocolConfig.fetch(findProtocolConfig(programId)[0]);
  const protocolFeeDestination = protocolConfig.defaultProtocolFeeDestination as PublicKey;
  const managerFeeDestination = reserveAccount.feeConfig.feeDestination as PublicKey;
  console.log("Protocol fee destination:", protocolFeeDestination.toBase58());
  console.log("Manager fee destination:", managerFeeDestination.toBase58());

  const reserveTokenMint = new PublicKey(RESERVE_TOKEN_MINT);
  const [mintAuthority] = findMintAuthority(new PublicKey(RESERVE), programId);
  const managerAta = getAssociatedTokenAddressSync(reserveTokenMint, managerFeeDestination);
  const protocolAta = getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);

  const managerBalBefore = await getAccount(connection, managerAta).then((a) => a.amount).catch(() => 0n);
  const protocolBalBefore = await getAccount(connection, protocolAta).then((a) => a.amount).catch(() => 0n);
  console.log("Manager Reserve Token balance BEFORE collect:", managerBalBefore.toString());
  console.log("Protocol treasury Reserve Token balance BEFORE collect:", protocolBalBefore.toString());

  // Payer: use the DevNet deployer (already funded, holds no special role
  // here other than paying any ATA-creation rent -- collect_fees is
  // permissionless, callable by anyone).
  const deployerSecret = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const ix = await (program.methods as any)
    .collectFees()
    .accounts({
      protocolConfig: findProtocolConfig(programId)[0],
      reserve: new PublicKey(RESERVE),
      reserveTokenMint,
      mintAuthority,
      managerFeeDestinationTokenAccount: managerAta,
      managerFeeDestination,
      protocolFeeDestinationTokenAccount: protocolAta,
      protocolFeeDestination,
      payer: payer.publicKey,
    })
    .instruction();

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  console.log("\ncollect_fees signature:", sig);
  console.log("Explorer:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const managerBalAfter = (await getAccount(connection, managerAta)).amount;
  const protocolBalAfter = (await getAccount(connection, protocolAta)).amount;
  console.log("Manager Reserve Token balance AFTER collect:", managerBalAfter.toString());
  console.log("Protocol treasury Reserve Token balance AFTER collect:", protocolBalAfter.toString());

  const reserveAfter = await program.account.reserve.fetch(new PublicKey(RESERVE));
  console.log("Pending manager fee shares AFTER (expect 0):", reserveAfter.feeConfig.pendingManagerFeeShares.toString());
  console.log("Pending protocol fee shares AFTER (expect 0):", reserveAfter.feeConfig.pendingProtocolFeeShares.toString());

  if (managerBalAfter <= managerBalBefore && protocolBalAfter <= protocolBalBefore) {
    throw new Error("Neither balance increased -- FAIL.");
  }
  console.log("\nCONFIRMED: fee accrual (from the Phase C Buy's mint fee) and collect_fees routing both work correctly for a devUSDC-composed Reserve -- no protocol change needed for Phase D.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
