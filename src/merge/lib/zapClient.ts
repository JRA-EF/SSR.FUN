// Browser-side counterpart to api/devnet/swap-sign.ts: requests a partially
// (swap-authority) signed transaction, completes it with the connected
// wallet's own signature, and submits it. See
// docs/protocol/FRONTEND_INTEGRATION.md "Buy/Sell zap architecture".
//
// RPC-resilience pass (see docs/project/PROJECT_STATUS.md): submission
// itself is still never automatically retried (exactly one
// sendRawTransaction call per user action -- retrying that would risk a
// double-spend/double-mint, not just a wasted request). What changed:
// (1) the signature is now surfaced to the caller the instant
// sendRawTransaction succeeds, via `onProgress`, instead of only being
// returned after confirmation resolves -- so the UI can show "Submitted --
// confirming on DevNet" with a real Explorer link right away, even if
// confirmation itself then hits a 429; (2) confirmation uses bounded,
// retryable signature-status polling (confirmSignatureBounded) instead of
// `connection.confirmTransaction`'s websocket subscription, which was
// observed live throwing `ws error: Unexpected server response: 429` under
// the exact congestion this pass addresses; (3) the swap-sign fetch itself
// respects a Retry-After header on a 429 from our own endpoint.
import { Connection, Transaction, type PublicKey } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { AmbiguousConfirmationError, confirmSignatureBounded, isRateLimitError } from "./rpcResilience";

export interface ZapQuote {
  reserveTokensRequested?: string;
  assetAmountsRaw?: string[];
  solLamportsOut?: string;
  /** devUSDC-settlement Buy only: which leg(s) were genuinely funded from the user's own real devUSDC balance vs. the DevNet test-asset faucet mechanism -- see packages/sdk/src/zapInstructions.ts's buildBuyZapInstructionsDevUsdc. */
  legSources?: { mint: string; source: "user-devusdc-balance" | "devnet-test-asset-faucet" }[];
}

interface SwapSignResponse {
  transactionBase64: string;
  lastValidBlockHeight: number;
  quote: ZapQuote;
  error?: string;
  code?: string;
}

/** Carries swap-sign.ts's distinguishing error `code` (e.g. "rpc_congested", "swap_authority_low_sol") so the UI can show an accurate, specific message instead of a generic one -- see DTRDetail.tsx's handleBuy/handleSell. */
export class ZapBuildError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ZapBuildError";
    this.code = code;
  }
}

export interface ZapExecutionResult {
  signature: string;
  quote: ZapQuote;
}

/** Fired at each real milestone of signing/submitting -- lets the UI show "Waiting for wallet approval" vs. "Submitted -- confirming on DevNet" instead of one generic spinner for the whole operation. */
export type ZapProgressEvent = { phase: "awaiting-wallet" } | { phase: "submitted"; signature: string };

const MAX_RETRY_AFTER_WAIT_MS = 15_000;

/** Parses a standard HTTP `Retry-After` header (seconds, or an HTTP-date) into a bounded millisecond delay -- never waits longer than MAX_RETRY_AFTER_WAIT_MS regardless of what the header says, so a misbehaving/huge value can't hang the UI indefinitely. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.min(MAX_RETRY_AFTER_WAIT_MS, Math.max(0, asSeconds * 1000));
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.min(MAX_RETRY_AFTER_WAIT_MS, Math.max(0, asDate - Date.now()));
  return null;
}

async function requestSignedZapTransaction(body: Record<string, unknown>): Promise<SwapSignResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("/api/devnet/swap-sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // A malformed (non-JSON) response body -- e.g. a platform-level gateway
    // timeout/error page rather than anything swap-sign.ts itself returned --
    // is treated as congestion and retried the same bounded way, instead of
    // letting a raw JSON.parse SyntaxError reach the caller.
    const json = (await res.json().catch(() => null)) as SwapSignResponse | null;
    if (json === null) {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new ZapBuildError("The DevNet swap adapter returned an unexpected response. Please try again.", "rpc_congested");
    }
    if (!res.ok) {
      // swap-sign.ts's catch-all normalizes every internal error to HTTP 500
      // (see its own final catch block) -- including one caused by a
      // genuine upstream RPC 429 hit while building the transaction server-
      // side. A literal `res.status === 429` check alone misses that case
      // entirely (confirmed live: this is exactly what was observed under
      // sustained DevNet congestion -- see docs/project/PROJECT_STATUS.md).
      // So a rate limit is detected either from the HTTP status OR from the
      // error message itself still carrying the RPC's own "429"/"too many
      // requests" wording, whichever the server actually sent -- still a
      // read-only preflight at this point (no transaction signed or
      // submitted yet), so retrying is safe either way.
      const rateLimited = json.code === "rpc_congested" || res.status === 429 || isRateLimitError(new Error(json.error ?? ""));
      if (rateLimited && attempt < 3) {
        const waitMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 1000 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw new ZapBuildError(json.error || "The DevNet swap adapter rejected this request.", json.code);
    }
    return json;
  }
}

/**
 * Signs, submits (exactly once -- never automatically retried), and confirms
 * a zap transaction. `onProgress` fires at "awaiting-wallet" (right before
 * the wallet prompt) and "submitted" (the instant `sendRawTransaction`
 * succeeds, with the real signature) so the caller can show the real
 * signature/Explorer link before confirmation even starts. Resolves
 * normally only when the chain genuinely
 * confirms the transaction. A definitive on-chain failure or a
 * blockhash-expiry throws a plain, clearly-worded Error; an inconclusive
 * result after bounded polling throws AmbiguousConfirmationError (carrying
 * the signature) specifically so callers can tell "definitely didn't work"
 * apart from "unverified, might still land" -- never conflating the two.
 */
