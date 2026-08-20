// Client-side Jupiter swap execution for Mainnet Reserve creation -- lets
// CreateDTR.tsx fund a non-USDC Reserve Asset by actually trading part of
// the creator's USDC seed for it via a real Jupiter route, instead of
// requiring the creator to already hold that exact asset (see
// api/mainnet/jupiter-swap.ts's header and
// docs/project/DECISION_LOG.md's entry for this pass).
//
// Every swap is signed and submitted by the CONNECTED WALLET itself -- this
// module (and the server endpoint it calls) never holds a private key or
// custodies funds at any point. Mirrors createReserveClient.ts's own
// signAndSend pattern (skipPreflight, confirmSignatureBounded, describeOnChainError),
// adapted for a VersionedTransaction (Jupiter always returns v0).
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { describeOnChainError } from "@ssr/sdk";
import { AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";

export interface JupiterSwapQuote {
  swapTransaction: string;
  lastValidBlockHeight: number;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
}

/** Fetches a real Jupiter quote + unsigned swap transaction for spending `amountRawUsdc` (raw USDC, 6 decimals) into `outputMint`. Throws with the server's own honest message on any failure (no route, price impact too high, etc.) -- never fabricates a quote. */
export async function fetchJupiterSwapQuote(outputMint: string, amountRawUsdc: bigint, userPublicKey: string, slippageBps?: number): Promise<JupiterSwapQuote> {
  const res = await fetch("/api/mainnet/jupiter-swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outputMint, amountRaw: amountRawUsdc.toString(), userPublicKey, slippageBps }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    throw new Error((body && typeof body.error === "string" && body.error) || `Jupiter swap quote failed (HTTP ${res.status}).`);
  }
  return {
    swapTransaction: body.swapTransaction,
    lastValidBlockHeight: body.lastValidBlockHeight,
    inAmount: BigInt(body.inAmount),
    outAmount: BigInt(body.outAmount),
    priceImpactPct: Number(body.priceImpactPct) || 0,
  };
}

/** Signs and submits an already-fetched Jupiter swap quote's transaction via the connected wallet, then confirms it -- never resubmitted on an ambiguous result, matching every other Mainnet write path in this app. */
export async function executeJupiterSwap(connection: Connection, wallet: WalletContextState, quote: JupiterSwapQuote): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const tx = VersionedTransaction.deserialize(Buffer.from(quote.swapTransaction, "base64"));
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  const outcome = await confirmSignatureBounded(connection, signature, quote.lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(describeOnChainError(new Error(`Jupiter swap failed on-chain (${outcome.error}). Signature: ${signature}.`)));
  if (outcome.status === "expired") throw new Error(`Jupiter swap expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature);
}
