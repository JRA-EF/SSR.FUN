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
// signAndSend pattern (skipPreflight, confirmSignatureBounded), adapted for
// a VersionedTransaction (Jupiter always returns v0).
//
// Deliberately does NOT reuse createReserveClient.ts's describeOnChainError
// for an on-chain swap failure -- that decoder is scoped to ssr_protocol's
// own deployed IDL/Anchor's framework error table and produces ssr_protocol-
// flavored guidance ("check whether the deployed program binary has
// drifted") that's actively misleading for a swap transaction, which never
// invokes ssr_protocol at all. A swap transaction's instructions belong to
// Jupiter's router and whichever AMM program(s) it routed through -- this
// repo has no IDL for those, so describeJupiterSwapError below explains the
// raw failure honestly instead of guessing at a specific meaning.
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";

/**
 * Pure -- turns a raw JSON-stringified on-chain TransactionError (e.g.
 * `{"InstructionError":[4,{"Custom":52}]}`) into an honest, swap-context
 * explanation. Never claims to know exactly what a given custom error code
 * means for an external program this repo has no IDL for -- the single most
 * common real cause (by far) of an AMM/router instruction reverting mid-swap
 * is a minimum-output/slippage check, so that's named as the likely cause,
 * not asserted as certain.
 */
export function describeJupiterSwapError(rawErrorJson: string): string {
  try {
    const parsed = JSON.parse(rawErrorJson) as unknown;
    if (parsed && typeof parsed === "object" && "InstructionError" in parsed) {
      const [, detail] = (parsed as { InstructionError: [number, unknown] }).InstructionError;
      if (detail && typeof detail === "object" && "Custom" in detail) {
        const code = (detail as { Custom: number }).Custom;
        // Jupiter's own documented error codes
        // (https://developers.jup.ag/docs/swap/common-errors) -- decoded by
        // NUMBER, never guessed from vibes. Confirmed live (2026-08-25,
        // Reserve 11's USD1 swap failing 5 consecutive times over 34
        // minutes, wallet holding 0.49 USDC against a ~$2 swap): 6024 is
        // InsufficientFunds, a DETERMINISTIC condition a plain retry can
        // never fix -- an earlier version of this function claimed
        // "slippage ... try again" for every code, actively steering the
        // Creator into a doomed retry loop.
        if (code === 6024) {
          return `The Jupiter swap was rejected on-chain because this wallet does not hold enough to fund it (Jupiter error 6024: insufficient funds for the swap amount, network fees, or account rent). Add more USDC (and keep a little SOL for fees) to this wallet before trying again -- retrying without adding funds will fail the same way every time.`;
        }
        if (code === 6001) {
          return `The Jupiter swap was rejected on-chain because the price moved beyond the accepted slippage between fetching the quote and the swap executing (Jupiter error 6001) -- routine for a lower-liquidity token. Try again: a fresh quote is fetched automatically on retry.`;
        }
        return `The Jupiter swap was rejected on-chain by one of the programs in its route (error code ${code}) -- this most commonly means the price moved beyond the accepted slippage between fetching the quote and the swap actually executing, which is routine for a lower-liquidity token. Try again: a fresh quote is fetched automatically on retry.`;
      }
    }
  } catch {
    // Fall through to the generic message below.
  }
  return `The Jupiter swap was rejected on-chain (${rawErrorJson}) -- most likely the price moved beyond the accepted slippage between quote and execution. Try again: a fresh quote is fetched automatically on retry.`;
}

export interface JupiterSwapQuote {
  swapTransaction: string;
  lastValidBlockHeight: number;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
}

/** Fetches a real Jupiter quote + unsigned swap transaction. Default (buy) direction spends `amountRaw` of USDC into `outputMint`; passing `inputMint` (DEC-0158, the sell direction) spends `amountRaw` of that asset into USDC (`outputMint` must then be the USDC mint -- server-enforced). Throws with the server's own honest message on any failure (no route, price impact too high, etc.) -- never fabricates a quote. `receiveWrappedSol` is retained for caller compatibility; since DEC-0156 the server builds EVERY swap with wrapAndUnwrapSol:false regardless. */
export async function fetchJupiterSwapQuote(outputMint: string, amountRaw: bigint, userPublicKey: string, slippageBps?: number, receiveWrappedSol?: boolean, inputMint?: string): Promise<JupiterSwapQuote> {
  const res = await fetch("/api/mainnet/jupiter-swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outputMint, amountRaw: amountRaw.toString(), userPublicKey, slippageBps, receiveWrappedSol, ...(inputMint ? { inputMint } : {}) }),
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

/** One swap's raw instruction material for single-transaction composition (DEC-0156) -- see singleTxBuy.ts. */
export interface JupiterSwapInstructionsResult {
  setupInstructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
  swapInstruction: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
  addressLookupTableAddresses: string[];
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
}

/** Fetches a real Jupiter quote as RAW INSTRUCTIONS + lookup-table addresses (mode "instructions") so the caller can compose every swap and the final mint/redeem into ONE wallet-signed transaction (singleTxBuy.ts / multiAssetSellClient.ts). Same server endpoint and honesty as fetchJupiterSwapQuote; the swap is always USDC-settled -- USDC -> `outputMint` by default, or `inputMint` -> USDC when `inputMint` is passed (the sell direction, DEC-0158; the server then requires outputMint to be USDC). The server builds every swap with wrapAndUnwrapSol: false, and the cleanup instruction (the wSOL-ATA-closing unwrap) is never composed. */
export async function fetchJupiterSwapInstructions(outputMint: string, amountRaw: bigint, userPublicKey: string, slippageBps?: number, inputMint?: string, maxAccounts?: number): Promise<JupiterSwapInstructionsResult> {
  const res = await fetch("/api/mainnet/jupiter-swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outputMint, amountRaw: amountRaw.toString(), userPublicKey, slippageBps, mode: "instructions", ...(inputMint ? { inputMint } : {}), ...(maxAccounts ? { maxAccounts } : {}) }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.swapInstruction !== "object" || body.swapInstruction === null) {
    throw new Error((body && typeof body.error === "string" && body.error) || `Jupiter swap-instructions build failed (HTTP ${res.status}).`);
  }
  return {
    setupInstructions: Array.isArray(body.setupInstructions) ? body.setupInstructions : [],
    swapInstruction: body.swapInstruction,
    addressLookupTableAddresses: Array.isArray(body.addressLookupTableAddresses) ? body.addressLookupTableAddresses : [],
    inAmount: BigInt(body.inAmount),
    outAmount: BigInt(body.outAmount),
    priceImpactPct: Number(body.priceImpactPct) || 0,
  };
}

/** Signs and submits an already-fetched Jupiter swap quote's transaction via the connected wallet, then confirms it -- never resubmitted on an ambiguous result, matching every other Mainnet write path in this app. `onSubmitted` fires the instant the signature exists (before confirmation) so the caller's per-asset funding state machine (launchFunding.ts) can persist it -- a later resume reconciles that exact signature against real on-chain status instead of blindly re-swapping. */
export async function executeJupiterSwap(connection: Connection, wallet: WalletContextState, quote: JupiterSwapQuote, onSubmitted?: (signature: string) => void): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const tx = VersionedTransaction.deserialize(Buffer.from(quote.swapTransaction, "base64"));
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  onSubmitted?.(signature);
  const outcome = await confirmSignatureBounded(connection, signature, quote.lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(`${describeJupiterSwapError(outcome.error)} Signature: ${signature}.`);
  if (outcome.status === "expired") throw new Error(`Jupiter swap expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature, "Mainnet"); // Jupiter swaps are Mainnet-only.
}
