// Mainnet-native Buy/Sell client: builds and signs the transaction entirely
// client-side (no server round-trip, no server-held co-signer) using
// packages/sdk/src/directInstructions.ts. See that file's header for why
// this exists instead of reusing zapClient.ts's DevNet zap.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildDirectMintInstructions,
  buildDirectRedeemInstructions,
  buildReadOnlyProgram,
  type ZapAssetLeg,
} from "@ssr/sdk";
import { AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";

export type DirectProgressEvent = { phase: "awaiting-wallet" } | { phase: "submitted"; signature: string };

export interface DirectExecutionResult {
  signature: string;
  reserveTokensRequested?: bigint;
  reserveTokensToRedeem?: bigint;
  assetAmountRaw: bigint;
}

async function signSubmitAndConfirm(
  connection: Connection,
  wallet: WalletContextState,
  tx: Transaction,
  onProgress?: (event: DirectProgressEvent) => void,
): Promise<string> {
  if (!wallet.signTransaction || !wallet.publicKey) {
    throw new Error("This wallet does not support transaction signing.");
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  onProgress?.({ phase: "awaiting-wallet" });
  const signed = await wallet.signTransaction(tx);
  // Exactly one submission attempt -- never automatically retried, same
  // rationale as zapClient.ts's signSubmitAndConfirm (retrying risks a
  // double-mint/double-redeem, not just a wasted request).
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  onProgress?.({ phase: "submitted", signature });
  const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`);
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature);
}

export interface ExecuteDirectMintParams {
  connection: Connection;
  wallet: WalletContextState;
  protocolConfig: PublicKey;
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  amountIn: bigint;
  onProgress?: (event: DirectProgressEvent) => void;
}

export async function executeDirectMint(params: ExecuteDirectMintParams): Promise<DirectExecutionResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const program = buildReadOnlyProgram(params.connection) as any;
  const { instructions, reserveTokensRequested, assetAmountRaw } = await buildDirectMintInstructions({
    program,
    protocolConfig: params.protocolConfig,
    protocolFeeDestination: params.protocolFeeDestination,
    reserve: params.reserve,
    reserveTokenMint: params.reserveTokenMint,
    mintAuthority: params.mintAuthority,
    user: params.wallet.publicKey,
    assets: params.assets,
    reserveTokenSupplyRaw: params.reserveTokenSupplyRaw,
    amountIn: params.amountIn,
  });
  const tx = new Transaction().add(...instructions);
  const signature = await signSubmitAndConfirm(params.connection, params.wallet, tx, params.onProgress);
  return { signature, reserveTokensRequested, assetAmountRaw };
}

export interface ExecuteDirectRedeemParams {
  connection: Connection;
  wallet: WalletContextState;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  vaultAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  redemptionFeeBps: bigint;
  reserveTokensToRedeem: bigint;
  onProgress?: (event: DirectProgressEvent) => void;
}

export async function executeDirectRedeem(params: ExecuteDirectRedeemParams): Promise<DirectExecutionResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const program = buildReadOnlyProgram(params.connection) as any;
  const { instructions, reserveTokensToRedeem, assetAmountRaw } = await buildDirectRedeemInstructions({
    program,
    reserve: params.reserve,
    reserveTokenMint: params.reserveTokenMint,
    vaultAuthority: params.vaultAuthority,
    user: params.wallet.publicKey,
    assets: params.assets,
    reserveTokenSupplyRaw: params.reserveTokenSupplyRaw,
    redemptionFeeBps: params.redemptionFeeBps,
    reserveTokensToRedeem: params.reserveTokensToRedeem,
  });
  const tx = new Transaction().add(...instructions);
  const signature = await signSubmitAndConfirm(params.connection, params.wallet, tx, params.onProgress);
  return { signature, reserveTokensToRedeem, assetAmountRaw };
}
