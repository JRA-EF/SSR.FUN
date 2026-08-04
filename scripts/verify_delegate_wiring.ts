// Live DevNet verification for Phase 4 (delegate frontend wiring) of the
// 2026-08-04 "complete the end-to-end SSR DevNet economy" corrective pass --
// see docs/project/DECISION_LOG.md. Exercises the REAL deployed program
// (2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW) with real signed
// transactions from real keypairs -- no wallet/Phantom involved (none is
// available in this environment), same pattern as every existing
// scripts/verify_*.ts. Never fabricates a signature or a passing result.
//
// Uses the persistent Gate-9 fixture Reserve One (reserve_id 9,
// GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C) and its two already-real,
// already-granted restricted delegates (see docs/protocol/DEVNET_FIXTURES.md):
//   - AKWHGN3EDPfkcpFhkG3EQcHBRY7eBFNCWNbV1osfDu7u -- UPDATE_TARGETS only
//   - 68gfCCwZRCXnyQN8MzEKykBhhenMKCqWxDC9oxS7TiBt -- PAUSE_RESERVE + UNPAUSE_RESERVE only
//
// What this proves, with real transaction signatures:
//   1. hasOnChainPermission's decoding matches the REAL on-chain permission
//      bitmask fetched for both fixture delegates.
//   2. The genuinely non-root UPDATE_TARGETS delegate can now actually
//      submit a real update_targets transaction end to end (executeUpdateTargets
//      previously always passed wallet.publicKey as the delegate-account
//      placeholder, which only ever accidentally worked for the ROOT
//      MANAGER -- this is the first time a real non-root delegate's call
//      through this code path has ever been exercised).
//   3. The PAUSE-only delegate's attempt at the SAME instruction is REJECTED
//      on-chain (permission gating genuinely enforced, not just "signing
//      works").
//   4. A full add_delegate -> update_delegate_permissions -> remove_delegate
//      cycle against a fresh, disposable delegate wallet, via the new SDK
//      builders/managementClient functions, with real before/after reads.
//
// Run: npx ts-node -P scripts/tsconfig.json scripts/verify_delegate_wiring.ts
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  buildReadOnlyProgram,
  buildAddDelegateInstruction,
  buildRemoveDelegateInstruction,
  buildUpdateDelegatePermissionsInstruction,
  buildUpdateTargetsInstruction,
  discoverDelegatesForReserve,
  fetchReserveOnChain,
  findDelegate,
} from "../packages/sdk/src";
import { hasOnChainPermission, PERMISSION_FLAGS } from "../src/merge/lib/onChainPermissions";

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW");
const RESERVE_ONE = new PublicKey("GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C");
const MINT_X = new PublicKey("2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu");
const MINT_Y = new PublicKey("9ERxFYyuNTMjsduY24MCp1bvUDz7PkhoycjBx76Zh8Lv");
const MINT_Z = new PublicKey("GqNfJAmAMBVrYbJ3az38kBBrz8vyYdoFpwYmRBJd6zoS");

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "devnet-fixtures", file), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) {
    passed += 1;
    console.log(`  OK   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}`);
  }
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const program = buildReadOnlyProgram(connection) as any;

  const manager = loadKeypair("manager-keypair.json");
  const delegateTargets = loadKeypair("delegateTargets-keypair.json");
  const delegatePause = loadKeypair("delegatePause-keypair.json");

  console.log("=== Step 1: real on-chain state ===");
  // docs/protocol/DEVNET_FIXTURES.md (2026-07-28) documents Reserve One as
  // 2-asset (mintX/mintY), but Phase F/G's live verification (DEC-0046/47,
  // 2026-07-29) added a 3rd asset (mintZ) to this exact persistent fixture
  // as part of proving add_reserve_asset_active/remove_reserve_asset -- the
  // doc was never updated afterward. Query the REAL current registered
  // asset count first rather than trusting the stale doc, and pass every
  // candidate mint that could plausibly be registered.
  const onChain = await fetchReserveOnChain(connection, PROGRAM_ID, RESERVE_ONE, [MINT_X, MINT_Y, MINT_Z]);
  check("Reserve One fetched", onChain !== null);
  if (!onChain) throw new Error("Reserve One not found on-chain -- cannot continue.");
  check("Reserve One manager matches fixture doc", onChain.manager === manager.publicKey.toBase58());
  console.log(`  Real registered assets: ${onChain.assets.map((a) => `${a.assetMint.slice(0, 8)}...(order ${a.orderIndex})`).join(", ")}`);

  const delegates = await discoverDelegatesForReserve(connection, PROGRAM_ID, RESERVE_ONE, [
    manager.publicKey,
    delegateTargets.publicKey,
    delegatePause.publicKey,
  ]);
  console.log(`  Fetched ${delegates.length} real delegate(s):`, delegates.map((d) => `${d.wallet.slice(0, 8)}... perms=${d.permissions}`));

  console.log("\n=== Step 2: hasOnChainPermission matches real fetched permissions ===");
  const onChainMeta = { manager: onChain.manager, delegatesOnChain: delegates };
  check(
    "UPDATE_TARGETS delegate: hasOnChainPermission(UPDATE_TARGETS) = true",
    hasOnChainPermission(onChainMeta, delegateTargets.publicKey.toBase58(), PERMISSION_FLAGS.UPDATE_TARGETS) === true,
  );
  check(
    "UPDATE_TARGETS delegate: hasOnChainPermission(MANAGE_LIQUIDITY_CONFIG) = false (not granted)",
    hasOnChainPermission(onChainMeta, delegateTargets.publicKey.toBase58(), PERMISSION_FLAGS.MANAGE_LIQUIDITY_CONFIG) === false,
  );
  check(
    "PAUSE-only delegate: hasOnChainPermission(PAUSE_RESERVE) = true",
    hasOnChainPermission(onChainMeta, delegatePause.publicKey.toBase58(), PERMISSION_FLAGS.PAUSE_RESERVE) === true,
  );
  check(
    "PAUSE-only delegate: hasOnChainPermission(UPDATE_TARGETS) = false (not granted)",
    hasOnChainPermission(onChainMeta, delegatePause.publicKey.toBase58(), PERMISSION_FLAGS.UPDATE_TARGETS) === false,
  );
  check("Root manager: hasOnChainPermission(anything) = true", hasOnChainPermission(onChainMeta, manager.publicKey.toBase58(), PERMISSION_FLAGS.MANAGE_LIQUIDITY_CONFIG) === true);

  console.log("\n=== Step 3: a genuine non-root delegate submits a REAL update_targets transaction ===");
  const orderedAssets = [...onChain.assets].sort((a, b) => a.orderIndex - b.orderIndex);
  const assetMintsInOrder = orderedAssets.map((a) => new PublicKey(a.assetMint));
  const currentWeights = orderedAssets.map((a) => a.targetWeightBps); // no-op: resubmit the SAME weights, so this script never changes this persistent fixture's economics
  const [delegateTargetsPda] = findDelegate(RESERVE_ONE, delegateTargets.publicKey, PROGRAM_ID);
  const updateIx = await buildUpdateTargetsInstruction(program, PROGRAM_ID, RESERVE_ONE, delegateTargets.publicKey, delegateTargetsPda, assetMintsInOrder, currentWeights);
  const updateTx = new Transaction().add(updateIx);
  updateTx.feePayer = delegateTargets.publicKey;
  try {
    const sig = await sendAndConfirmTransaction(connection, updateTx, [delegateTargets], { commitment: "confirmed" });
    check(`REAL non-root delegate update_targets succeeded (sig ${sig})`, true);
  } catch (e) {
    check(`non-root delegate update_targets should have succeeded: ${e instanceof Error ? e.message : String(e)}`, false);
  }

  console.log("\n=== Step 4: the PAUSE-only delegate's update_targets attempt is REJECTED on-chain ===");
  const [delegatePausePda] = findDelegate(RESERVE_ONE, delegatePause.publicKey, PROGRAM_ID);
  const badUpdateIx = await buildUpdateTargetsInstruction(program, PROGRAM_ID, RESERVE_ONE, delegatePause.publicKey, delegatePausePda, assetMintsInOrder, currentWeights);
  const badTx = new Transaction().add(badUpdateIx);
  badTx.feePayer = delegatePause.publicKey;
  try {
    const sig = await sendAndConfirmTransaction(connection, badTx, [delegatePause], { commitment: "confirmed" });
    check(`PAUSE-only delegate's update_targets should have been REJECTED, but succeeded (sig ${sig})`, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Must fail with the REAL permission error (DelegatePermissionDenied,
    // 0x178c/6028) specifically -- any other error (e.g. a remaining-accounts
    // mismatch) would prove nothing about permission gating.
    const isGenuinePermissionDenial = msg.includes("0x178c") || msg.includes("DelegatePermissionDenied") || msg.includes("not an authorized delegate");
    check(`PAUSE-only delegate's update_targets rejected with the genuine DelegatePermissionDenied error, not some other failure (${msg.slice(0, 160)})`, isGenuinePermissionDenial);
  }

  console.log("\n=== Step 5: full add_delegate -> update_delegate_permissions -> remove_delegate cycle ===");
  const throwaway = Keypair.generate();
  const [throwawayPda] = findDelegate(RESERVE_ONE, throwaway.publicKey, PROGRAM_ID);
  const [managerActingPda] = findDelegate(RESERVE_ONE, manager.publicKey, PROGRAM_ID); // root-manager calls don't deserialize this account, but it must still be correctly derived

  const addIx = await buildAddDelegateInstruction(program, PROGRAM_ID, RESERVE_ONE, manager.publicKey, managerActingPda, throwaway.publicKey, PERMISSION_FLAGS.PAUSE_RESERVE, true);
  const addTx = new Transaction().add(addIx);
  addTx.feePayer = manager.publicKey;
  const addSig = await sendAndConfirmTransaction(connection, addTx, [manager], { commitment: "confirmed" });
  console.log(`  add_delegate sig: ${addSig}`);

  const afterAdd = await program.account.delegate.fetchNullable(throwawayPda);
  check("throwaway delegate account exists on-chain after add_delegate", afterAdd !== null);
  check("throwaway delegate has exactly PAUSE_RESERVE granted", afterAdd?.permissions === PERMISSION_FLAGS.PAUSE_RESERVE);

  const newPerms = PERMISSION_FLAGS.PAUSE_RESERVE | PERMISSION_FLAGS.UNPAUSE_RESERVE;
  const updatePermIx = await buildUpdateDelegatePermissionsInstruction(program, PROGRAM_ID, RESERVE_ONE, manager.publicKey, managerActingPda, throwaway.publicKey, newPerms);
  const updatePermTx = new Transaction().add(updatePermIx);
  updatePermTx.feePayer = manager.publicKey;
  const updatePermSig = await sendAndConfirmTransaction(connection, updatePermTx, [manager], { commitment: "confirmed" });
  console.log(`  update_delegate_permissions sig: ${updatePermSig}`);

  const afterUpdate = await program.account.delegate.fetchNullable(throwawayPda);
  check("throwaway delegate's permissions genuinely updated on-chain", afterUpdate?.permissions === newPerms);

  const removeIx = await buildRemoveDelegateInstruction(program, PROGRAM_ID, RESERVE_ONE, manager.publicKey, managerActingPda, throwaway.publicKey);
  const removeTx = new Transaction().add(removeIx);
  removeTx.feePayer = manager.publicKey;
  const removeSig = await sendAndConfirmTransaction(connection, removeTx, [manager], { commitment: "confirmed" });
  console.log(`  remove_delegate sig: ${removeSig}`);

  const afterRemove = await connection.getAccountInfo(throwawayPda);
  check("throwaway delegate account genuinely closed (no longer exists) after remove_delegate", afterRemove === null);

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
