// Fixed, DevNet-only test pricing for the SOL<->fixture-asset zap adapter
// (see docs/protocol/FRONTEND_INTEGRATION.md "DevNet swap adapter"). The
// deployed protocol has no oracle and no price discovery of its own; these
// numbers exist ONLY so a small, fixed-rate DevNet test swap can convert a
// SOL amount into the specific fixture-asset amounts a real
// mint_reserve_tokens_in_kind call needs, and back. They are not derived from
// any market and must never be presented as real prices.
export const SOL_TEST_PRICE_USD = 20;

export function solLamportsToUsd(lamports: bigint): number {
  return (Number(lamports) / 1_000_000_000) * SOL_TEST_PRICE_USD;
}

export function usdToSolLamports(usd: number): bigint {
  return BigInt(Math.floor((usd / SOL_TEST_PRICE_USD) * 1_000_000_000));
}
