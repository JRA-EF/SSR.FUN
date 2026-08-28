// Pure validation for the Reserve Asset Entry Price Store's capture request
// -- dependency-free so it's directly testable offline, mirroring
// lib/reserve-image/payload.ts's precedent. The request only ever names
// WHICH (reserve, mint) pairs to capture; the price itself is always
// resolved server-side (see api/mainnet/reserve-entry-prices.ts), so there
// is deliberately no price field to validate here.

export interface EntryPricePair {
  reserve: string;
  mint: string;
  decimals: number;
}

/** Base58 Solana account address (same shape check as lib/reserve-image/payload.ts's RESERVE_ADDRESS_RE). */
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Hard cap on pairs per capture request: the 12-asset product standard
 * (DEC-0167) times a generous margin for a discovery pass covering every
 * Reserve at once. Protects this public endpoint against an abusive
 * payload, same reasoning as MAX_IMAGE_BYTES.
 */
export const MAX_PAIRS_PER_REQUEST = 240;

/**
 * Validates the POST body's `pairs` into a deduplicated EntryPricePair
 * list, or throws a plain-language error. Never trusts the caller's shape
 * -- this is the one place every capture request goes through.
 */
export function validateEntryPricePairs(pairs: unknown): EntryPricePair[] {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error("The entry-price request is missing its list of Reserve assets.");
  }
  if (pairs.length > MAX_PAIRS_PER_REQUEST) {
    throw new Error(`The entry-price request names too many Reserve assets (max ${MAX_PAIRS_PER_REQUEST}).`);
  }
  const seen = new Set<string>();
  const out: EntryPricePair[] = [];
  for (const entry of pairs) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each entry-price request item must name a Reserve and an asset.");
    }
    const { reserve, mint, decimals } = entry as Record<string, unknown>;
    if (typeof reserve !== "string" || !ADDRESS_RE.test(reserve)) {
      throw new Error("An entry-price request item's Reserve address is not a valid Solana account address.");
    }
    if (typeof mint !== "string" || !ADDRESS_RE.test(mint)) {
      throw new Error("An entry-price request item's asset address is not a valid Solana account address.");
    }
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error("An entry-price request item's decimals value is not valid.");
    }
    const key = `${reserve}:${mint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ reserve, mint, decimals });
  }
  return out;
}
