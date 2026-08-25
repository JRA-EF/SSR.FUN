// Rate-limit detection + bounded retry, shared by every read-only path in
// this package (and re-exported by src/merge/lib/rpcResilience.ts for the
// frontend's own callers) so there is exactly one implementation instead of
// a fork between the SDK and the app.

/**
 * True only for a genuine HTTP/RPC 429 (or "too many requests") error.
 * Real @solana/web3.js 429 errors always read `"429 Too Many Requests:  {...}"`
 * -- "429" appears as its own token, bounded by whitespace/punctuation, never
 * embedded inside a longer alphanumeric run. `\b429\b` is deliberately a
 * WORD-BOUNDARY match, not a bare substring test: a base58 pubkey or other
 * alphanumeric identifier can legally contain the digit run "429" (e.g.
 * "...A429B...") with no word boundary on either side (every character in a
 * base58 string is a `\w` character, so `\b` never fires inside one) -- a
 * bare `.includes("429")` would misclassify a genuine build/signer/validation
 * error whose message happens to contain that substring as RPC congestion,
 * discarding the real, actionable error. See this pass's DECISION_LOG entry
 * for the real bug this was found fixing (an "unknown signer: <pubkey>"
 * error being silently relabeled as "DevNet RPC congested").
 *
 * Also matches any message containing BOTH "too many" and "requests"
 * (not necessarily adjacent), not just the exact phrase "too many
 * requests" -- confirmed live (2026-08-25): this app's own
 * api/mainnet/jupiter-swap.ts rate-limits with a real HTTP 429 whose body
 * reads "Too many swap requests from this client -- wait a moment and try
 * again.", but fetchJupiterSwapQuote (jupiterSwapClient.ts) throws using
 * that body text alone, discarding the HTTP status entirely (the
 * established pattern across this codebase's own fetch-wrapping call
 * sites -- see e.g. uploadReserveMetadata) -- so the exact-phrase check
 * alone let a genuine, real rate limit fall through to
 * classifyCreateReserveError's conservative "deterministic" default,
 * telling the Creator a plain retry "will not resolve itself" for a
 * condition its own error text says to simply wait and retry. Requiring
 * BOTH words (in either order, not necessarily adjacent) rather than a
 * single bare "too many" keeps this from over-matching an unrelated
 * message that merely happens to contain "too many" on its own.
 */
export function isRateLimitError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /\b429\b/.test(msg) || msg.includes("too many requests") || (msg.includes("too many") && msg.includes("requests"));
}

/** Bounded exponential backoff with jitter, retrying ONLY genuine rate-limit errors -- any other error is rethrown immediately, never masked by a pointless retry loop. Safe to use on any READ-ONLY call; never wrap a transaction-submitting call with this. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 500): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimitError(e) || attempt >= maxRetries) throw e;
      const backoff = baseDelayMs * 2 ** attempt;
      const jitter = Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
      attempt += 1;
    }
  }
}
