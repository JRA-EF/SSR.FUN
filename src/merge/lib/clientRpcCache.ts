// Client-side coalescing + short-TTL cache for read RPCs, installed as the
// Connection's `fetch` (see SolanaProviders.tsx). Complements the server-side
// proxy cache: the proxy shields the upstream provider's quota, but the browser
// still fires every request. This layer removes duplicate reads BEFORE they
// leave the browser -- the exact symptom observed live (the same account polled
// by several components and across rapid re-renders, hundreds of req/min/user).
//
// Two mechanisms, applied ONLY to single (non-batch) cacheable read requests:
//   1. In-flight coalescing: N identical concurrent reads share ONE network
//      request and each receives its own Response built from the shared body.
//   2. Short-TTL cache (2s): an identical read within the window is served from
//      memory with zero network I/O.
//
// SAFETY: only slow-changing account reads are cached (getAccountInfo,
// getMultipleAccounts, getProgramAccounts). Everything else -- sendTransaction,
// getLatestBlockhash, getSignatureStatuses, simulateTransaction,
// getTokenAccountBalance, and all batches -- passes straight through to the
// real fetch untouched. The buy flow's freshness-critical reads use
// getTokenAccountBalance (never cached) and are bounded-retry settled polls, so
// a <=2s stale account read cannot affect purchase accounting. JSON-RPC ids are
// rewritten to each caller's own id so web3.js response matching is preserved.

const CACHEABLE_METHODS = new Set(["getAccountInfo", "getMultipleAccounts", "getProgramAccounts"]);
const TTL_MS = 2_000;
const MAX_ENTRIES = 500;

interface CacheEntry {
  expiresAt: number;
  status: number;
  bodyObj: Record<string, unknown>;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<{ status: number; bodyObj: Record<string, unknown> }>>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function prune(now: number): void {
  for (const [k, e] of cache) if (e.expiresAt <= now) cache.delete(k);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Extract the single cacheable JSON-RPC request from a fetch init body, or
 *  null if this request must pass through untouched (batch, non-POST, unknown
 *  shape, or a non-cacheable method). */
function parseCacheable(init?: RequestInit): { key: string; id: unknown } | null {
  if (!init || (init.method && init.method.toUpperCase() !== "POST")) return null;
  const body = init.body;
  if (typeof body !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) return null;
  const req = parsed as Record<string, unknown>;
  if (typeof req.method !== "string" || !CACHEABLE_METHODS.has(req.method)) return null;
  return { key: req.method + "|" + stableStringify(req.params ?? null), id: req.id };
}

function buildResponse(status: number, bodyObj: Record<string, unknown>, id: unknown): Response {
  return new Response(JSON.stringify({ ...bodyObj, id }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A drop-in `fetch` for web3.js `Connection` `config.fetch`. Coalesces and
 * short-TTL-caches single cacheable read requests; passes everything else
 * straight through to the underlying fetch.
 */
export function coalescingRpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const cacheable = parseCacheable(init);
  if (!cacheable) return fetch(input, init);

  const { key, id } = cacheable;
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return Promise.resolve(buildResponse(hit.status, hit.bodyObj, id));
  }
  if (hit) cache.delete(key);

  const existing = inflight.get(key);
  if (existing) {
    return existing.then((r) => buildResponse(r.status, r.bodyObj, id));
  }

  const shared = (async () => {
    const res = await fetch(input, init);
    const text = await res.text();
    let bodyObj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      bodyObj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { raw: text };
    } catch {
      bodyObj = { raw: text };
    }
    // Only cache successful, non-error JSON-RPC responses.
    if (res.status === 200 && !("error" in bodyObj && bodyObj.error != null) && !("raw" in bodyObj)) {
      cache.set(key, { expiresAt: Date.now() + TTL_MS, status: res.status, bodyObj });
      if (cache.size > MAX_ENTRIES) prune(Date.now());
    }
    return { status: res.status, bodyObj };
  })().finally(() => inflight.delete(key));

  inflight.set(key, shared);
  return shared.then((r) => buildResponse(r.status, r.bodyObj, id));
}
