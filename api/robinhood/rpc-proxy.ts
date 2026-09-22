// POST /api/robinhood/rpc-proxy -- the browser's route to the Robinhood Chain
// mainnet RPC provider (Chainstack). Same security model as
// api/mainnet/rpc-proxy.ts, narrowed to what the EVM side actually needs:
//
//  - The provider URL carries its API key, so it lives ONLY in the server env
//    (ROBINHOOD_RPC_URL) and never reaches the browser bundle.
//  - READ-ONLY. Every write on Robinhood (approve, mint, redeem, deploySSR) is
//    signed and broadcast by the user's own wallet through its own RPC, so
//    this proxy never needs eth_sendRawTransaction and refuses it.
//  - eth_getLogs must name a contract address: an unfiltered log scan is the
//    one read expensive enough to burn the plan, and the app never needs one.
//  - Per-IP burst throttle, batch and body size caps, brief retry on upstream
//    429/5xx, and a fall back to the public RPC when the key is unset so a
//    missing env var degrades to "rate-limited" rather than "broken".
//  - Calls the provider's plan refuses as "archive" (live 2026-09-22: the
//    Chainstack plan answers -32002 to eth_getLogs over history, which is
//    exactly what reserve discovery needs) are re-sent to the public RPC,
//    which serves them. Everything else stays on the keyed provider.
//
// Kept a separate module from the Solana proxies so a request can never be
// misrouted between chains.
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

export const PUBLIC_FALLBACK_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

export const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call", // every contract read, including Multicall3 batches and simulateContract
  "eth_getBalance", // gas balance shown on the reserve page
  "eth_getLogs", // reserve discovery (SSRDeployed on the factory) -- address required, see below
  "eth_getTransactionReceipt", // waitForTransactionReceipt after a wallet-sent tx
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "net_version",
]);

export const MAX_BATCH_SIZE = 50;
const MAX_BODY_BYTES = 100_000;
const THROTTLE_WINDOW_MS = 1_000;
const THROTTLE_MAX_PER_WINDOW = 60;
const UPSTREAM_RETRY_DELAYS_MS = [250, 750];

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

const err = (id: unknown, code: number, message: string): JsonRpcErrorResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Returns a reason to refuse this call, or null when it may be forwarded. */
export function rejectReason(item: unknown): JsonRpcErrorResponse | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return err(undefined, -32600, "Each entry must be a JSON-RPC 2.0 request object.");
  const r = item as JsonRpcRequest;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return err(r.id, -32600, "Malformed JSON-RPC request.");
  if (!ALLOWED_METHODS.has(r.method)) return err(r.id, -32601, "Method not permitted via this proxy.");
  if (r.method === "eth_getLogs") {
    const filter = Array.isArray(r.params) ? (r.params[0] as { address?: unknown } | undefined) : undefined;
    const addr = filter?.address;
    const ok = typeof addr === "string" ? /^0x[0-9a-fA-F]{40}$/.test(addr) : Array.isArray(addr) && addr.length > 0 && addr.length <= 10;
    if (!ok) return err(r.id, -32602, "eth_getLogs must be filtered to a contract address.");
  }
  return null;
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

export function upstreamUrl(): string {
  const url = process.env.ROBINHOOD_RPC_URL?.trim();
  return url && /^https:\/\//.test(url) ? url : PUBLIC_FALLBACK_RPC_URL;
}

/** The provider's "your plan can't serve this" answer, as opposed to a real call error. */
export function isPlanRefusal(r: unknown): boolean {
  const e = (r as { error?: { code?: number; message?: string } } | null)?.error;
  return !!e && (e.code === -32002 || /archive|not available on your current plan/i.test(e.message ?? ""));
}

async function forward(payload: unknown, url = upstreamUrl()): Promise<{ status: number; body: unknown }> {
  let last: { status: number; body: unknown } = { status: 502, body: { error: "Robinhood RPC unreachable." } };
  for (let attempt = 0; attempt <= UPSTREAM_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        // The public endpoint rejects runtimes' default user agents.
        headers: { "content-type": "application/json", "user-agent": "ssr.fun-rpc-proxy/1" },
        body: JSON.stringify(payload),
      });
      if (res.status !== 429 && res.status < 500) return { status: res.status, body: await res.json() };
      last = { status: res.status, body: { error: `Robinhood RPC responded ${res.status}.` } };
    } catch {
      last = { status: 502, body: { error: "Robinhood RPC unreachable." } };
    }
    const delay = UPSTREAM_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
  }
  return last;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!checkRateWindow(`robinhood-rpc-proxy:${clientIp(req)}`, THROTTLE_WINDOW_MS, THROTTLE_MAX_PER_WINDOW)) {
    res.status(429).json(err(null, -32005, "Too many requests to the Robinhood RPC proxy from this client."));
    return;
  }

  const rawBody = parseBody(req);
  const isBatch = Array.isArray(rawBody);
  const items: unknown[] = isBatch ? rawBody : [rawBody];
  if (items.length === 0 || items.length > MAX_BATCH_SIZE) {
    res.status(400).json({ error: `Request must contain between 1 and ${MAX_BATCH_SIZE} JSON-RPC calls.` });
    return;
  }
  const rawJson = JSON.stringify(rawBody);
  if (rawJson !== undefined && rawJson.length > MAX_BODY_BYTES) {
    res.status(400).json({ error: "Request body too large." });
    return;
  }

  // Refused calls are answered locally, in place; only allowed ones go upstream.
  const rejected = new Map<number, JsonRpcErrorResponse>();
  const toForward: { idx: number; call: unknown }[] = [];
  items.forEach((item, idx) => {
    const reason = rejectReason(item);
    if (reason) rejected.set(idx, reason);
    else toForward.push({ idx, call: item });
  });

  let forwarded: unknown[] = [];
  if (toForward.length > 0) {
    const up = await forward(toForward.map((f) => f.call));
    if (!Array.isArray(up.body)) {
      if (!isBatch && rejected.size === 0) {
        res.status(up.status).json(up.body);
        return;
      }
      forwarded = toForward.map((f) => err((f.call as JsonRpcRequest).id, -32603, "Upstream error."));
    } else {
      // Upstream batch replies are not guaranteed to be in request order: match by id.
      const byId = new Map((up.body as { id?: unknown }[]).map((r) => [JSON.stringify(r?.id ?? null), r]));
      forwarded = toForward.map((f) => byId.get(JSON.stringify((f.call as JsonRpcRequest).id ?? null)) ?? err((f.call as JsonRpcRequest).id, -32603, "Missing upstream response."));

      // Re-send plan-refused calls to the public RPC, once, and splice the answers back in.
      const refusedAt = forwarded.map((r, k) => (isPlanRefusal(r) ? k : -1)).filter((k) => k >= 0);
      if (refusedAt.length > 0 && upstreamUrl() !== PUBLIC_FALLBACK_RPC_URL) {
        const again = await forward(refusedAt.map((k) => toForward[k].call), PUBLIC_FALLBACK_RPC_URL);
        if (Array.isArray(again.body)) {
          const againById = new Map((again.body as { id?: unknown }[]).map((r) => [JSON.stringify(r?.id ?? null), r]));
          refusedAt.forEach((k) => {
            const hit = againById.get(JSON.stringify((toForward[k].call as JsonRpcRequest).id ?? null));
            if (hit) forwarded[k] = hit;
          });
        }
      }
    }
  }

  const out: unknown[] = new Array(items.length);
  rejected.forEach((v, i) => (out[i] = v));
  toForward.forEach((f, k) => (out[f.idx] = forwarded[k]));
  res.status(200).json(isBatch ? out : out[0]);
}
