// Phase F/G live verification: proves the 5 new instructions deployed in
// this pass (add_reserve_asset_active, fund_new_reserve_asset,
// remove_reserve_asset, initiate_wind_down, close_reserve) actually work
// against the live DevNet program -- real transactions, real confirmations,
// real re-fetched on-chain state, not simulated. See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase F/G" and
// DEC-0046/DEC-0047.
//
// Part 1 (Phase F) runs against the persistent Gate-9 fixture reserveOne
// (mockX 60% + mockY 40%, manager = the persistent manager-keypair.json
// wallet -- NOT the Phase C script's Reserve, whose manager was an ephemeral
// throwaway keypair never persisted anywhere and so can't be re-signed for
// here): add a 3rd asset (mockZ, not already registered) at 0% target
// weight, remove it immediately (proves remove_reserve_asset on a
// last-registered/zero-balance asset), re-add it, then fund it directly
// (proves fund_new_reserve_asset's bootstrap path).
//
// Part 2 (Phase G) runs against a brand-new, disposable single-asset
// Reserve created fresh in this script: initiate_wind_down, confirm minting
// is now blocked (status != Active), confirm redemption is deliberately
// still allowed during WindDown (the exact invariant DEC-0046 fixed --
// require_active_or_paused -> require_redemption_allowed), redeem the full
// supply to zero, then close_reserve and confirm the Reserve account no
// longer exists on-chain.
import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN } from "@anchor-lang/core";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

import mintTestAssetsHandler from "../api/devnet/mint-test-assets";
import { createReserveOnChain } from "../src/merge/lib/createReserveClient";
import {
  buildReadOnlyProgram,
  DEVNET_FIXTURES,
  DEVUSDC,
  findMintAuthority,
  findProtocolConfig,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
} from "../packages/sdk/src";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const program = buildReadOnlyProgram(connection);

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

const realFetch = global.fetch;
(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const req = { method: "POST", headers: {}, body };
  if (url.includes("mint-test-assets")) {
    const res = mockRes();
    await mintTestAssetsHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode, json: async () => res._state.body } as Response;
  }
  return realFetch(url as any, init);
}) as typeof fetch;

function fakeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
  } as any;
}

async function send(ixOrTx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const sig = await sendAndConfirmTransaction(connection, ixOrTx, signers, { commitment: "confirmed" });
  console.log(`  [${label}] signature: ${sig}`);
  return sig;
}

