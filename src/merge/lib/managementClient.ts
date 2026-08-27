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
  buildCollectProtocolFeeInstruction,
  buildCollectManagerFeeShareInstruction,
  buildInitializeManagerFeeRecipientsInstruction,
  buildUpdateFeeRecipientsInstruction,
  buildFundNewReserveAssetInstruction,
  buildInitiateWindDownInstruction,
  buildRemoveDelegateInstruction,
  buildRemoveReserveAssetInstruction,
  buildUpdateDelegatePermissionsInstruction,
  buildUpdateMetadataInstruction,
  buildUpdateTargetsInstruction,
  describeOnChainError,
  findDelegate,
  fetchProtocolConfig,
  validateMetadataUri,
  type RecipientInput,
} from "@ssr/sdk";
import { AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";
import { SSR_PROGRAM_ID, IS_MAINNET } from "./solana-config";

const CLUSTER_LABEL = IS_MAINNET ? "Mainnet" : "DevNet";

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
  throw new AmbiguousConfirmationError(signature, CLUSTER_LABEL);
}

const programId = SSR_PROGRAM_ID;

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

/**
 * Points the Reserve's on-chain metadata link at a new uploaded metadata
 * payload (name/ticker/description/category/taxes/profile picture -- see
 * uploadReserveMetadata in createReserveClient.ts, which must have run
 * FIRST; only its short permanent URL is submitted on-chain, never the
 * payload). Permitted for the root manager or a delegate holding the
 * update-metadata permission -- enforced on-chain by
 * require_reserve_permission, and surfaced in the UI via
 * hasOnChainPermission(PERMISSION_FLAGS.UPDATE_METADATA).
 */
export async function executeUpdateMetadata(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  newMetadataUri: string,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  // Fail fast on a data:/blob:/overlong URI before ever prompting a wallet
  // signature -- see validateMetadataUri's contract.
  validateMetadataUri(newMetadataUri);
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildUpdateMetadataInstruction(program, reservePk, wallet.publicKey, actingDelegate, newMetadataUri);
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
  if (!protocolConfig) throw new Error(`SSR Protocol is not initialized on this ${CLUSTER_LABEL} endpoint.`);
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

/**
 * Collects ONLY the Protocol's pending fee share, leaving the Manager's
 * pending balance untouched -- see collect_protocol_fee.rs's header.
 * Permissionless, same as executeCollectFees above. This is the manual
 * fallback for a Reserve whose Protocol balance hasn't been swept yet by
 * api/devnet/accrue-fees-cron.ts's weekly keeper (the actual mechanism
 * behind "the Protocol never has to manually claim its fees").
 */
export async function executeCollectProtocolFee(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  reserveTokenMint: string,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const protocolConfig = await fetchProtocolConfig(connection, programId);
  if (!protocolConfig) throw new Error(`SSR Protocol is not initialized on this ${CLUSTER_LABEL} endpoint.`);
  const ix = await buildCollectProtocolFeeInstruction(
    program,
    programId,
    new PublicKey(reserve),
    new PublicKey(reserveTokenMint),
    new PublicKey(protocolConfig.defaultProtocolFeeDestination),
    wallet.publicKey,
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

// --- DEC-0094: multi-recipient Manager fees ---

/** Opts a Reserve into multi-recipient Manager fee routing for the first time. `recipients` must include the Primary Fee Destination if it's to keep any share, and allocations must sum to exactly 100%. */
export async function executeInitializeManagerFeeRecipients(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  recipients: RecipientInput[],
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);
  const ix = await buildInitializeManagerFeeRecipientsInstruction(program, programId, reservePk, wallet.publicKey, actingDelegate, wallet.publicKey, recipients);
  return signAndSend(connection, wallet, new Transaction().add(ix));
}

/**
 * Replaces an already-migrated Reserve's Manager fee routing.
 *
 * CLAIMANT-ONLY (2026-08-14 corrective pass, see docs/project/DECISION_LOG.md
 * and update_fee_recipients.rs's own header comment): this used to
 * auto-bundle a `collect_manager_fee_share` per current recipient into the
 * same transaction to satisfy an on-chain "every recipient's pending balance
 * must be zero" gate -- that only ever worked because collection was
 * permissionless. Now that only a recipient's own wallet can collect its own
 * balance, this Manager-signed transaction can no longer collect on anyone
 * else's behalf. The on-chain gate changed to match: a recipient who STAYS
 * on the list keeps its pending balance carried forward (never blocked); only
 * a recipient being REMOVED from the list must already have zero pending
 * (their own wallet has to collect it first). This function pre-flights that
 * exact check client-side so the caller gets a clear, specific error before
 * ever prompting a wallet signature, instead of a generic on-chain revert.
 */
export async function executeUpdateFeeRecipients(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  currentRecipients: { wallet: string; pendingFeeShares: string }[],
  newRecipients: RecipientInput[],
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  const program = buildReadOnlyProgram(connection) as any;
  const reservePk = new PublicKey(reserve);
  const [actingDelegate] = findDelegate(reservePk, wallet.publicKey, programId);

  const newWallets = new Set(newRecipients.map((r) => r.wallet));
  const removedWithPending = currentRecipients.filter((r) => !newWallets.has(r.wallet) && BigInt(r.pendingFeeShares) > 0n);
  if (removedWithPending.length > 0) {
    throw new Error(
      `Cannot remove ${removedWithPending.map((r) => r.wallet).join(", ")} from fee routing: this wallet still has an uncollected pending balance -- only that wallet's own connected session can collect it (Collect button) before it can be removed.`,
    );
  }

  const updateIx = await buildUpdateFeeRecipientsInstruction(program, programId, reservePk, wallet.publicKey, actingDelegate, newRecipients);
  return signAndSend(connection, wallet, new Transaction().add(updateIx));
}

/** Permissionless -- pays out ONE named recipient's own accrued balance. `managerFeeRecipientsExists` should reflect whether this Reserve has opted into multi-recipient routing (fetchManagerFeeRecipients's `initialized` flag); the legacy fallback path is used when it hasn't. */
/**
 * CLAIMANT-ONLY: `recipient` must equal the connected wallet -- enforced
 * here client-side (fails fast, before ever asking the wallet to sign) AND,
 * authoritatively, on-chain via collect_manager_fee_share.rs's `Signer`
 * constraint on `recipient` itself. The frontend never even calls this for
 * a non-matching connected wallet (see ManageDTR.tsx's per-row Collect
 * button, which is only rendered/enabled for the row matching the
 * connected wallet) -- this check is defense in depth, not the only guard.
 */
export async function executeCollectManagerFeeShare(
  connection: Connection,
  wallet: WalletContextState,
  reserve: string,
  reserveTokenMint: string,
  recipient: string,
  managerFeeRecipientsExists: boolean,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  if (wallet.publicKey.toBase58() !== recipient) {
    throw new Error("Only this recipient's own connected wallet can collect its accrued fees.");
  }
  const program = buildReadOnlyProgram(connection) as any;
  const ix = await buildCollectManagerFeeShareInstruction(
    program,
    programId,
    new PublicKey(reserve),
    new PublicKey(reserveTokenMint),
    wallet.publicKey,
    managerFeeRecipientsExists,
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
