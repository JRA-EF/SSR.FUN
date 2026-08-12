// Browser-side client for Phase F (composition management), Phase G
// (wind-down), and delegate management -- see
// packages/sdk/src/managementInstructions.ts for the instruction builders
// this wraps. Unlike Buy/Sell's zap, none of these need a server-side
// co-signer: every action here is a single transaction signed only by the
// connected wallet. Every function derives the signer's own real on-chain
// Delegate PDA (via findDelegate) and passes it as the acting-delegate
// account -- required so a genuinely permitted delegate (not only the
// Reserve's root manager) can actually exercise a permission the program
// already verifies on-chain (see require_reserve_permission in
// programs/ssr_protocol/src/instructions/common.rs); it's harmless to pass
// for a root-manager call too, since that path never deserializes the
// account. See ManageDTR.tsx / onChainPermissions.ts's hasOnChainPermission
// for how the frontend now gates each button on the real permission instead
// of hard-locking to root.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  buildAddDelegateInstruction,
  buildAddReserveAssetActiveInstruction,
  buildCloseReserveInstruction,
  buildCollectFeesInstruction,
  buildFundNewReserveAssetInstruction,
  buildInitiateWindDownInstruction,
  buildPauseReserveInstruction,
  buildRemoveDelegateInstruction,
  buildRemoveReserveAssetInstruction,
  buildUnpauseReserveInstruction,
  buildUpdateDelegatePermissionsInstruction,
  buildUpdateTargetsInstruction,
  DEVNET_FIXTURES,
  describeOnChainError,
  findDelegate,
  fetchProtocolConfig,
} from "@ssr/sdk";
import { AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";

/** Signs, submits (once -- never auto-retried), and confirms via bounded signature-status polling instead of `connection.confirmTransaction`'s websocket subscription -- see zapClient.ts's signSubmitAndConfirm, which this mirrors. Never resubmits on an ambiguous result; throws AmbiguousConfirmationError (carrying the real signature) instead. */
async function signAndSend(connection: Connection, wallet: WalletContextState, tx: Transaction): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  // skipPreflight -- see createReserveClient.ts's signAndSend for why.
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  // describeOnChainError decodes a real ssr_protocol custom-error code
  // against the deployed IDL instead of surfacing a raw, undecoded blob --
  // see createReserveClient.ts's signAndSend for the identical pattern.
  if (outcome.status === "failed") throw new Error(describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`)));
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature);
}

const programId = new PublicKey(DEVNET_FIXTURES.programId);

export async function executeUpdateTargets(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  assetMintsInOrder: string[],
  newTargetWeightsBps: number[],
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  // The signer's OWN Delegate PDA -- only actually deserialized on-chain when
  // signer != reserve.manager (see require_reserve_permission); passing it
  // correctly here (rather than wallet.publicKey itself) means this call
  // also works for a genuinely permitted delegate, not only the root manager.
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildUpdateTargetsInstruction(
    program,
    programId,
    reservePk,
    wallet.publicKey,
    actingDelegate,
    assetMintsInOrder.map((m) => new PublicKey(m)),
    newTargetWeightsBps,
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export async function executeAddReserveAsset(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  assetMint: string,
  targetWeightBps: number,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildAddReserveAssetActiveInstruction(
    program,
    programId,
    reservePk,
    wallet.publicKey,
    actingDelegate,
    new PublicKey(assetMint),
    targetWeightBps,
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export interface RebalanceAssetPlan {
  mint: string;
  /** True if this asset is not yet registered on-chain for this Reserve --
   * gets an add_reserve_asset_active(target_weight_bps=0) instruction first.
   * Registering at 0 (rather than the asset's real final weight) is what
   * fixes the previously-reported TargetWeightExceedsTotal failure: every
   * existing asset still holds its OLD on-chain weight at the moment this
   * instruction runs, so registering at any nonzero weight could blow the
   * 10,000bps cap before the trailing update_targets below ever gets a
   * chance to bring the total back in line. */
  isNew: boolean;
  /** Final on-chain target weight (bps, 0-10000) after this transaction,
   * for every asset -- new and existing alike -- applied by the single
   * trailing update_targets instruction. */
  targetWeightBps: number;
}

/**
 * Submits an entire proposed Reserve Composition & Rebalance as ONE signed
 * transaction: one add_reserve_asset_active(0) instruction per `isNew`
 * entry (in the given order -- this fixes each new asset's on-chain
 * order_index), followed by exactly one update_targets instruction
 * covering every entry (existing + newly-registered) with its real final
 * weight. Solana executes instructions within a transaction sequentially
 * against shared account state, so update_targets' remaining-accounts
 * check correctly sees an asset registered earlier in this same
 * transaction. `assetPlan` MUST already be in final order_index order:
 * every existing asset first (in its current order_index order), then
 * every new asset in the order it should be registered.
 */
export async function executeSubmitRebalance(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  assetPlan: RebalanceAssetPlan[],
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const tx = new Transaction();
  for (const a of assetPlan) {
    if (!a.isNew) continue;
    const ix = await buildAddReserveAssetActiveInstruction(
      program,
      programId,
      reservePk,
      wallet.publicKey,
      actingDelegate,
      new PublicKey(a.mint),
      0,
    );
    tx.add(ix);
  }
  const updateIx = await buildUpdateTargetsInstruction(
    program,
    programId,
    reservePk,
    wallet.publicKey,
    actingDelegate,
    assetPlan.map((a) => new PublicKey(a.mint)),
    assetPlan.map((a) => a.targetWeightBps),
  );
  tx.add(updateIx);
  return signAndSend(connection, wallet, tx);
}

export async function executeFundReserveAsset(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  assetMint: string,
  amountRaw: bigint,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const ix = await buildFundNewReserveAssetInstruction(program, programId, new PublicKey(reserve), wallet.publicKey, new PublicKey(assetMint), amountRaw);
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export async function executeRemoveReserveAsset(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  reserveManager: string,
  assetMint: string,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildRemoveReserveAssetInstruction(
    program,
    programId,
    reservePk,
    new PublicKey(reserveManager),
    wallet.publicKey,
    actingDelegate,
    new PublicKey(assetMint),
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

/** Grants delegateWallet the given permission bitmask on `reserve`. `restricted` delegates are gated by the signer's own ADD_RESTRICTED_DELEGATE permission; an unrestricted grant is root-manager-only regardless of the signer's own delegate status -- see add_delegate.rs. */
export async function executeAddDelegate(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  delegateWallet: string,
  permissions: number,
  restricted: boolean,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildAddDelegateInstruction(
    program,
    programId,
    reservePk,
    wallet.publicKey,
    actingDelegate,
    new PublicKey(delegateWallet),
    permissions,
    restricted,
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export async function executeUpdateDelegatePermissions(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  delegateWallet: string,
  newPermissions: number,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildUpdateDelegatePermissionsInstruction(
    program,
    programId,
    reservePk,
    wallet.publicKey,
    actingDelegate,
    new PublicKey(delegateWallet),
    newPermissions,
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export async function executeRemoveDelegate(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  delegateWallet: string,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildRemoveDelegateInstruction(program, programId, reservePk, wallet.publicKey, actingDelegate, new PublicKey(delegateWallet));
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

/** PU-01 fix: pause_reserve/unpause_reserve were deployed, real, working instructions with zero SDK/UI wiring anywhere before this -- see buildPauseReserveInstruction's header comment. */
export async function executePauseReserve(connection: Connection, wallet: WalletContextState, reserve: string): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildPauseReserveInstruction(program, reservePk, wallet.publicKey, actingDelegate);
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export async function executeUnpauseReserve(connection: Connection, wallet: WalletContextState, reserve: string): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildUnpauseReserveInstruction(program, reservePk, wallet.publicKey, actingDelegate);
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

/**
 * FE-01b fix: collect_fees was deployed, real, permissionless, and working
 * (any wallet may call it -- see buildCollectFeesInstruction's header
 * comment), with zero SDK/UI wiring anywhere. This is why a Reserve's
 * configured fee destination could show zero inbound activity even after
 * genuine mint-fee-generating trades: fees accrue as PENDING RESERVE TOKEN
 * SHARES (Reserve.feeConfig.pendingManagerFeeShares/pendingProtocolFeeShares,
 * paid via mint_to when collected -- never a USDC transfer, by protocol
 * design) but nothing had ever triggered the payout. `protocolFeeDestination`
 * is read fresh here (not derivable/cacheable as a PDA) rather than trusted
 * from possibly-stale caller state.
 */
export async function executeCollectFees(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  reserveTokenMint: string,
  managerFeeDestination: string,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const protocolConfig = await fetchProtocolConfig(connection, programId);
  if (!protocolConfig) throw new Error("SSR Protocol is not initialized on this DevNet endpoint.");
  const ix = await buildCollectFeesInstruction(
    program,
    programId,
    new PublicKey(reserve),
    new PublicKey(reserveTokenMint),
    new PublicKey(managerFeeDestination),
    new PublicKey(protocolConfig.defaultProtocolFeeDestination),
    wallet.publicKey,
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export async function executeInitiateWindDown(connection: Connection, wallet: WalletContextState, reserve: string): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const ix = await buildInitiateWindDownInstruction(program, new PublicKey(reserve), wallet.publicKey);
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

export async function executeCloseReserve(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  reserveTokenMint: string,
  assetMintsInOrder: string[],
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const ix = await buildCloseReserveInstruction(
    program,
    programId,
    new PublicKey(reserve),
    new PublicKey(reserveTokenMint),
    wallet.publicKey,
    assetMintsInOrder.map((m) => new PublicKey(m)),
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}
