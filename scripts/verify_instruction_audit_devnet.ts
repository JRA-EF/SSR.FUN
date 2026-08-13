// Live DevNet verification for the ssr_protocol instruction-naming audit
// (see docs/project/DECISION_LOG.md for the DEC entry this supports).
//
// No instruction was renamed by this audit -- all 23 names were already
// clear and consistent. This script exists purely to prove, with real
// signed transactions, that each of the 21 safely-re-runnable instructions
// actually executes against the live DevNet program and to collect real
// signatures for the DevNet checklist / Solscan verification pass.
// `initialize_protocol` (one-time genesis, already run) and
// `update_protocol_config` (a shared, already-correctly-configured
// protocol-wide singleton -- deliberately not re-touched here) are cited
// from existing historical evidence instead of being re-executed.
//
// Creates one disposable, single-purpose Reserve, walks it through its full
// lifecycle (create -> seed -> buy -> manage -> wind down -> close), then
// writes every real signature to scripts/.audit-signatures.json for the
// next pass (Solscan verification) to consume.
//
// Usage (from repo root):
//   export PATH="$HOME/.cargo/bin:/c/devtools/mingw64/bin:/c/devtools/solana/solana-release/bin:$PATH"
//   export TS_NODE_PROJECT="scripts/tsconfig.json"
//   npx ts-node --require ts-node/register scripts/verify_instruction_audit_devnet.ts
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
  findDelegate,
  findMintAuthority,
  findProtocolConfig,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
  buildAddDelegateInstruction,
  buildUpdateDelegatePermissionsInstruction,
  buildRemoveDelegateInstruction,
  buildAddReserveAssetActiveInstruction,
  buildFundNewReserveAssetInstruction,
  buildRemoveReserveAssetInstruction,
  buildUpdateTargetsInstruction,
  buildCollectFeesInstruction,
  buildInitiateWindDownInstruction,
  buildCloseReserveInstruction,
} from "../packages/sdk/src";

const RPC_URL = process.env.SCRIPT_RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const program = buildReadOnlyProgram(connection) as any;

const MINT_X = new PublicKey(DEVNET_FIXTURES.mints.mintX.address); // 6 decimals
const MINT_Y = new PublicKey(DEVNET_FIXTURES.mints.mintY.address); // 6 decimals
const MINT_Z = new PublicKey(DEVNET_FIXTURES.mints.mintZ.address); // 9 decimals

const signatures: Record<string, string> = {};
const OUT_PATH = path.resolve(__dirname, "audit-signatures.raw.json");

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

async function send(tx: Transaction, signers: Keypair[], instructionName: string, label: string): Promise<string> {
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  console.log(`  [${label}] ${instructionName} -> ${sig}`);
  if (!signatures[instructionName]) signatures[instructionName] = sig; // keep the FIRST signature per instruction name
  fs.writeFileSync(OUT_PATH, JSON.stringify(signatures, null, 2)); // written after every step so a partial/interrupted run keeps what it already captured
  return sig;
}

async function mintTo(owner: PublicKey, mint: PublicKey, rawAmount: bigint) {
  await mintTestAssetsHandler(
    { method: "POST", headers: {}, body: { userPubkey: owner.toBase58(), mints: [{ mint: mint.toBase58(), rawAmount: rawAmount.toString() }] } } as any,
    mockRes() as any,
  );
}

