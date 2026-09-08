// POST /api/mainnet/rpc-proxy -- the browser's ONLY route to the Mainnet RPC
// provider (Helius). Mirrors api/devnet/rpc-proxy.ts's security model
// exactly (method allowlist, payload validation, per-IP throttle, bounded
// read-only fallback, sendTransaction never retried/routed to a fallback) --
// see that file's header for the full rationale, unchanged here. Kept as a
// fully separate module so a Mainnet request can never be misrouted to the
// DevNet endpoint or vice versa.
import { resolveRpcUrl, FALLBACK_RPC_URL } from "./_lib/rpc";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { checkDurableRateWindow } from "../../lib/rate-limit/durableRateWindow";
import { getSql } from "../../lib/rate-limit/db";
import { CACHEABLE_METHODS, cacheKey, coalesce, getCached, isRpcErrorBody, setCached, withRpcId } from "../devnet/_lib/rpcCache";

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
  // Priority-fee bidding for app-built transactions (2026-08-27 DELTA-launch incident fix -- see createReserveClient.ts's "Priority fees + rebroadcast" section). Read-only fee-market view; no account data exposure.
  "getRecentPrioritizationFees",
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenSupply",
  // getTokenAccountBalance was missing from this allowlist entirely -- every
  // call Connection.getTokenAccountBalance makes through this proxy (the
  // ONLY route the browser has to Mainnet RPC in production) was rejected
  // with a JSON-RPC "method not permitted" error, which createReserveClient.ts's
  // fetchOwnedBalanceRaw silently swallowed and reported as a balance of 0 --
  // deterministically, on every single call, never a transient/lag issue.
  // See docs/project/DECISION_LOG.md's entry for this pass.
  "getTokenAccountBalance",
  "getSignatureStatuses",
  "getBlockHeight",
  "getMinimumBalanceForRentExemption",
  "sendTransaction",
  // Added 2026-08-24 (road-to-mainnet MCR-01, DEC-0142): createReserveClient.ts's
  // Address-Lookup-Table fallback (signAndSendPossiblyOverLimit, needed once
  // seed_reserve alone exceeds the legacy transaction size limit for a
  // Reserve with enough assets) calls Connection.getSlot twice -- once to
  // derive the lookup table, once while polling for it to warm up. Missing
  // from this allowlist, every such call would have been rejected exactly
  // like the getTokenAccountBalance gap above (DEC-0130) -- caught this time
  // by tests/phase_mainnet_production_fixes.ts's self-auditing regression
  // guard before it ever shipped.
  "getSlot",
]);

const MAX_BATCH_SIZE = 20;
const MAX_BODY_BYTES = 50_000;
// Raised 2026-09-08: a legitimate multi-asset Buy on a 10-asset Reserve
// broadcasts ~10 swaps in parallel, re-broadcasts each every few seconds
// until it lands, and polls every signature -- the previous 40/s per client
// and 3/s GLOBAL sendTransaction ceilings produced a 429 storm on every such
// purchase (web3.js retried through it, slowly). These are still far below
// what the upstream Helius plan tolerates.
const THROTTLE_WINDOW_MS = 1_000;
const THROTTLE_MAX_PER_WINDOW = 150;

const SEND_TRANSACTION_THROTTLE_KEY = "mainnet-rpc-proxy:sendTransaction:global";
const SEND_TRANSACTION_THROTTLE_WINDOW_MS = 1_000;
const SEND_TRANSACTION_THROTTLE_MAX_PER_WINDOW = 20;

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

// Upstream 429 / 5xx / transport failures are retried briefly HERE (up to
// UPSTREAM_RETRY_DELAYS_MS attempts, honouring a small Retry-After) before
// anything is forwarded to the browser. Live 2026-09-08 on the test site: a
// lower-tier Helius key answered ~15% of a burst with 429 and one send with a
// transport failure -> the client saw raw 429s and a 502 "endpoint
// unreachable" mid-purchase. Every JSON-RPC method this proxy allows is safe
// to re-issue: reads are idempotent and sendTransaction is deduplicated by
// signature on-chain, so a retried send can never double-execute.
const UPSTREAM_RETRY_DELAYS_MS = [250, 700];
const UPSTREAM_MAX_RETRY_AFTER_MS = 2_000;