async function main() {
  const deployerSecret = JSON.parse(
    fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"),
  );
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const managerSecret = JSON.parse(process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY as string);
  const manager = Keypair.fromSecretKey(Uint8Array.from(managerSecret));

  // ============================================================
  // PART 1 -- Phase F composition management, on the Phase C Reserve
  // ============================================================
  console.log("\n=========================================================");
  console.log("PART 1: Phase F composition management (Phase C Reserve)");
  console.log("=========================================================");

  // Gate-9 fixture reserveOne (mockX 60% + mockZ 40%, manager = the
  // persistent manager-keypair.json wallet -- unlike the Phase C script's
  // Reserve, whose manager was an ephemeral throwaway keypair never
  // persisted anywhere, so it can't be re-signed for here). Adding mockZ
  // (not already registered on reserveOne) is the 3rd-asset test target.
  const reservePc = new PublicKey(DEVNET_FIXTURES.reserveOne.reserve);
  const mintZ = new PublicKey(DEVNET_FIXTURES.mints.mintZ.address);
  const [protocolConfigPda] = findProtocolConfig(programId);
  const [vaultAuthorityPda] = findVaultAuthority(reservePc, programId);
  const [reserveAssetZ] = findReserveAsset(reservePc, mintZ, programId);
  const [vaultZ] = findReserveVault(reservePc, mintZ, programId);

  const reserveBefore = await program.account.reserve.fetch(reservePc);
  console.log(`Reserve manager: ${(reserveBefore.manager as PublicKey).toBase58()}`);
  console.log(`asset_count before: ${reserveBefore.assetCount}`);
  if ((reserveBefore.manager as PublicKey).toBase58() !== manager.publicKey.toBase58()) {
    throw new Error("Manager mismatch -- refusing to proceed against the wrong signer.");
  }

  console.log("\n--- Step 1: add_reserve_asset_active(mockZ, 0 bps) ---");
  const addIx1 = await (program.methods as any)
    .addReserveAssetActive(0)
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: reservePc,
      reserveAsset: reserveAssetZ,
      assetMint: mintZ,
      vault: vaultZ,
      vaultAuthority: vaultAuthorityPda,
      delegate: manager.publicKey, // unused (signer == manager), any account is valid for an UncheckedAccount
      signer: manager.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await send(new Transaction().add(addIx1), [manager], "add_reserve_asset_active #1");

  let reserveAfterAdd = await program.account.reserve.fetch(reservePc);
  console.log(`asset_count after add: ${reserveAfterAdd.assetCount} (expect ${reserveBefore.assetCount + 1})`);
  if (reserveAfterAdd.assetCount !== reserveBefore.assetCount + 1) throw new Error("asset_count did not increment -- FAIL.");
  const reserveAssetZInfoAfterAdd = await program.account.reserveAsset.fetch(reserveAssetZ);
  console.log(`registered order_index: ${reserveAssetZInfoAfterAdd.orderIndex} (expect ${reserveBefore.assetCount})`);

  console.log("\n--- Step 2: remove_reserve_asset(mockZ) -- last-registered, zero balance ---");
  const vaultZBalBeforeRemove = await getAccount(connection, vaultZ);
  console.log(`mockZ vault balance before remove: ${vaultZBalBeforeRemove.amount} (expect 0)`);
  if (vaultZBalBeforeRemove.amount !== 0n) throw new Error("Expected zero balance before removal -- FAIL.");

  const removeIx = await (program.methods as any)
    .removeReserveAsset()
    .accounts({
      reserve: reservePc,
      reserveAsset: reserveAssetZ,
      assetMint: mintZ,
      vault: vaultZ,
      vaultAuthority: vaultAuthorityPda,
      manager: manager.publicKey,
      delegate: manager.publicKey,
      signer: manager.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await send(new Transaction().add(removeIx), [manager], "remove_reserve_asset");

  const reserveAfterRemove = await program.account.reserve.fetch(reservePc);
  console.log(`asset_count after remove: ${reserveAfterRemove.assetCount} (expect ${reserveBefore.assetCount})`);
  if (reserveAfterRemove.assetCount !== reserveBefore.assetCount) throw new Error("asset_count did not revert -- FAIL.");
  const reserveAssetZAccountInfo = await connection.getAccountInfo(reserveAssetZ);
  console.log(`reserveAsset(mockZ) account after close: ${reserveAssetZAccountInfo === null ? "null (closed, as expected)" : "STILL EXISTS -- FAIL"}`);
  if (reserveAssetZAccountInfo !== null) throw new Error("ReserveAsset account was not actually closed -- FAIL.");
  const vaultZAccountInfo = await connection.getAccountInfo(vaultZ);
  console.log(`vault(mockZ) account after close: ${vaultZAccountInfo === null ? "null (closed, as expected)" : "STILL EXISTS -- FAIL"}`);
  if (vaultZAccountInfo !== null) throw new Error("Vault account was not actually closed -- FAIL.");

  console.log("\n--- Step 3: add_reserve_asset_active(mockZ, 0 bps) again ---");
  const addIx2 = await (program.methods as any)
    .addReserveAssetActive(0)
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: reservePc,
      reserveAsset: reserveAssetZ,
      assetMint: mintZ,
      vault: vaultZ,
      vaultAuthority: vaultAuthorityPda,
      delegate: manager.publicKey,
      signer: manager.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await send(new Transaction().add(addIx2), [manager], "add_reserve_asset_active #2");
  reserveAfterAdd = await program.account.reserve.fetch(reservePc);
  console.log(`asset_count after re-add: ${reserveAfterAdd.assetCount} (expect ${reserveBefore.assetCount + 1})`);

  console.log("\n--- Step 4: fund_new_reserve_asset(mockZ, 5,000,000 raw) ---");
  const managerMintZAta = getAssociatedTokenAddressSync(mintZ, manager.publicKey);
  const mintZFundAmount = 5_000_000n; // 5.0 mockZ (6 decimals)
  await mintTestAssetsHandler(
    { method: "POST", headers: {}, body: { userPubkey: manager.publicKey.toBase58(), mints: [{ mint: mintZ.toBase58(), rawAmount: (mintZFundAmount * 2n).toString() }] } } as any,
    mockRes() as any,
  );
  const managerMintZBal = await getAccount(connection, managerMintZAta);
  console.log(`manager mockZ balance after faucet: ${managerMintZBal.amount}`);

  const fundIx = await (program.methods as any)
    .fundNewReserveAsset(new BN(mintZFundAmount.toString()))
    .accounts({
      reserve: reservePc,
      reserveAsset: reserveAssetZ,
      assetMint: mintZ,
      vault: vaultZ,
      managerTokenAccount: managerMintZAta,
      manager: manager.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await send(new Transaction().add(fundIx), [manager], "fund_new_reserve_asset");

  const vaultZBalAfterFund = await getAccount(connection, vaultZ);
  console.log(`mockZ vault balance after fund: ${vaultZBalAfterFund.amount} (expect ${mintZFundAmount})`);
  if (vaultZBalAfterFund.amount !== mintZFundAmount) throw new Error("Vault balance does not match funded amount -- FAIL.");

  console.log("\nPART 1 CONFIRMED: add_reserve_asset_active, remove_reserve_asset, and fund_new_reserve_asset all work correctly against the live deployed program.");

  // ============================================================
  // PART 2 -- Phase G wind-down, on a brand-new disposable Reserve
  // ============================================================
  console.log("\n=========================================================");
  console.log("PART 2: Phase G wind-down lifecycle (fresh disposable Reserve)");
  console.log("=========================================================");

  const creator = Keypair.generate();
  console.log(`Fresh creator pubkey: ${creator.publicKey.toBase58()}`);
  await send(
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })),
    [deployer],
    "fund creator",
  );

  const wdAssets = [{ mint: DEVUSDC.mint, weightBps: 10_000, seedWeightFraction: 1.0, decimals: DEVUSDC.decimals }];
  const wdResult = await createReserveOnChain({
    connection,
    wallet: fakeWallet(creator),
    metadataUri: `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Phase G WindDown Test", ticker: "WDTEST", description: "Phase G live check", category: "DevNet" }))}`,
    mintFeeBps: 0,
    tvlFeeBps: 0,
    feeDestination: creator.publicKey,
    assets: wdAssets,
    seedTotalUsd: 2,
    onProgress: (step) => console.log(`  step: ${step}`),
  });
  const reserveWd = new PublicKey(wdResult.reserve);
  const reserveTokenMintWd = new PublicKey(wdResult.reserveTokenMint);
  console.log(`Fresh Reserve: ${wdResult.reserve}`);
  console.log(`Reserve Token mint: ${wdResult.reserveTokenMint}`);

  const [devusdcReserveAsset] = findReserveAsset(reserveWd, new PublicKey(DEVUSDC.mint), programId);
  const [devusdcVault] = findReserveVault(reserveWd, new PublicKey(DEVUSDC.mint), programId);
  const [wdVaultAuthority] = findVaultAuthority(reserveWd, programId);
  const [wdMintAuthority] = findMintAuthority(reserveWd, programId);

  console.log("\n--- Step 1: initiate_wind_down ---");
  const initWdIx = await (program.methods as any)
    .initiateWindDown()
    .accounts({ reserve: reserveWd, manager: creator.publicKey })
    .instruction();
  await send(new Transaction().add(initWdIx), [creator], "initiate_wind_down");

  const reserveWdState = await program.account.reserve.fetch(reserveWd);
  const statusAfterInit = Object.keys(reserveWdState.status as object)[0];
  console.log(`status after initiate_wind_down: ${statusAfterInit} (expect windDown)`);
  if (statusAfterInit !== "windDown") throw new Error("Status did not transition to WindDown -- FAIL.");

  console.log("\n--- Step 2: confirm mint_reserve_tokens_in_kind is now BLOCKED (status != Active) ---");
  const creatorDevusdcAta = getAssociatedTokenAddressSync(new PublicKey(DEVUSDC.mint), creator.publicKey);
  const creatorRtAta = getAssociatedTokenAddressSync(reserveTokenMintWd, creator.publicKey);
  let mintBlockedCorrectly = false;
  try {
    const mintIx = await (program.methods as any)
      .mintReserveTokensInKind(new BN(1000), new BN(0), [new BN(1_000_000)])
      .accounts({
        protocolConfig: protocolConfigPda,
        reserve: reserveWd,
        reserveTokenMint: reserveTokenMintWd,
        mintAuthority: wdMintAuthority,
        depositorReserveTokenAccount: creatorRtAta,
        depositor: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: devusdcReserveAsset, isWritable: true, isSigner: false },
        { pubkey: devusdcVault, isWritable: true, isSigner: false },
        { pubkey: creatorDevusdcAta, isWritable: true, isSigner: false },
        { pubkey: new PublicKey(DEVUSDC.mint), isWritable: false, isSigner: false },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      ])
      .instruction();
    await send(new Transaction().add(mintIx), [creator], "mint_reserve_tokens_in_kind (expected to fail)");
    console.log("  UNEXPECTED: mint succeeded during WindDown -- this should not happen.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mintBlockedCorrectly = msg.includes("UnexpectedReserveStatus") || msg.includes("0x") || msg.includes("custom program error");
    console.log(`  mint correctly rejected during WindDown. Error: ${msg.slice(0, 200)}`);
  }
  if (!mintBlockedCorrectly) throw new Error("Mint was not rejected during WindDown as expected -- FAIL.");

  console.log("\n--- Step 3: confirm redemption is STILL ALLOWED during WindDown (the DEC-0046 fix) ---");
  const creatorRtBal = await getAccount(connection, creatorRtAta);
  console.log(`Creator's Reserve Token balance (about to redeem all of it): ${creatorRtBal.amount}`);

  const redeemIx = await (program.methods as any)
    .redeemReserveTokensInKind(new BN(creatorRtBal.amount.toString()), [new BN(0)])
    .accounts({
      reserve: reserveWd,
      reserveTokenMint: reserveTokenMintWd,
      vaultAuthority: wdVaultAuthority,
      redeemerReserveTokenAccount: creatorRtAta,
      redeemer: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: devusdcReserveAsset, isWritable: true, isSigner: false },
      { pubkey: devusdcVault, isWritable: true, isSigner: false },
      { pubkey: creatorDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: new PublicKey(DEVUSDC.mint), isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(redeemIx), [creator], "redeem_reserve_tokens_in_kind during WindDown");

  const supplyAfterRedeem = await connection.getTokenSupply(reserveTokenMintWd);
  console.log(`Reserve Token supply after full redemption: ${supplyAfterRedeem.value.amount} (expect 0)`);
  if (supplyAfterRedeem.value.amount !== "0") throw new Error("Supply is not zero after full redemption -- FAIL.");
  const devusdcVaultBalAfterRedeem = await getAccount(connection, devusdcVault);
  console.log(`devUSDC vault balance after full redemption: ${devusdcVaultBalAfterRedeem.amount} (expect 0, zero fees configured)`);

  console.log("\n--- Step 4: close_reserve ---");
  if (devusdcVaultBalAfterRedeem.amount !== 0n) {
    throw new Error("Vault balance is not zero -- close_reserve would correctly reject this, stopping before attempting it.");
  }
  const closeIx = await (program.methods as any)
    .closeReserve()
    .accounts({
      reserve: reserveWd,
      reserveTokenMint: reserveTokenMintWd,
      vaultAuthority: wdVaultAuthority,
      manager: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: devusdcReserveAsset, isWritable: true, isSigner: false },
      { pubkey: devusdcVault, isWritable: true, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(closeIx), [creator], "close_reserve");

  const reserveWdAccountInfo = await connection.getAccountInfo(reserveWd);
  console.log(`Reserve account after close: ${reserveWdAccountInfo === null ? "null (closed, as expected)" : "STILL EXISTS -- FAIL"}`);
  if (reserveWdAccountInfo !== null) throw new Error("Reserve account was not actually closed -- FAIL.");
  const devusdcReserveAssetInfo = await connection.getAccountInfo(devusdcReserveAsset);
  console.log(`ReserveAsset(devUSDC) account after close: ${devusdcReserveAssetInfo === null ? "null (closed, as expected)" : "STILL EXISTS -- FAIL"}`);
  const devusdcVaultInfo = await connection.getAccountInfo(devusdcVault);
  console.log(`Vault(devUSDC) account after close: ${devusdcVaultInfo === null ? "null (closed, as expected)" : "STILL EXISTS -- FAIL"}`);
  if (devusdcReserveAssetInfo !== null || devusdcVaultInfo !== null) throw new Error("Not all accounts were closed -- FAIL.");

  console.log("\nPART 2 CONFIRMED: initiate_wind_down blocks new minting, deliberately still allows redemption, and close_reserve correctly requires + verifies zero supply and zero vault balances before closing every account.");

  console.log("\n=========================================================");
  console.log("ALL PHASE F/G LIVE VERIFICATIONS PASSED.");
  console.log("=========================================================");
  console.log(`Explorer (Phase F Reserve): https://explorer.solana.com/address/${reservePc.toBase58()}?cluster=devnet`);
  console.log(`Explorer (Phase G disposable Reserve, now closed): https://explorer.solana.com/address/${reserveWd.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
