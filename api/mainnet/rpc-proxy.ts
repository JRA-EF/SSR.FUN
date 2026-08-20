// POST /api/mainnet/rpc-proxy -- the browser's ONLY route to the Mainnet RPC
// provider (Helius). Mirrors api/devnet/rpc-proxy.ts's security model
// exactly (method allowlist, payload validation, per-IP throttle, bounded
// read-only fallback, sendTransaction never retried/routed to a fallback) --
// see that file's header for the full rationale, unchanged here. Kept as a
// fully separate module so a Mainnet request can never be misrouted to the
// DevNet endpoint or vice versa.
import { resolveRpcUrl, FALLBACK_RPC_URL } from "./_lib/rpc";
import { checkRateWindow } from "../devnet/_lib/rateLimit";

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
]);

const MAX_BATCH_SIZE = 20;
const MAX_BODY_BYTES = 50_000;
const THROTTLE_WINDOW_MS = 1_000;
const THROTTLE_MAX_PER_WINDOW = 40;

const SEND_TRANSACTION_THROTTLE_KEY = "mainnet-rpc-proxy:sendTransaction:global";
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

  const containsSend = toForward.some((r) => r.method === "sendTransaction");

  if (containsSend && !checkRateWindow(SEND_TRANSACTION_THROTTLE_KEY, SEND_TRANSACTION_THROTTLE_WINDOW_MS, SEND_TRANSACTION_THROTTLE_MAX_PER_WINDOW)) {
    res.status(429).json(
      isBatch
        ? toForward.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "Mainnet RPC sendTransaction is temporarily rate-limited (shared provider budget)." } }))
        : { jsonrpc: "2.0", id: (toForward[0] as JsonRpcRequest | undefined)?.id ?? null, error: { code: -32005, message: "Mainnet RPC sendTransaction is temporarily rate-limited (shared provider budget)." } },
    );
    return;
  }

  const primaryUrl = resolveRpcUrl();

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
