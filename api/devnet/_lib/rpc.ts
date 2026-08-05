// Shared server-side DevNet RPC endpoint resolution for every api/devnet/*.ts
// handler (faucet-devusdc, sponsor-sol, mint-test-assets, swap-sign,
// rpc-proxy). Centralized so a single env var switches every server-side
// Solana read/write onto a dedicated provider (Helius) instead of each file
// duplicating its own literal default -- see docs/project/DECISION_LOG.md's
// Helius-integration entry.
//
// HELIUS_RPC_URL is a server-only secret (the full https://.../?api-key=...
// URL) -- it must never be exposed to the browser (no VITE_ prefix) and is
// never echoed back in any response body or error message.
export const FALLBACK_RPC_URL = "https://api.devnet.solana.com";

export function resolveRpcUrl(): string {
  return process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || FALLBACK_RPC_URL;
}

/**
 * Defense in depth: strips any embedded RPC URL/API key from an error
 * message before it is ever logged or sent to a client. The comment above
 * states HELIUS_RPC_URL is "never echoed back" as a design intent, but a
 * genuine network-level failure (a fetch/DNS error, a Connection transport
 * error) can legitimately include the full request URL -- including
 * `?api-key=...` -- in its own `.message` text, which this repo has no
 * control over (it comes from @solana/web3.js/undici, not this codebase).
 * Call this on any error message that might reach a response body or log
 * line, not just ones this code directly constructs.
 */
export function redactRpcSecrets(message: string): string {
  let out = message;
  const configuredUrls = [process.env.HELIUS_RPC_URL, process.env.SOLANA_RPC_URL].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  for (const url of configuredUrls) out = out.split(url).join("[redacted-rpc-url]");
  // Catches the same case even if the exact configured value isn't matched
  // verbatim (e.g. a differently-percent-encoded copy of the same URL).
  out = out.replace(/https?:\/\/[^\s"]*[?&](api[-_]?key|token)=[^\s"&]*/gi, "[redacted-rpc-url]");
  return out;
}
