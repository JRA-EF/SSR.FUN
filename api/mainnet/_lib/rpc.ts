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
