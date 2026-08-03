// One-off verification script for the 2026-08-03 corrective pass (unknown-
// signer Buy fix + AUM/NAV accounting). Not part of the permanent verify_*.ts
// suite (which targets specific committed fixtures) -- this creates its own
// fresh, single-asset-devUSDC Reserve with a throwaway keypair, because the
// real "123"/ABC Reserve under test (reserveId 20) was already fully
// redeemed (see investigate_reserve_history.ts's findings) and can never
// receive another mint_reserve_tokens_in_kind call again (the program
// requires total_supply_before > 0). This reproduces the exact same
// pure-devUSDC Buy/Sell code path via the real, unmodified
// api/devnet/swap-sign.ts handler and the real discovery/onChainReserve
// formulas the UI itself uses -- no reimplemented math.
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"), "utf-8");

import handler from "../api/devnet/swap-sign";
import { buildReadOnlyProgram, fetchReserveOnChain, discoverAllReserves, DEVNET_FIXTURES, DEVUSDC, DEVUSDC_MINT } from "../packages/sdk/src";
import { buildDtrFromDiscoveredReserve } from "../src/merge/lib/onChainReserve";
import { deriveNewReserveAddresses, buildCreateReserveInstruction, buildInitializeReserveAssetInstruction, deriveReserveAssetAddresses, buildSeedReserveInstruction } from "../packages/sdk/src/createReserveFlow";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
    },
    _state: state,
  };
}

async function callSwapSign(body: Record<string, unknown>): Promise<{ transactionBase64?: string; error?: string; code?: string; quote?: unknown }> {
  const req = { method: "POST", headers: {}, body };
  const res = mockRes();
  await handler(req as any, res as any);
  const b = res._state.body as any;
  console.log(`  swap-sign status=${res._state.statusCode}${b.error ? ` ERROR="${b.error}"` : ""}`);
  return b;
}

async function reportDtrView(label: string, reserveAddress: PublicKey) {
  const { reserves } = await discoverAllReserves(connection, programId, [DEVUSDC_MINT]);
  const found = reserves.find((r) => r.reserve === reserveAddress.toBase58());
  if (!found) {
    console.log(`  [${label}] Reserve not found in discovery pass`);
    return;
  }
  const dtr = buildDtrFromDiscoveredReserve(found, [], null);
  console.log(`  [${label}] status=${found.status} supplyRaw=${found.reserveTokenSupplyRaw} vaultRaw=${found.assets[0]?.vaultBalanceRaw ?? "?"}`);
  console.log(`  [${label}] AUM(dtr.aum)=$${dtr.aum.toFixed(6)}  NAV(dtr.nav)=$${dtr.nav.toFixed(6)}  composition=${JSON.stringify(dtr.composition)}`);
}

