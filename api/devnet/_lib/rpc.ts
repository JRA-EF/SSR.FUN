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
