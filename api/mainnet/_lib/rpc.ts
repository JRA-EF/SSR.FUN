import { Connection, type Commitment } from "@solana/web3.js";
// Shared server-side Mainnet RPC endpoint resolution -- mirrors
// api/devnet/_lib/rpc.ts exactly, pointed at the Mainnet Helius endpoint
// instead. Deliberately a separate module (not a parameterized shared one)
// so a DevNet code path can never accidentally resolve a Mainnet URL or
// vice versa -- see docs/project/DECISION_LOG.md's Mainnet-launch entries.
//
// HELIUS_MAINNET_RPC_URL is a server-only secret (the full
// https://.../?api-key=... URL) -- it must never be exposed to the browser
// (no VITE_ prefix) and is never echoed back in any response body or error
// message.
export const FALLBACK_RPC_URL = "https://api.mainnet-beta.solana.com";

export function resolveRpcUrl(): string {
  return process.env.HELIUS_MAINNET_RPC_URL || FALLBACK_RPC_URL;
}

/** See api/devnet/_lib/rpc.ts's redactRpcSecrets for why this exists -- identical reasoning, Mainnet variable. */
export function redactRpcSecrets(message: string): string {
  let out = message;
  const configuredUrls = [process.env.HELIUS_MAINNET_RPC_URL].filter((u): u is string => typeof u === "string" && u.length > 0);
  for (const url of configuredUrls) out = out.split(url).join("[redacted-rpc-url]");
  out = out.replace(/https?:\/\/[^\s"]*[?&](api[-_]?key|token)=[^\s"&]*/gi, "[redacted-rpc-url]");
  return out;
}

// --- Failover when the primary key is refused (2026-11-14 incident) ---
// Helius answered every call with "403 Forbidden", which took down mint
// builds, the fee keeper and every cron at once. A refused key (401/403) or a
// spent budget (429) means the request never ran, so it is always safe to
// repeat it on the public endpoint, sends included. Once refused, the
// primary is skipped for a minute so each call doesn't pay for the failure.

const PRIMARY_COOLDOWN_MS = 60_000;
let primaryRefusedUntil = 0;

/** True for statuses that mean the primary never ran the request. */
export function isRefusedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

/** fetch for web3.js: the primary first, the public endpoint when the primary refuses. */
export function failoverFetch(primaryUrl: string, fallbackUrl: string = FALLBACK_RPC_URL, baseFetch: typeof fetch = fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url !== primaryUrl || primaryUrl === fallbackUrl) return baseFetch(input, init);
    if (Date.now() < primaryRefusedUntil) return baseFetch(fallbackUrl, init);
    const res = await baseFetch(primaryUrl, init);
    if (!isRefusedStatus(res.status)) return res;
    primaryRefusedUntil = Date.now() + PRIMARY_COOLDOWN_MS;
    console.error(`mainnet rpc: primary refused (HTTP ${res.status}); using the public fallback for ${PRIMARY_COOLDOWN_MS / 1000}s`);
    return baseFetch(fallbackUrl, init);
  };
}

/** The server's Mainnet connection, with failover. Use this instead of new Connection(resolveRpcUrl()). */
export function mainnetConnection(commitment: Commitment = "confirmed"): Connection {
  const url = resolveRpcUrl();
  return new Connection(url, { commitment, fetch: failoverFetch(url) as any });
}

/** Test hook. */
export function resetRpcFailover(): void {
  primaryRefusedUntil = 0;
}
