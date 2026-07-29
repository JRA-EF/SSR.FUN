// Public reference to the real Solana DevNet SPL-token mint used as SSR's
// Phase B settlement token ("SSR Test USD" / devUSDC). See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B -- security
// model" for the full design, and scripts/create_devusdc_mint.ts for how this
// mint was actually created and verified on-chain.
//
// This mint has ZERO real value and exists only for DevNet testing. No
// on-chain Metaplex metadata exists for it (matching this repo's existing
// mintX/Y/Z convention -- see FRONTEND_INTEGRATION.md's "Canonical discovery"
// section) -- name/symbol here are an off-chain convenience label; the mint
// ADDRESS is canonical identity and must never be replaced by the label in
// any UI or validation logic.
import { PublicKey } from "@solana/web3.js";
import registry from "../fixtures/devusdc.json";

export interface DevUsdcRegistry {
  mint: string;
  decimals: number;
  symbol: string;
  name: string;
  tokenProgram: string;
  network: string;
  note: string;
}

export const DEVUSDC: DevUsdcRegistry = registry as DevUsdcRegistry;

export const DEVUSDC_MINT = new PublicKey(DEVUSDC.mint);
export const DEVUSDC_DECIMALS = DEVUSDC.decimals;