async function postJsonRpc(url: string, payload: unknown): Promise<{ status: number; body: unknown } | null> {
  for (let attempt = 0; ; attempt++) {
    let result: { status: number; body: unknown } | null = null;
    let retryAfterMs: number | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (body !== null) result = { status: res.status, body };
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, UPSTREAM_MAX_RETRY_AFTER_MS);
    } catch {
      result = null;
    }
    const transient = result === null || result.status === 429 || result.status >= 500;
    if (!transient || attempt >= UPSTREAM_RETRY_DELAYS_MS.length) return result;
    await new Promise((r) => setTimeout(r, retryAfterMs ?? UPSTREAM_RETRY_DELAYS_MS[attempt]));
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = clientIp(req);
  // L1: cheap per-instance burst guard. NOT global (in-memory, per warm
  // serverless instance) -- it blunts a single client hammering one
  // instance in a tight loop; sustained cross-instance read volume is
  // bounded by Helius's API-key quota and (recommended) a Vercel WAF rule,
  // never by this line. See lib/rate-limit/durableRateWindow.ts.
  if (!checkRateWindow(`mainnet-rpc-proxy:${ip}`, THROTTLE_WINDOW_MS, THROTTLE_MAX_PER_WINDOW)) {
    res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "Too many requests to the Mainnet RPC proxy from this client." } });
    return;
  }

  const rawBody = parseBody(req);
  const isBatch = Array.isArray(rawBody);
  const items: unknown[] = isBatch ? rawBody : [rawBody];

  if (items.length === 0 || items.length > MAX_BATCH_SIZE) {
    res.status(400).json({ error: `Request must contain between 1 and ${MAX_BATCH_SIZE} JSON-RPC calls.` });
    return;
  }
  // JSON.stringify(rawBody) is itself `undefined` (the JS value, not a
  // string) when rawBody is undefined -- e.g. a top-level JSON string body
  // like `"hello"`, which parseBody's re-parse attempt above fails and
  // reports as undefined. Calling .length on that unguarded threw a raw,
  // uncaught TypeError (crashing the function) before isPlainJsonRpcRequest
  // below ever got a chance to reject it cleanly as a malformed request.
  const rawBodyJson = JSON.stringify(rawBody);
  if (rawBodyJson !== undefined && rawBodyJson.length > MAX_BODY_BYTES) {
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

  const containsSend = toForward.some((r) => r.method === "sendTransaction");

  // sendTransaction is the one limit that MUST be global (a shared,
  // provider-billed write budget). The in-memory counter cannot enforce that
  // across warm instances, so consult the durable, cross-instance limiter
  // first; it fails OPEN to the in-memory L1 if the DB is unavailable, so a
  // transient DB blip degrades to per-instance limiting rather than blocking
  // all trading.
  let sendThrottled = false;
  if (containsSend) {
    // Acquiring the DB client can itself throw if DATABASE_URL is unset -- do
    // NOT let that crash the proxy; treat it exactly like a DB error and fall
    // back to the in-memory L1.
    let durableAllowed: boolean | null = null;
    try {
      const durable = await checkDurableRateWindow(
        getSql() as unknown as Parameters<typeof checkDurableRateWindow>[0],
        SEND_TRANSACTION_THROTTLE_KEY,
        SEND_TRANSACTION_THROTTLE_WINDOW_MS,
        SEND_TRANSACTION_THROTTLE_MAX_PER_WINDOW,
      );
      durableAllowed = durable.durable ? durable.allowed : null;
    } catch {
      durableAllowed = null;
    }
    sendThrottled = durableAllowed !== null
      ? !durableAllowed
      : !checkRateWindow(SEND_TRANSACTION_THROTTLE_KEY, SEND_TRANSACTION_THROTTLE_WINDOW_MS, SEND_TRANSACTION_THROTTLE_MAX_PER_WINDOW);
  }
  if (sendThrottled) {
    res.status(429).json(
      isBatch
        ? toForward.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "Mainnet RPC sendTransaction is temporarily rate-limited (shared provider budget)." } }))
        : { jsonrpc: "2.0", id: (toForward[0] as JsonRpcRequest | undefined)?.id ?? null, error: { code: -32005, message: "Mainnet RPC sendTransaction is temporarily rate-limited (shared provider budget)." } },
    );
    return;
  }

  const primaryUrl = resolveRpcUrl();

  // --- Read cache + in-flight coalescing (single cacheable read requests) ---
  // Collapses the client's high-volume duplicate account reads to at most one
  // upstream call per key per TTL window. Skipped for batches, rejected-mixed
  // requests, non-cacheable methods, and any request carrying x-ssr-rpc-fresh.
  const wantsFresh = req.headers["x-ssr-rpc-fresh"] === "1";
  const singleReq =
    !isBatch && rejected.size === 0 && toForward.length === 1
      ? (toForward[0] as JsonRpcRequest)
      : null;
  if (
    singleReq &&
    !wantsFresh &&
    typeof singleReq.method === "string" &&
    CACHEABLE_METHODS.has(singleReq.method)
  ) {
    const key = cacheKey(singleReq.method, singleReq.params);
    const hit = getCached(key);
    if (hit !== null) {
      res.status(200).json(withRpcId(hit, singleReq.id));
      return;
    }
    const fetched = await coalesce(key, async () => {
      let up = await postJsonRpc(primaryUrl, singleReq);
      if (up === null) up = await postJsonRpc(FALLBACK_RPC_URL, singleReq);
      return up;
    });
    if (fetched === null) {
      res.status(502).json({
        jsonrpc: "2.0",
        id: singleReq.id,
        error: { code: -32003, message: "Mainnet RPC endpoint unreachable." },
      });
      return;
    }
    if (fetched.status === 200 && !isRpcErrorBody(fetched.body)) {
      setCached(key, fetched.body);
    }
    res.status(fetched.status).json(withRpcId(fetched.body, singleReq.id));
    return;
  }

  const forwardPayload = isBatch ? toForward : toForward[0];
  let upstream = toForward.length > 0 ? await postJsonRpc(primaryUrl, forwardPayload) : { status: 200, body: [] };

  if (upstream === null && !containsSend) {
    upstream = await postJsonRpc(FALLBACK_RPC_URL, forwardPayload);
  }

  if (upstream === null) {
    res.status(502).json(
      isBatch
        ? toForward.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32003, message: "Mainnet RPC endpoint unreachable." } }))
        : { jsonrpc: "2.0", id: (toForward[0] as JsonRpcRequest | undefined)?.id ?? null, error: { code: -32003, message: "Mainnet RPC endpoint unreachable." } },
    );
    return;
  }

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
