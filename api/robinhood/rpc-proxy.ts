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
//  - Who can reach it: only a signed-in site session (middleware gate; the
//    cookie is SameSite=Strict + HttpOnly, so another website cannot spend a
//    visitor's session), and raw *.vercel.app URLs sit behind Vercel
//    deployment protection. The key itself never leaves the server.
//  - How much they can spend: budgets are counted in JSON-RPC CALLS, not HTTP
//    requests (a batch of 20 costs 20), per IP and globally across every
//    serverless instance via the durable Neon window. A real page load costs
//    ~6-7 calls (measured 2026-09-22; reads collapse through Multicall3), so
//    the per-IP budget is ~17 page loads a minute and the global budget bounds
//    what even a scripted beta-key holder on many IPs can burn off the plan.
//  - Batch and body size caps, brief retry on upstream 429/5xx, and a fall
//    back to the public RPC when the key is unset so a missing env var
//    degrades to "rate-limited" rather than "broken".
//  - Calls the provider's plan refuses as "archive" (live 2026-09-22: the
//    Chainstack plan answers -32002 to eth_getLogs over history, which is
//    exactly what reserve discovery needs) are re-sent to the public RPC,
//    which serves them. Everything else stays on the keyed provider.
//
// Kept a separate module from the Solana proxies so a request can never be
// misrouted between chains.
import { checkDurableRateWindow } from "../../lib/rate-limit/durableRateWindow";
import { getSql } from "../../lib/rate-limit/db";

export interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
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

export const MAX_BATCH_SIZE = 20;
const MAX_BODY_BYTES = 50_000;
const BUDGET_WINDOW_MS = 60_000;
/** JSON-RPC calls per IP per minute (~17 page loads). */
export const PER_IP_CALLS_PER_MIN = 120;
/** JSON-RPC calls per minute across ALL clients and instances. */
export const GLOBAL_CALLS_PER_MIN = 1_200;
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

