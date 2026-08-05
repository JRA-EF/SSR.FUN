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
 */
export function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b429\b/.test(msg) || msg.toLowerCase().includes("too many requests");
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
