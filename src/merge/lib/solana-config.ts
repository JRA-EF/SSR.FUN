// Client-side Solana network configuration for the DevNet testing phase.
// All values are PUBLIC (RPC URL, program ID, cluster name) -- safe to bundle
// into the browser. Real secrets (the DevNet swap-adapter signer) never live
// here; see api/devnet/swap-sign.ts and .env.example.
import { PublicKey } from "@solana/web3.js";

export const SOLANA_CLUSTER = (import.meta.env.VITE_SOLANA_CLUSTER as string) || "devnet";

// The dedicated DevNet RPC provider (Helius) is only ever reached through
// the server-side proxy (api/devnet/rpc-proxy.ts) -- its URL/API key is a
// server-only secret and must never be bundled here. A production build
// (Preview or Production on Vercel, where api/* functions are actually
// served) defaults to this same-origin proxy path; a plain local `vite dev`
// session (which serves no api/* functions at all) keeps defaulting to the
// public DevNet endpoint, unchanged from before. VITE_SOLANA_RPC_URL is
// still an explicit override for either case -- it must never be set to a
// URL containing a raw provider API key.
const DEFAULT_RPC_URL = import.meta.env.PROD && typeof window !== "undefined" ? `${window.location.origin}/api/devnet/rpc-proxy` : "https://api.devnet.solana.com";

export const SOLANA_RPC_URL = (import.meta.env.VITE_SOLANA_RPC_URL as string) || DEFAULT_RPC_URL;

export const SSR_PROGRAM_ID = new PublicKey(
  (import.meta.env.VITE_SSR_PROGRAM_ID as string) || "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
);

export const IS_DEVNET = SOLANA_CLUSTER === "devnet";

/** Solana Explorer URL for an address or transaction signature, always DevNet-tagged in this testing phase. */
export function explorerUrl(kind: "address" | "tx", value: string): string {
  const cluster = SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
  return `https://explorer.solana.com/${kind === "tx" ? "tx" : "address"}/${value}${cluster}`;
}

/** Solscan URL for an address or transaction signature, tagged with the correct cluster (omitted for Mainnet, which is Solscan's default). */
export function solscanUrl(kind: "address" | "tx", value: string): string {
  const cluster = SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
  return `https://solscan.io/${kind === "tx" ? "tx" : "account"}/${value}${cluster}`;
}