// Per-instance L1, weighted by calls. Only line of defence if the durable
// window's database is unreachable (it fails open by design).
const l1 = new Map<string, { start: number; used: number }>();
export function takeLocal(key: string, calls: number, max: number, windowMs: number, now = Date.now()): boolean {
  const e = l1.get(key);
  if (!e || now - e.start >= windowMs) {
    l1.set(key, { start: now, used: calls });
    return calls <= max;
  }
  if (e.used + calls > max) return false;
  e.used += calls;
  return true;
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

/**
 * One upstream per EVM chain. The browser picks with `?chain=<key>`; no query
 * means Robinhood, so every request this proxy served before is unchanged.
 * Each chain's keyed URL is its own server-only env var, and each chain has
 * its own rate budget, so a busy chain cannot starve another.
 *
 * `fallback` is that chain's public endpoint, used when the env var is unset
 * and as the target for calls the keyed plan refuses as "archive". Measured
 * 2026-10-06: BNB's publicnode serves eth_getLogs up to 5,000 blocks (every
 * other public BSC endpoint refuses it), Base's public RPC up to 500.
 */
export const UPSTREAMS: Record<string, { env: string; fallback: string; logsUrl?: string }> = {
  robinhood: { env: "ROBINHOOD_RPC_URL", fallback: PUBLIC_FALLBACK_RPC_URL },
  // No single free BNB endpoint serves both (measured 2026-10-06, live): only
  // publicnode answers eth_getLogs, and publicnode refuses even a fresh
  // transaction's receipt as an "archive request". defibit serves receipts,
  // state and sends, but refuses getLogs. So without a keyed URL, logs go to
  // publicnode and everything else to defibit -- otherwise every BNB write
  // would land and then fail to confirm in the UI.
  bnb: { env: "BNB_RPC_URL", fallback: "https://bsc-dataseed1.defibit.io", logsUrl: "https://bsc-rpc.publicnode.com" },
  // Same split on Base (measured 2026-10-06): publicnode serves getLogs up to
  // 2,000 blocks but refuses receipts and older state; mainnet.base.org serves
  // receipts and archive state but caps getLogs below 500 blocks.
  base: { env: "BASE_RPC_URL", fallback: "https://mainnet.base.org", logsUrl: "https://base-rpc.publicnode.com" },
  // Ethereum's publicnode serves receipts and getLogs (<= 10,000 blocks) alike.
  ethereum: { env: "ETHEREUM_RPC_URL", fallback: "https://ethereum-rpc.publicnode.com" },
};

/** The chain a request names, or null for one this proxy does not serve. Absent means Robinhood. */
export function chainOf(req: Pick<ApiRequest, "query">): string | null {
  const raw = req.query?.chain;
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim() || "robinhood";
  return UPSTREAMS[key] ? key : null;
}

export function fallbackUrl(chain = "robinhood"): string {
  return UPSTREAMS[chain].fallback;
}

export function upstreamUrl(chain = "robinhood"): string {
  const url = process.env[UPSTREAMS[chain].env]?.trim();
  return url && /^https:\/\//.test(url) ? url : UPSTREAMS[chain].fallback;
}

/** The PUBLIC endpoint for one method on a chain: its logs endpoint for eth_getLogs when it has one. */
export function publicUrlFor(chain: string, method: unknown): string {
  const u = UPSTREAMS[chain];
  return method === "eth_getLogs" && u.logsUrl ? u.logsUrl : u.fallback;
}

/** Where one call goes: the chain's keyed URL when set, else the right public endpoint for its method. */
export function urlFor(chain: string, method: unknown): string {
  const keyed = upstreamUrl(chain);
  return keyed !== UPSTREAMS[chain].fallback ? keyed : publicUrlFor(chain, method);
}

/** The provider's "your plan can't serve this" answer, as opposed to a real call error. */
export function isPlanRefusal(r: unknown): boolean {
  const e = (r as { error?: { code?: number; message?: string } } | null)?.error;
  return !!e && (e.code === -32002 || /archive|not available on your current plan/i.test(e.message ?? ""));
}

async function forward(payload: unknown, url: string): Promise<{ status: number; body: unknown }> {
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
  const chain = chainOf(req);
  if (!chain) {
    res.status(400).json({ error: `Unknown chain. Use one of: ${Object.keys(UPSTREAMS).join(", ")}.` });
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

  // Spend the budget BEFORE anything goes upstream: one unit per call.
  const ip = clientIp(req);
  const cost = items.length;
  if (!takeLocal(`${chain}:ip:${ip}`, cost, PER_IP_CALLS_PER_MIN, BUDGET_WINDOW_MS)) {
    res.status(429).json(err(null, -32005, "Too many Robinhood RPC calls from this client. Try again in a minute."));
    return;
  }
  // getSql() throws when DATABASE_URL is unset; treat that like a DB outage
  // (fail open to the L1 above) rather than crashing the proxy.
  let sql: Parameters<typeof checkDurableRateWindow>[0] | null = null;
  try {
    sql = getSql() as unknown as Parameters<typeof checkDurableRateWindow>[0];
  } catch {
    sql = null;
  }
  const open = { allowed: true, durable: false, count: 0 };
  const [perIp, global] = sql
    ? await Promise.all([
        checkDurableRateWindow(sql, chain === "robinhood" ? `robinhood-rpc:ip:${ip}` : `evm-rpc:${chain}:ip:${ip}`, BUDGET_WINDOW_MS, PER_IP_CALLS_PER_MIN, Date.now(), cost),
        checkDurableRateWindow(sql, chain === "robinhood" ? "robinhood-rpc:global" : `evm-rpc:${chain}:global`, BUDGET_WINDOW_MS, GLOBAL_CALLS_PER_MIN, Date.now(), cost),
      ])
    : [open, open];
  if (!perIp.allowed || !global.allowed) {
    res.status(429).json(err(null, -32005, global.allowed ? "Too many Robinhood RPC calls from this client. Try again in a minute." : "Robinhood RPC is busy. Try again in a minute."));
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

  let forwarded: unknown[] = new Array(toForward.length);
  if (toForward.length > 0) {
    const idOf = (k: number) => JSON.stringify((toForward[k].call as JsonRpcRequest).id ?? null);
    const methodOf = (k: number) => (toForward[k].call as JsonRpcRequest).method;
    // Group calls by destination: on a chain with a separate logs endpoint a
    // single batch can need two upstreams. Robinhood (one upstream) sends one
    // batch exactly as before.
    const groups = new Map<string, number[]>();
    toForward.forEach((_, k) => {
      const url = urlFor(chain, methodOf(k));
      groups.set(url, [...(groups.get(url) ?? []), k]);
    });
    for (const [url, ks] of groups) {
      const up = await forward(ks.map((k) => toForward[k].call), url);
      if (!Array.isArray(up.body)) {
        if (!isBatch && rejected.size === 0 && toForward.length === 1) {
          res.status(up.status).json(up.body);
          return;
        }
        ks.forEach((k) => (forwarded[k] = err((toForward[k].call as JsonRpcRequest).id, -32603, "Upstream error.")));
        continue;
      }
      // Upstream batch replies are not guaranteed to be in request order: match by id.
      const byId = new Map((up.body as { id?: unknown }[]).map((r) => [JSON.stringify(r?.id ?? null), r]));
      ks.forEach((k) => (forwarded[k] = byId.get(idOf(k)) ?? err((toForward[k].call as JsonRpcRequest).id, -32603, "Missing upstream response.")));
    }

    // Re-send calls a KEYED plan refused to the public endpoint for their
    // method, once, and splice the answers back in.
    const refusedAt = forwarded.map((r, k) => (isPlanRefusal(r) && urlFor(chain, methodOf(k)) !== publicUrlFor(chain, methodOf(k)) ? k : -1)).filter((k) => k >= 0);
    const retryGroups = new Map<string, number[]>();
    refusedAt.forEach((k) => {
      const url = publicUrlFor(chain, methodOf(k));
      retryGroups.set(url, [...(retryGroups.get(url) ?? []), k]);
    });
    for (const [url, ks] of retryGroups) {
      const again = await forward(ks.map((k) => toForward[k].call), url);
      if (!Array.isArray(again.body)) continue;
      const againById = new Map((again.body as { id?: unknown }[]).map((r) => [JSON.stringify(r?.id ?? null), r]));
      ks.forEach((k) => {
        const hit = againById.get(idOf(k));
        if (hit) forwarded[k] = hit;
      });
    }
  }

  const out: unknown[] = new Array(items.length);
  rejected.forEach((v, i) => (out[i] = v));
  toForward.forEach((f, k) => (out[f.idx] = forwarded[k]));
  res.status(200).json(isBatch ? out : out[0]);
}
