// Browser-side counterpart to api/devnet/swap-sign.ts: requests a partially
// (swap-authority) signed transaction, completes it with the connected
// wallet's own signature, and submits it. See
// docs/protocol/FRONTEND_INTEGRATION.md "Buy/Sell zap architecture".
import { Connection, Transaction, type PublicKey } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export interface ZapQuote {
  reserveTokensRequested?: string;
  assetAmountsRaw?: string[];
  solLamportsOut?: string;
}

interface SwapSignResponse {
  transactionBase64: string;
  lastValidBlockHeight: number;
  quote: ZapQuote;
  error?: string;
}

async function requestSignedZapTransaction(body: Record<string, unknown>): Promise<SwapSignResponse> {
  const res = await fetch("/api/devnet/swap-sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SwapSignResponse;
  if (!res.ok) {
    throw new Error(json.error || "The DevNet swap adapter rejected this request.");
  }
  return json;
}

async function completeAndSubmit(connection: Connection, wallet: WalletContextState, transactionBase64: string): Promise<string> {
  if (!wallet.signTransaction) {
    throw new Error("This wallet does not support transaction signing.");
  }
  const bytes = Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0));
  const tx = Transaction.from(bytes);
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

export async function executeBuyZap(params: {
  connection: Connection;
  wallet: WalletContextState;
  reserveAddress: string;
  assetMints: string[];
  userPubkey: PublicKey;
  solLamports: bigint;
}): Promise<{ signature: string; quote: ZapQuote }> {
  const { transactionBase64, quote } = await requestSignedZapTransaction({
    action: "buy",
    reserve: params.reserveAddress,
    assetMints: params.assetMints,
    userPubkey: params.userPubkey.toBase58(),
    solLamports: params.solLamports.toString(),
  });
  const signature = await completeAndSubmit(params.connection, params.wallet, transactionBase64);
  return { signature, quote };
}

export async function executeSellZap(params: {
  connection: Connection;
  wallet: WalletContextState;
  reserveAddress: string;
  assetMints: string[];
  userPubkey: PublicKey;
  reserveTokensToRedeem: bigint;
}): Promise<{ signature: string; quote: ZapQuote }> {
  const { transactionBase64, quote } = await requestSignedZapTransaction({
    action: "sell",
    reserve: params.reserveAddress,
    assetMints: params.assetMints,
    userPubkey: params.userPubkey.toBase58(),
    reserveTokensToRedeem: params.reserveTokensToRedeem.toString(),
  });
  const signature = await completeAndSubmit(params.connection, params.wallet, transactionBase64);
  return { signature, quote };
}
