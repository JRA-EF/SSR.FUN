// POST /api/devnet/rpc-proxy -- the browser's ONLY route to the DevNet RPC
// provider (Helius when HELIUS_RPC_URL is configured). The frontend's
// wallet-adapter Connection is pointed at this same-origin path in
// production builds (see src/merge/lib/solana-config.ts) instead of ever
// receiving a raw provider URL/API key -- see docs/project/DECISION_LOG.md's
// Helius-integration entry for the full rationale.
//
// Security model:
//   1) Method allowlist -- only the exact JSON-RPC methods this app's own
//      Connection genuinely calls (see the audit referenced in the decision
//      log) are forwarded; everything else is rejected locally as a
//      JSON-RPC "method not found" error, never reaching the upstream
//      provider or spending API-key quota.
//   2) Payload validation -- request body must be a single JSON-RPC 2.0
//      object or a bounded-size batch array of them; anything malformed is
//      rejected with 400 before any upstream call.
//   3) Best-effort per-IP throttle (checkRateWindow) as a secondary defense
//      -- the durable protection is the allowlist plus the upstream
//      provider's own API-key-scoped rate limits.
//   4) Bounded fallback -- a genuine transport/5xx failure from the primary
//      endpoint is retried once against a public fallback endpoint. This
//      NEVER applies to `sendTransaction`: an ambiguous send failure could
//      already have landed on-chain, so a send is only ever sent to the
//      primary endpoint once and its result (success or error) is returned
//      as-is -- reconciliation is always by signature (confirmSignatureBounded
//      on the client), never by blind resubmission against a second
//      endpoint. A genuine 429 from the primary is also never treated as a
//      reason to fail over -- it's returned as-is so the client's own
//      withRateLimitRetry/backoff (already in place) handles it, rather than
//      the proxy silently routing around a rate limit that exists to shed
//      load.
import { resolveRpcUrl, FALLBACK_RPC_URL } from "./_lib/rpc";
import { checkRateWindow } from "./_lib/rateLimit";

export interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

export const ALLOWED_METHODS = new Set([
  "getLatestBlockhash",
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenSupply",
  // See api/mainnet/rpc-proxy.ts's identical addition -- this method was
  // missing from both proxies' allowlists, deterministically breaking every
  // client-side SPL token balance read routed through either of them (a
  // Mainnet-confirmed live incident; kept in sync here since this repo's
  // seed-funding logic is shared between clusters).
  "getTokenAccountBalance",
  "getSignatureStatuses",
  "getBlockHeight",
  "getMinimumBalanceForRentExemption",
  "sendTransaction",
  // See api/mainnet/rpc-proxy.ts's identical addition (DEC-0142) -- kept in
  // sync since createReserveClient.ts's Address-Lookup-Table fallback is
  // shared between clusters, even though the reported failure was Mainnet-only.
  "getSlot",
]);

const MAX_BATCH_SIZE = 20;
const MAX_BODY_BYTES = 50_000;
const THROTTLE_WINDOW_MS = 1_000;
const THROTTLE_MAX_PER_WINDOW = 40; // generous for one client's own concurrent-read cap (4) plus bursts across several tabs

// Global (single shared key, not per-IP) sendTransaction throttle -- see the
// call site below. Kept conservatively under Helius's paid-plan cap (5
// sendTransaction/sec, shared across every client of this deployment) to
// leave headroom for the server-signed sends this proxy never sees (faucet/
// swap-sign use their own direct Connection, outside this proxy).
const SEND_TRANSACTION_THROTTLE_KEY = "rpc-proxy:sendTransaction:global";
const SEND_TRANSACTION_THROTTLE_WINDOW_MS = 1_000;
const SEND_TRANSACTION_THROTTLE_MAX_PER_WINDOW = 3;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: unknown;
  error: { code: number; message: string };
}

function isPlainJsonRpcRequest(x: unknown): x is JsonRpcRequest {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function methodNotAllowed(id: unknown): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not permitted via this proxy." } };
}

export function invalidRequest(id: unknown, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message } };
}

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

function parseBody(req: ApiRequest): unknown {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return undefined;
    }
  }
  return req.body;
}

