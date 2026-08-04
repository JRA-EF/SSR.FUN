// Rate-limit detection + bounded retry, shared by every read-only path in
// this package (and re-exported by src/merge/lib/rpcResilience.ts for the
// frontend's own callers) so there is exactly one implementation instead of
// a fork between the SDK and the app.

export function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
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