async function signSubmitAndConfirm(
  connection: Connection,
  wallet: WalletContextState,
  transactionBase64: string,
  lastValidBlockHeight: number,
  onProgress?: (event: ZapProgressEvent) => void,
): Promise<string> {
  if (!wallet.signTransaction) {
    throw new Error("This wallet does not support transaction signing.");
  }
  const bytes = Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0));
  const tx = Transaction.from(bytes);
  onProgress?.({ phase: "awaiting-wallet" });
  const signed = await wallet.signTransaction(tx);
  // Exactly one submission attempt -- never retried, automatically or otherwise.
  // skipPreflight: true -- see createReserveClient.ts's signAndSend for why
  // (a live-confirmed false-negative: preflight simulation can run against a
  // different RPC node than the one that served getLatestBlockhash and
  // reject a blockhash that node simply hasn't seen yet, even though the
  // network itself would accept it). confirmSignatureBounded below is
  // already this function's sole source of truth for the real outcome.
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  onProgress?.({ phase: "submitted", signature });
  const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`);
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature);
}

export async function executeBuyZap(params: {
  connection: Connection;
  wallet: WalletContextState;
  reserveAddress: string;
  assetMints: string[];
  userPubkey: PublicKey;
  solLamports: bigint;
  onProgress?: (event: ZapProgressEvent) => void;
}): Promise<ZapExecutionResult> {
  const { transactionBase64, lastValidBlockHeight, quote } = await requestSignedZapTransaction({
    action: "buy",
    reserve: params.reserveAddress,
    assetMints: params.assetMints,
    userPubkey: params.userPubkey.toBase58(),
    solLamports: params.solLamports.toString(),
  });
  const signature = await signSubmitAndConfirm(params.connection, params.wallet, transactionBase64, lastValidBlockHeight, params.onProgress);
  return { signature, quote };
}

/** devUSDC-settlement Buy -- the default DevNet mint flow. See buildBuyZapInstructionsDevUsdc for exactly what's real vs. DevNet-test-faucet-funded per leg. */
export async function executeBuyZapDevUsdc(params: {
  connection: Connection;
  wallet: WalletContextState;
  reserveAddress: string;
  assetMints: string[];
  userPubkey: PublicKey;
  devUsdcAmountRaw: bigint;
  onProgress?: (event: ZapProgressEvent) => void;
}): Promise<ZapExecutionResult> {
  const { transactionBase64, lastValidBlockHeight, quote } = await requestSignedZapTransaction({
    action: "buy-devusdc",
    reserve: params.reserveAddress,
    assetMints: params.assetMints,
    userPubkey: params.userPubkey.toBase58(),
    devUsdcAmountRaw: params.devUsdcAmountRaw.toString(),
  });
  const signature = await signSubmitAndConfirm(params.connection, params.wallet, transactionBase64, lastValidBlockHeight, params.onProgress);
  return { signature, quote };
}

export async function executeSellZap(params: {
  connection: Connection;
  wallet: WalletContextState;
  reserveAddress: string;
  assetMints: string[];
  userPubkey: PublicKey;
  reserveTokensToRedeem: bigint;
  onProgress?: (event: ZapProgressEvent) => void;
}): Promise<ZapExecutionResult> {
  const { transactionBase64, lastValidBlockHeight, quote } = await requestSignedZapTransaction({
    action: "sell",
    reserve: params.reserveAddress,
    assetMints: params.assetMints,
    userPubkey: params.userPubkey.toBase58(),
    reserveTokensToRedeem: params.reserveTokensToRedeem.toString(),
  });
  const signature = await signSubmitAndConfirm(params.connection, params.wallet, transactionBase64, lastValidBlockHeight, params.onProgress);
  return { signature, quote };
}
