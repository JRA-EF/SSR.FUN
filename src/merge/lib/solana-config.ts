// Client-side Solana network configuration -- cluster-aware since the
// Mainnet launch (2026-08-19, see docs/project/DECISION_LOG.md). All values
// are PUBLIC (RPC URL, program ID, cluster name) -- safe to bundle into the
// browser. Real secrets (the DevNet swap-adapter signer, either Helius URL)
// never live here; see api/devnet/swap-sign.ts, api/mainnet/rpc-proxy.ts,
// and .env.example. VITE_SOLANA_CLUSTER is the single switch that
// determines every other default below -- DevNet and Mainnet values are
// never mixed (see the Mainnet-launch decision log entry's explicit
// requirement that the two configurations can't cross).
import { PublicKey } from "@solana/web3.js";

export const SOLANA_CLUSTER = (import.meta.env.VITE_SOLANA_CLUSTER as string) || "devnet";

export const IS_DEVNET = SOLANA_CLUSTER === "devnet";
export const IS_MAINNET = SOLANA_CLUSTER === "mainnet-beta";

// The dedicated RPC provider (Helius) is only ever reached through the
// matching server-side proxy (api/devnet/rpc-proxy.ts or
// api/mainnet/rpc-proxy.ts) -- its URL/API key is a server-only secret and
// must never be bundled here. A production build (Preview or Production on
// Vercel, where api/* functions are actually served) defaults to the
// cluster-matched same-origin proxy path; a plain local `vite dev` session
// (which serves no api/* functions at all) keeps defaulting to the matching
// public endpoint. VITE_SOLANA_RPC_URL is still an explicit override for
// either case -- it must never be set to a URL containing a raw provider API
// key.
const DEFAULT_RPC_URL = import.meta.env.PROD && typeof window !== "undefined"
  ? `${window.location.origin}${IS_MAINNET ? "/api/mainnet/rpc-proxy" : "/api/devnet/rpc-proxy"}`
  : IS_MAINNET
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";

export const SOLANA_RPC_URL = (import.meta.env.VITE_SOLANA_RPC_URL as string) || DEFAULT_RPC_URL;

/** Base58 shape check (Solana pubkeys are 32-44 base58 chars). */
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Construct a PublicKey from an UNTRUSTED string (an env var, or API/localStorage
 * data), falling back to `fallback` when it is not valid base58. A misconfigured
 * env must DEGRADE, never throw at module load and white-screen the whole app.
 *
 * 2026-09-03 incident: `VITE_SSR_PROGRAM_ID` was marked "Secret" in Vercel, so a
 * client build baked the literal placeholder string "[SENSITIVE]" for it. That
 * string is truthy, so the `|| <default>` fallback below never fired, and
 * `new PublicKey("[SENSITIVE]")` threw "Non-base58 character" on load -> blank
 * site. This guard makes any such value (placeholder, typo, wrong length) fall
 * back to the correct default instead of crashing.
 */
export function safePublicKey(value: string | undefined | null, fallback: string): PublicKey {
  if (value && BASE58_ADDRESS_RE.test(value)) {
    try {
      return new PublicKey(value);
    } catch {
      // valid base58 chars but not a valid 32-byte key -> fall through
    }
  }
  return new PublicKey(fallback);
}

export const SSR_PROGRAM_ID = safePublicKey(
  import.meta.env.VITE_SSR_PROGRAM_ID as string | undefined,
  IS_MAINNET ? "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9" : "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
);

/** Mainnet only: the Squads Treasury vault, the protocol-fee destination. Never the Squads Multisig Account address -- see docs/project/PROJECT_STATUS.md's Authority & Treasury Structure section. */
export const MAINNET_TREASURY_VAULT = "3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5";

/** Mainnet only: the sole supported Reserve Asset for this launch (real Circle USDC) -- see the Mainnet-launch decision log entry for the USDC-only scoping decision. */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Solana Explorer URL for an address or transaction signature, cluster-tagged via SOLANA_CLUSTER (the query param is omitted entirely for Mainnet, Explorer's own default). */
export function explorerUrl(kind: "address" | "tx", value: string): string {
  const cluster = SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
  return `https://explorer.solana.com/${kind === "tx" ? "tx" : "address"}/${value}${cluster}`;
}

/** Solscan URL for an address or transaction signature, tagged with the correct cluster (omitted for Mainnet, which is Solscan's default). */
export function solscanUrl(kind: "address" | "tx", value: string): string {
  const cluster = SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
  return `https://solscan.io/${kind === "tx" ? "tx" : "account"}/${value}${cluster}`;
}
