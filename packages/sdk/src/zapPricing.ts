import { PublicKey } from "@solana/web3.js";

// Fixed, DevNet-only test pricing for the SOL<->fixture-asset zap adapter
// (see docs/protocol/FRONTEND_INTEGRATION.md "DevNet swap adapter"). The
// deployed protocol has no oracle and no price discovery of its own; these
// numbers exist ONLY so a small, fixed-rate DevNet test swap can convert a
// SOL amount into the specific fixture-asset amounts a real
// mint_reserve_tokens_in_kind call needs, and back. They are not derived from
// any market and must never be presented as real prices.
export const SOL_TEST_PRICE_USD = 20;

/** The canonical SPL wrapped-SOL mint -- same address on every Solana cluster (DevNet, Mainnet, etc). */
export const WRAPPED_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * DEC-0244: users only ever see "SOL". Vaults hold SOL as wrapped SOL (an
 * SPL token account is the only way the program can custody it), but every
 * Mainnet flow wraps and unwraps inside its own transaction, so the wrapper
 * is an implementation detail -- Jupiter's catalogue calls this mint
 * "Wrapped SOL", which must never reach the UI.
 */
export function displayAssetIdentity(mint: string, symbol: string, name: string | null | undefined): { symbol: string; name: string } {
  if (mint === WRAPPED_SOL_MINT.toBase58()) return { symbol: "SOL", name: "Solana" };
  return { symbol, name: name || symbol };
}

export function solLamportsToUsd(lamports: bigint): number {
  return (Number(lamports) / 1_000_000_000) * SOL_TEST_PRICE_USD;
}

export function usdToSolLamports(usd: number): bigint {
  return BigInt(Math.floor((usd / SOL_TEST_PRICE_USD) * 1_000_000_000));
}
