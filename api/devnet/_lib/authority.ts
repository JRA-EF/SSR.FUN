// Shared loader for the DevNet-only server-side authority keypair, reused
// across api/devnet/swap-sign.ts, api/devnet/mint-test-assets.ts, and Phase
// B's api/devnet/faucet-devusdc.ts / api/devnet/sponsor-sol.ts. One secret
// (DEVNET_SWAP_AUTHORITY_SECRET_KEY), several DevNet-only roles -- see
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B -- security
// model" for the reuse tradeoff this makes explicit rather than hiding.
//
// Never logged, never returned to a client, never imported by any
// browser-bundled file (this lives in lib/, which api/*.ts server functions
// import -- Vite never bundles this into the client).
import { Keypair } from "@solana/web3.js";

export function loadDevnetAuthority(): Keypair {
  const raw = process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY;
  if (!raw) throw new Error("DEVNET_SWAP_AUTHORITY_SECRET_KEY is not configured");
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
