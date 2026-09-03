// Short-TTL, in-memory micro-cache + in-flight coalescing for the RPC proxies.
//
// Why: the browser client fans out hundreds of identical read RPCs per minute
// per user (discovery re-reads the same Reserve/ReserveAsset/vault/mint
// accounts every poll, and several components independently read the same
// account with no shared client cache). Every one currently hits the upstream
// provider, burning the shared Helius quota. A 2s server-side cache collapses
// a burst of identical reads to at most one upstream call per key per window,
// and coalescing collapses concurrent identical in-flight reads to a single
// upstream request.
//
// SAFETY — what is cacheable:
//   Only slow-changing ACCOUNT reads: getAccountInfo, getMultipleAccounts,
//   getProgramAccounts. Freshness-critical methods are deliberately NOT cached
//   here (sendTransaction, getLatestBlockhash, getSignatureStatuses,
//   simulateTransaction, getFeeForMessage, getTokenAccountBalance). The buy
//   flow's post-swap balance re-reads use getTokenAccountBalance (uncached)
//   and are bounded-retry "settled" polls, so a <=2s stale account read can
//   never corrupt purchase accounting. A caller may also force a fresh read
//   per-request with the `x-ssr-rpc-fresh: 1` header (see the proxy).
//
// This is per-warm-instance state (like the in-memory L1 rate limiter). That
// is fine: the goal is to shed load off the upstream provider, and a single
// user's burst overwhelmingly lands on one warm instance. Cross-instance
// sharing is not required for the win and would add latency that defeats a 2s
// TTL.

export const CACHEABLE_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
]);

export const DEFAULT_TTL_MS = 2_000;
const MAX_ENTRIES = 1_000;

interface Entry {
  expiresAt: number;
  body: unknown;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** Stable cache key. `id` is intentionally excluded — JSON-RPC ids differ per
 *  request and must never be part of the key (the response id is rewritten to
 *  the requester's id on the way out). */
export function cacheKey(method: string, params: unknown): string {
  return method + "|" + stableStringify(params ?? null);
}

/** Deterministic stringify (object keys sorted) so semantically identical
 *  params produce one key regardless of property order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function prune(now: number): void {
  for (const [k, e] of store) {
    if (e.expiresAt <= now) store.delete(k);
  }
  // Bound memory: evict oldest (insertion order) until under the cap.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Returns the cached response body for `key`, or null on miss/expiry. The
 *  returned body carries whatever `id` it was stored with — callers MUST
 *  rewrite it to the requester's id via `withRpcId`. */
export function getCached(key: string, now: number = Date.now()): unknown | null {
  const e = store.get(key);
  if (!e) return null;
  if (e.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  return e.body;
}

/** Stores a successful response body. Never call for error responses. */
export function setCached(key: string, body: unknown, ttlMs: number = DEFAULT_TTL_MS, now: number = Date.now()): void {
  store.set(key, { expiresAt: now + ttlMs, body });
  if (store.size > MAX_ENTRIES) prune(now);
}

/** Collapses concurrent identical upstream calls into one. */
export async function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p as Promise<unknown>);
  return p;
}

/** True if a JSON-RPC response body carries an error (never cache these). */
export function isRpcErrorBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && "error" in (body as Record<string, unknown>) &&
    (body as Record<string, unknown>).error != null;
}

/** Returns a shallow clone of a single JSON-RPC response body with its `id`
 *  set to `id` (so a cached response is delivered under the requester's own
 *  id — web3.js matches responses by id). Non-object bodies pass through. */
export function withRpcId(body: unknown, id: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), id };
}
