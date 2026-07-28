// Client-side Solana network configuration for the DevNet testing phase.
// All values are PUBLIC (RPC URL, program ID, cluster name) -- safe to bundle
// into the browser. Real secrets (the DevNet swap-adapter signer) never live
// here; see api/devnet/swap-sign.ts and .env.example.
import { PublicKey } from "@solana/web3.js";

export const SOLANA_CLUSTER = (import.meta.env.VITE_SOLANA_CLUSTER as string) || "devnet";

export const SOLANA_RPC_URL = (import.meta.env.VITE_SOLANA_RPC_URL as string) || "https://api.devnet.solana.com";

export const SSR_PROGRAM_ID = new PublicKey(
  (import.meta.env.VITE_SSR_PROGRAM_ID as string) || "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
);

export const IS_DEVNET = SOLANA_CLUSTER === "devnet";

/** Solana Explorer URL for an address or transaction signature, always DevNet-tagged in this testing phase. */
export function explorerUrl(kind: "address" | "tx", value: string): string {
  const cluster = SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
  return `https://explorer.solana.com/${kind === "tx" ? "tx" : "address"}/${value}${cluster}`;
}