async function main() {
  const manager = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"), "utf-8"))));
  const user = Keypair.generate();
  console.log("=== SETUP ===");
  console.log("throwaway user (acts as this fresh Reserve's manager + buyer/seller):", user.publicKey.toBase58());

  console.log("\nFunding user with 0.05 SOL for fees/rent...");
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: manager.publicKey, toPubkey: user.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [manager]);

  console.log("Minting 300 devUSDC to user (manager keypair is devUSDC's real mint authority)...");
  const userDevUsdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, user.publicKey);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(manager.publicKey, userDevUsdcAta, user.publicKey, DEVUSDC_MINT),
      createMintToInstruction(DEVUSDC_MINT, userDevUsdcAta, manager.publicKey, 300_000000n),
    ),
    [manager],
  );
  const devUsdcAfterMint = await getAccount(connection, userDevUsdcAta);
  console.log("user devUSDC balance after mint:", (Number(devUsdcAfterMint.amount) / 10 ** DEVUSDC.decimals).toFixed(6));

  const program = buildReadOnlyProgram(connection) as unknown as anchor.Program<anchor.Idl>;

  console.log("\n=== CREATE RESERVE (single-asset devUSDC, mirrors the real '123'/ABC scenario) ===");
  const addresses = await deriveNewReserveAddresses(program, programId);
  console.log("new reserveId:", addresses.reserveId.toString(), "address:", addresses.reserve.toBase58());
  const metadataUri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Corrective Pass Verify", ticker: "FIXV", description: "Verification-only Reserve.", category: "Custom" }))}`;
  const createIx = await buildCreateReserveInstruction(program, addresses, user.publicKey, {
    metadataUri,
    mintFeeBps: 50,
    redemptionFeeBps: 0,
    tvlFeeBps: 100,
    managerFeeShareBps: 8000,
    protocolFeeShareBps: 2000,
    feeDestination: user.publicKey,
  });
  const devUsdcAsset = deriveReserveAssetAddresses(addresses.reserve, DEVUSDC_MINT, programId);
  const initAssetIx = await buildInitializeReserveAssetInstruction(program, addresses, devUsdcAsset, user.publicKey, 10000);
  const createSig = await sendAndConfirmTransaction(connection, new Transaction().add(createIx, initAssetIx), [user]);
  console.log("CREATE tx:", createSig);

  console.log("\n=== SEED RESERVE with 100 devUSDC -> 100 Reserve Tokens ===");
  const seedIx = await buildSeedReserveInstruction(program, addresses, [devUsdcAsset], user.publicKey, [100_000000n], 100_000000n);
  const seedSig = await sendAndConfirmTransaction(connection, new Transaction().add(seedIx), [user]);
  console.log("SEED tx:", seedSig);

  await reportDtrView("AFTER SEED (before Buy)", addresses.reserve);
  const userRtAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, user.publicKey);
  const rtAfterSeed = await getAccount(connection, userRtAta);
  const devUsdcAfterSeed = await getAccount(connection, userDevUsdcAta);
  console.log("  user Reserve Token balance:", (Number(rtAfterSeed.amount) / 1e6).toFixed(6), " user devUSDC balance:", (Number(devUsdcAfterSeed.amount) / 1e6).toFixed(6));

  console.log("\n=== BUY: 10 devUSDC (this is the exact action that failed with 'unknown signer' before the fix) ===");
  const buyResp = await callSwapSign({
    action: "buy-devusdc",
    reserve: addresses.reserve.toBase58(),
    userPubkey: user.publicKey.toBase58(),
    assetMints: [DEVUSDC_MINT.toBase58()],
    devUsdcAmountRaw: "10000000",
  });
  if (!buyResp.transactionBase64) throw new Error("Buy failed to build: " + buyResp.error);
  const buyTx = Transaction.from(Buffer.from(buyResp.transactionBase64, "base64"));
  console.log("  Buy tx required signers:", buyTx.signatures.map((s) => s.publicKey.toBase58()));
  buyTx.partialSign(user);
  const buySig = await connection.sendRawTransaction(buyTx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(buySig, "confirmed");
  console.log("BUY tx signature:", buySig);

  await reportDtrView("AFTER BUY", addresses.reserve);
  const rtAfterBuy = await getAccount(connection, userRtAta);
  const devUsdcAfterBuy = await getAccount(connection, userDevUsdcAta);
  console.log("  user Reserve Token balance:", (Number(rtAfterBuy.amount) / 1e6).toFixed(6), " user devUSDC balance:", (Number(devUsdcAfterBuy.amount) / 1e6).toFixed(6));

  console.log("\n=== SELL: redeem half the user's Reserve Tokens ===");
  const toRedeem = rtAfterBuy.amount / 2n;
  const sellResp = await callSwapSign({
    action: "sell",
    reserve: addresses.reserve.toBase58(),
    userPubkey: user.publicKey.toBase58(),
    assetMints: [DEVUSDC_MINT.toBase58()],
    reserveTokensToRedeem: toRedeem.toString(),
  });
  if (!sellResp.transactionBase64) throw new Error("Sell failed to build: " + sellResp.error);
  const sellTx = Transaction.from(Buffer.from(sellResp.transactionBase64, "base64"));
  console.log("  Sell tx required signers:", sellTx.signatures.map((s) => s.publicKey.toBase58()));
  sellTx.partialSign(user);
  const sellSig = await connection.sendRawTransaction(sellTx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sellSig, "confirmed");
  console.log("SELL tx signature:", sellSig);

  await reportDtrView("AFTER SELL", addresses.reserve);
  const rtAfterSell = await getAccount(connection, userRtAta);
  const devUsdcAfterSell = await getAccount(connection, userDevUsdcAta);
  console.log("  user Reserve Token balance:", (Number(rtAfterSell.amount) / 1e6).toFixed(6), " user devUSDC balance:", (Number(devUsdcAfterSell.amount) / 1e6).toFixed(6));

  console.log("\n=== EXPLORER LINKS ===");
  console.log("Create:", `https://explorer.solana.com/tx/${createSig}?cluster=devnet`);
  console.log("Seed:  ", `https://explorer.solana.com/tx/${seedSig}?cluster=devnet`);
  console.log("Buy:   ", `https://explorer.solana.com/tx/${buySig}?cluster=devnet`);
  console.log("Sell:  ", `https://explorer.solana.com/tx/${sellSig}?cluster=devnet`);
  console.log("Reserve address:", `https://explorer.solana.com/address/${addresses.reserve.toBase58()}?cluster=devnet`);
  console.log("Throwaway user wallet:", `https://explorer.solana.com/address/${user.publicKey.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error("Verification failed:", e);
  process.exit(1);
});