async function main() {
  const deployerSecret = JSON.parse(
    fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"),
  );
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const manager = Keypair.generate();
  const newManager = Keypair.generate();
  const delegateWallet = Keypair.generate().publicKey; // never needs to sign -- root manager grants/updates/removes it

  console.log(`manager: ${manager.publicKey.toBase58()}`);
  console.log(`newManager: ${newManager.publicKey.toBase58()}`);
  console.log(`delegateWallet (data only, never signs): ${delegateWallet.toBase58()}`);

  await send(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: manager.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: newManager.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    ),
    [deployer],
    "(setup) fund manager + newManager",
    "setup",
  );

  await mintTo(manager.publicKey, MINT_X, 1000n * 1_000_000n);
  await mintTo(manager.publicKey, MINT_Y, 1000n * 1_000_000n);
  console.log("manager funded with mockX/mockY test assets.");

  // ============================================================
  // 1. create_reserve + initialize_reserve_asset x2 + seed_reserve
  // ============================================================
  console.log("\n--- create_reserve / initialize_reserve_asset / seed_reserve ---");
  const assets = [
    { mint: MINT_X.toBase58(), weightBps: 6000, seedWeightFraction: 0.6, decimals: 6 },
    { mint: MINT_Y.toBase58(), weightBps: 4000, seedWeightFraction: 0.4, decimals: 6 },
  ];
  const createResult = await createReserveOnChain({
    connection,
    wallet: fakeWallet(manager),
    metadataUri: "https://ssr.fun/audit-fixture/audit-test-reserve.json",
    mintFeeBps: 50, // 0.5% -- real fee income for collect_fees to have something to collect
    tvlFeeBps: 0,
    feeDestination: manager.publicKey,
    assets,
    seedTotalUsd: 10,
    onProgress: (step) => console.log(`  step: ${step}`),
  });
  signatures["create_reserve"] = createResult.transactions.createAndRegister!;
  signatures["initialize_reserve_asset"] = createResult.transactions.createAndRegister!;
  signatures["seed_reserve"] = createResult.transactions.seed!;
  console.log(`  create_reserve/initialize_reserve_asset -> ${createResult.transactions.createAndRegister}`);
  console.log(`  seed_reserve -> ${createResult.transactions.seed}`);

  const reserve = new PublicKey(createResult.reserve);
  const reserveTokenMint = new PublicKey(createResult.reserveTokenMint);
  const [protocolConfigPda] = findProtocolConfig(programId);
  const [vaultAuthorityPda] = findVaultAuthority(reserve, programId);
  const [mintAuthorityPda] = findMintAuthority(reserve, programId);
  console.log(`Reserve: ${createResult.reserve}`);
  console.log(`Reserve Token mint: ${createResult.reserveTokenMint}`);

  // ============================================================
  // 2. mint_reserve_tokens_in_kind (Buy)
  // ============================================================
  console.log("\n--- mint_reserve_tokens_in_kind ---");
  const [reserveAssetX] = findReserveAsset(reserve, MINT_X, programId);
  const [vaultX] = findReserveVault(reserve, MINT_X, programId);
  const [reserveAssetY] = findReserveAsset(reserve, MINT_Y, programId);
  const [vaultY] = findReserveVault(reserve, MINT_Y, programId);
  const managerXAta = getAssociatedTokenAddressSync(MINT_X, manager.publicKey);
  const managerYAta = getAssociatedTokenAddressSync(MINT_Y, manager.publicKey);
  const managerRtAta = getAssociatedTokenAddressSync(reserveTokenMint, manager.publicKey);

  const mintIx = await program.methods
    .mintReserveTokensInKind(new BN(100_000), new BN(0), [new BN(100_000_000), new BN(100_000_000)])
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve,
      reserveTokenMint,
      mintAuthority: mintAuthorityPda,
      depositorReserveTokenAccount: managerRtAta,
      depositor: manager.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: reserveAssetX, isWritable: true, isSigner: false },
      { pubkey: vaultX, isWritable: true, isSigner: false },
      { pubkey: managerXAta, isWritable: true, isSigner: false },
      { pubkey: MINT_X, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: reserveAssetY, isWritable: true, isSigner: false },
      { pubkey: vaultY, isWritable: true, isSigner: false },
      { pubkey: managerYAta, isWritable: true, isSigner: false },
      { pubkey: MINT_Y, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(mintIx), [manager], "mint_reserve_tokens_in_kind", "buy");
  const rtBalAfterBuy = await getAccount(connection, managerRtAta);
  console.log(`  manager Reserve Token balance after buy: ${rtBalAfterBuy.amount}`);

  // ============================================================
  // 3. update_targets (60/40 -> 50/50)
  // ============================================================
  console.log("\n--- update_targets ---");
  const [actingDelegateManager] = findDelegate(reserve, manager.publicKey, programId);
  const updateTargetsIx = await buildUpdateTargetsInstruction(
    program, programId, reserve, manager.publicKey, actingDelegateManager, [MINT_X, MINT_Y], [5000, 5000],
  );
  await send(new Transaction().add(updateTargetsIx), [manager], "update_targets", "rebalance");

  // ============================================================
  // 4-6. add_delegate / update_delegate_permissions / remove_delegate
  // ============================================================
  console.log("\n--- add_delegate / update_delegate_permissions / remove_delegate ---");
  const UPDATE_METADATA_FLAG = 1 << 0;
  const addDelegateIx = await buildAddDelegateInstruction(program, programId, reserve, manager.publicKey, actingDelegateManager, delegateWallet, UPDATE_METADATA_FLAG, false);
  await send(new Transaction().add(addDelegateIx), [manager], "add_delegate", "delegates");

  const updateDelegateIx = await buildUpdateDelegatePermissionsInstruction(program, programId, reserve, manager.publicKey, actingDelegateManager, delegateWallet, 0);
  await send(new Transaction().add(updateDelegateIx), [manager], "update_delegate_permissions", "delegates");

  const removeDelegateIx = await buildRemoveDelegateInstruction(program, programId, reserve, manager.publicKey, actingDelegateManager, delegateWallet);
  await send(new Transaction().add(removeDelegateIx), [manager], "remove_delegate", "delegates");

  // ============================================================
  // 7-8. add_reserve_asset_active + remove_reserve_asset (clean round trip)
  // ============================================================
  console.log("\n--- add_reserve_asset_active + remove_reserve_asset (round 1, clean removal) ---");
  const addZIx1 = await buildAddReserveAssetActiveInstruction(program, programId, reserve, manager.publicKey, actingDelegateManager, MINT_Z, 0);
  await send(new Transaction().add(addZIx1), [manager], "add_reserve_asset_active", "composition");

  const removeZIx = await buildRemoveReserveAssetInstruction(program, programId, reserve, manager.publicKey, manager.publicKey, actingDelegateManager, MINT_Z);
  await send(new Transaction().add(removeZIx), [manager], "remove_reserve_asset", "composition");

  // ============================================================
  // 9-10. add_reserve_asset_active (round 2, kept) + fund_new_reserve_asset
  // ============================================================
  console.log("\n--- add_reserve_asset_active (round 2) + fund_new_reserve_asset ---");
  const addZIx2 = await buildAddReserveAssetActiveInstruction(program, programId, reserve, manager.publicKey, actingDelegateManager, MINT_Z, 0);
  await send(new Transaction().add(addZIx2), [manager], "(setup) add_reserve_asset_active round 2", "composition");

  await mintTo(manager.publicKey, MINT_Z, 2n * 1_000_000_000n); // 2.0 mockZ, 9 decimals
  const fundZIx = await buildFundNewReserveAssetInstruction(program, programId, reserve, manager.publicKey, MINT_Z, 2_000_000_000n);
  await send(new Transaction().add(fundZIx), [manager], "fund_new_reserve_asset", "composition");

  // ============================================================
  // 11. update_metadata
  // ============================================================
  console.log("\n--- update_metadata ---");
  const updateMetadataIx = await program.methods
    .updateMetadata("https://ssr.fun/audit-fixture/audit-test-reserve-v2.json")
    .accounts({ reserve, delegate: actingDelegateManager, signer: manager.publicKey })
    .instruction();
  await send(new Transaction().add(updateMetadataIx), [manager], "update_metadata", "metadata");

  // ============================================================
  // 12. transfer_reserve_manager
  // ============================================================
  console.log("\n--- transfer_reserve_manager ---");
  const transferIx = await program.methods
    .transferReserveManager(newManager.publicKey)
    .accounts({ reserve, manager: manager.publicKey })
    .instruction();
  await send(new Transaction().add(transferIx), [manager], "transfer_reserve_manager", "authority");

  const reserveAfterTransfer = await program.account.reserve.fetch(reserve);
  console.log(`  Reserve.manager after transfer: ${(reserveAfterTransfer.manager as PublicKey).toBase58()} (expect ${newManager.publicKey.toBase58()})`);
  const [actingDelegateNewManager] = findDelegate(reserve, newManager.publicKey, programId);

  // ============================================================
  // 13-14. pause_reserve / unpause_reserve (signed by newManager now)
  // ============================================================
  console.log("\n--- pause_reserve / unpause_reserve ---");
  const pauseIx = await program.methods
    .pauseReserve()
    .accounts({ reserve, delegate: actingDelegateNewManager, signer: newManager.publicKey })
    .instruction();
  await send(new Transaction().add(pauseIx), [newManager], "pause_reserve", "lifecycle");

  const unpauseIx = await program.methods
    .unpauseReserve()
    .accounts({ reserve, delegate: actingDelegateNewManager, signer: newManager.publicKey })
    .instruction();
  await send(new Transaction().add(unpauseIx), [newManager], "unpause_reserve", "lifecycle");

  // ============================================================
  // 15. accrue_fees (permissionless)
  // ============================================================
  console.log("\n--- accrue_fees ---");
  const accrueIx = await program.methods
    .accrueFees()
    .accounts({ reserve, reserveTokenMint })
    .instruction();
  await send(new Transaction().add(accrueIx), [newManager], "accrue_fees", "fees");

  // ============================================================
  // 16. collect_fees (permissionless; real pending fees from the Buy above)
  // ============================================================
  console.log("\n--- collect_fees ---");
  const protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
  const protocolFeeDestination = protocolConfig.defaultProtocolFeeDestination as PublicKey;
  const collectIx = await buildCollectFeesInstruction(program, programId, reserve, reserveTokenMint, manager.publicKey, protocolFeeDestination, newManager.publicKey);
  await send(new Transaction().add(collectIx), [newManager], "collect_fees", "fees");

  // ============================================================
  // 17. record_rebalance (attestation only)
  // ============================================================
  console.log("\n--- record_rebalance ---");
  const reserveForRebalance = await program.account.reserve.fetch(reserve);
  const assetCount = reserveForRebalance.assetCount as number;
  const remainingForRecord = [
    { pubkey: reserveAssetX, isWritable: false, isSigner: false },
    { pubkey: vaultX, isWritable: false, isSigner: false },
    { pubkey: reserveAssetY, isWritable: false, isSigner: false },
    { pubkey: vaultY, isWritable: false, isSigner: false },
    { pubkey: findReserveAsset(reserve, MINT_Z, programId)[0], isWritable: false, isSigner: false },
    { pubkey: findReserveVault(reserve, MINT_Z, programId)[0], isWritable: false, isSigner: false },
  ];
  if (remainingForRecord.length / 2 !== assetCount) throw new Error(`asset_count mismatch: expected ${assetCount}, built ${remainingForRecord.length / 2}`);
  const vaultXBal = await getAccount(connection, vaultX);
  const vaultYBal = await getAccount(connection, vaultY);
  const vaultZBal = await getAccount(connection, findReserveVault(reserve, MINT_Z, programId)[0]);
  const recordIx = await program.methods
    .recordRebalance([new BN(vaultXBal.amount.toString()), new BN(vaultYBal.amount.toString()), new BN(vaultZBal.amount.toString())], "Instruction audit attestation -- no external trade occurred, this is a naming/wiring verification pass.")
    .accounts({ reserve, delegate: actingDelegateNewManager, signer: newManager.publicKey })
    .remainingAccounts(remainingForRecord)
    .instruction();
  await send(new Transaction().add(recordIx), [newManager], "record_rebalance", "rebalance");

  // ============================================================
  // 18. redeem_reserve_tokens_in_kind (Sell) -- FULL redemption, drains every vault to 0
  // ============================================================
  console.log("\n--- redeem_reserve_tokens_in_kind (full redemption, ahead of wind-down) ---");
  const rtBalBeforeRedeem = await getAccount(connection, managerRtAta);
  const redeemIx = await program.methods
    .redeemReserveTokensInKind(new BN(rtBalBeforeRedeem.amount.toString()), [new BN(0), new BN(0), new BN(0)])
    .accounts({
      reserve,
      reserveTokenMint,
      vaultAuthority: vaultAuthorityPda,
      redeemerReserveTokenAccount: managerRtAta,
      redeemer: manager.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: reserveAssetX, isWritable: true, isSigner: false },
      { pubkey: vaultX, isWritable: true, isSigner: false },
      { pubkey: managerXAta, isWritable: true, isSigner: false },
      { pubkey: MINT_X, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: reserveAssetY, isWritable: true, isSigner: false },
      { pubkey: vaultY, isWritable: true, isSigner: false },
      { pubkey: managerYAta, isWritable: true, isSigner: false },
      { pubkey: MINT_Y, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: findReserveAsset(reserve, MINT_Z, programId)[0], isWritable: true, isSigner: false },
      { pubkey: findReserveVault(reserve, MINT_Z, programId)[0], isWritable: true, isSigner: false },
      { pubkey: getAssociatedTokenAddressSync(MINT_Z, manager.publicKey), isWritable: true, isSigner: false },
      { pubkey: MINT_Z, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(redeemIx), [manager], "redeem_reserve_tokens_in_kind", "sell");
  const supplyAfterRedeem = await connection.getTokenSupply(reserveTokenMint);
  console.log(`  Reserve Token supply after full redemption: ${supplyAfterRedeem.value.amount} (expect 0)`);

  // ============================================================
  // 19-20. initiate_wind_down / close_reserve
  // ============================================================
  console.log("\n--- initiate_wind_down / close_reserve ---");
  const initWdIx = await buildInitiateWindDownInstruction(program, reserve, newManager.publicKey);
  await send(new Transaction().add(initWdIx), [newManager], "initiate_wind_down", "wind-down");

  const closeIx = await buildCloseReserveInstruction(program, programId, reserve, reserveTokenMint, newManager.publicKey, [MINT_X, MINT_Y, MINT_Z]);
  await send(new Transaction().add(closeIx), [newManager], "close_reserve", "wind-down");

  const reserveInfoAfterClose = await connection.getAccountInfo(reserve);
  console.log(`  Reserve account after close: ${reserveInfoAfterClose === null ? "null (closed, as expected)" : "STILL EXISTS -- FAIL"}`);
  if (reserveInfoAfterClose !== null) throw new Error("Reserve account was not actually closed.");

  // ============================================================
  // Summary
  // ============================================================
  fs.writeFileSync(OUT_PATH, JSON.stringify(signatures, null, 2));
  console.log(`\n=========================================================`);
  console.log(`ALL ${Object.keys(signatures).length} INSTRUCTION SIGNATURES CAPTURED.`);
  console.log(`Written to ${OUT_PATH}`);
  console.log(`=========================================================`);
  for (const [name, sig] of Object.entries(signatures)) {
    console.log(`${name.padEnd(32)} ${sig}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
