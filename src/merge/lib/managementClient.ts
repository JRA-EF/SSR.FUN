// Browser-side client for Phase F (composition management) and Phase G
// (wind-down) -- see packages/sdk/src/managementInstructions.ts for the
// instruction builders this wraps. Unlike Buy/Sell's zap, none of these need
// a server-side co-signer: every action here is a single transaction signed
// only by the connected wallet (the Reserve's root manager -- see
// ManageDTR.tsx, which gates all of these to root-manager-only for now;
// on-chain delegate signing for MANAGE_LIQUIDITY_CONFIG-permitted delegates
// is a smallest-safe-extension follow-up, not built in this pass).
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  buildAddReserveAssetActiveInstruction,
  buildCloseReserveInstruction,
  buildFundNewReserveAssetInstruction,
  buildInitiateWindDownInstruction,
  buildRemoveReserveAssetInstruction,
  buildUpdateTargetsInstruction,
  DEVNET_FIXTURES,
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
  if (outcome.status === "failed") throw new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`);
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
  const ix = await buildUpdateTargetsInstruction(
    program,
    programId,
    new PublicKey(reserve),
    wallet.publicKey,
    wallet.publicKey,
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
  const ix = await buildAddReserveAssetActiveInstruction(
    program,
    programId,
    new PublicKey(reserve),
    wallet.publicKey,
    wallet.publicKey,
    new PublicKey(assetMint),
    targetWeightBps,
  );
  return signAndSend(connection, wallet, new Transaction().add(ix));
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
  const ix = await buildRemoveReserveAssetInstruction(
    program,
    programId,
    new PublicKey(reserve),
    new PublicKey(reserveManager),
    wallet.publicKey,
    wallet.publicKey,
    new PublicKey(assetMint),
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