/** Raw fetch to a single upstream JSON-RPC endpoint. Returns null on any transport-level failure (network error, non-JSON body) so the caller can decide whether a fallback applies. */
async function postJsonRpc(url: string, payload: unknown): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (body === null) return null;
    return { status: res.status, body };
  } catch {
    return null;
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = clientIp(req);
  if (!checkRateWindow(`rpc-proxy:${ip}`, THROTTLE_WINDOW_MS, THROTTLE_MAX_PER_WINDOW)) {
    // Best-effort secondary throttle only -- returned as a 429 so the
    // client's existing rate-limit detection (isRateLimitError) treats this
    // exactly like a genuine upstream 429 and backs off the same way.
    res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "Too many requests to the DevNet RPC proxy from this client." } });
    return;
  }

  const rawBody = parseBody(req);
  const isBatch = Array.isArray(rawBody);
  const items: unknown[] = isBatch ? rawBody : [rawBody];

  if (items.length === 0 || items.length > MAX_BATCH_SIZE) {
    res.status(400).json({ error: `Request must contain between 1 and ${MAX_BATCH_SIZE} JSON-RPC calls.` });
    return;
  }
  if (JSON.stringify(rawBody).length > MAX_BODY_BYTES) {
    res.status(400).json({ error: "Request body too large." });
    return;
  }

  const toForward: JsonRpcRequest[] = [];
  const rejected = new Map<number, JsonRpcErrorResponse>();

  items.forEach((item, idx) => {
    if (!isPlainJsonRpcRequest(item)) {
      rejected.set(idx, invalidRequest(undefined, "Each entry must be a JSON-RPC 2.0 request object."));
      return;
    }
    if (item.jsonrpc !== "2.0" || typeof item.method !== "string") {
      rejected.set(idx, invalidRequest(item.id, "Malformed JSON-RPC request (missing jsonrpc/method)."));
      return;
    }
    if (!ALLOWED_METHODS.has(item.method)) {
      rejected.set(idx, methodNotAllowed(item.id));
      return;
    }
    toForward.push(item);
  });

  // Never fall back for a batch containing sendTransaction -- see file
  // header. Reads are safe to retry against a different endpoint; a send is
  // never retried against a second endpoint under any circumstance.
  const containsSend = toForward.some((r) => r.method === "sendTransaction");

  if (containsSend && !checkRateWindow(SEND_TRANSACTION_THROTTLE_KEY, SEND_TRANSACTION_THROTTLE_WINDOW_MS, SEND_TRANSACTION_THROTTLE_MAX_PER_WINDOW)) {
    // A SEPARATE, GLOBAL (not per-IP) throttle -- the per-IP one above
    // exists to blunt one client hammering the proxy, but Helius's paid
    // plan caps sendTransaction specifically at a shared rate across every
    // client (not per-IP), which the per-IP throttle does nothing to
    // protect. Deliberately conservative (under the real plan limit, see
    // docs/project/PROJECT_STATUS.md's Helius-integration entry) so a burst
    // of concurrent Reserve-launch/Buy/Sell submissions degrades into a
    // 429 the client already reconciles safely (CreateDTR.tsx/zapClient.ts's
    // existing isRateLimitError/on-chain-reconciliation paths, unchanged)
    // rather than risking an unpredictable upstream rejection. Only ever
    // gates the forward -- never causes a send to be retried or routed to
    // the fallback endpoint (see the file header's "never resubmitted"
    // guarantee, which this fully preserves).
    res.status(429).json(
      isBatch
        ? toForward.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "DevNet RPC sendTransaction is temporarily rate-limited (shared provider budget)." } }))
        : { jsonrpc: "2.0", id: (toForward[0] as JsonRpcRequest | undefined)?.id ?? null, error: { code: -32005, message: "DevNet RPC sendTransaction is temporarily rate-limited (shared provider budget)." } },
    );
    return;
  }

  const primaryUrl = resolveRpcUrl();

  const forwardPayload = isBatch ? toForward : toForward[0];
  let upstream = toForward.length > 0 ? await postJsonRpc(primaryUrl, forwardPayload) : { status: 200, body: [] };

  if (upstream === null && !containsSend) {
    // Primary endpoint unreachable (not a 429 -- postJsonRpc only returns
    // null on a transport-level failure) -- one bounded retry against the
    // public fallback, read-only calls only.
    upstream = await postJsonRpc(FALLBACK_RPC_URL, forwardPayload);
  }

  if (upstream === null) {
    res.status(502).json(
      isBatch
        ? toForward.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32003, message: "DevNet RPC endpoint unreachable." } }))
        : { jsonrpc: "2.0", id: (toForward[0] as JsonRpcRequest | undefined)?.id ?? null, error: { code: -32003, message: "DevNet RPC endpoint unreachable." } },
    );
    return;
  }

  // Stitch the allowed-and-forwarded responses back together with the
  // locally-rejected ones, preserving original order/ids so the client's
  // id-matching logic works regardless of what got filtered out.
  if (rejected.size === 0) {
    res.status(upstream.status).json(upstream.body);
    return;
  }

  const upstreamList = Array.isArray(upstream.body) ? upstream.body : [upstream.body];
  let upstreamCursor = 0;
  const merged = items.map((_item, idx) => {
    if (rejected.has(idx)) return rejected.get(idx);
    return upstreamList[upstreamCursor++];
  });
  res.status(upstream.status).json(isBatch ? merged : merged[0]);
}
