// Pure amount/decimal/USD-valuation helpers -- no DB/network dependency,
// directly unit-tested. Raw amounts are always decimal strings (never a JS
// `number`, matching packages/sdk/src/activityLog.ts's addBig -- see that
// file's comment for why: a real u64 Reserve Token amount can exceed
// Number.MAX_SAFE_INTEGER). Normalized amounts are `number` ONLY for
// display/reporting -- never re-fed into another raw computation.

export function normalizeRawAmount(raw: string | null | undefined, decimals: number | null | undefined): number | null {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  let big: bigint;
  try {
    big = BigInt(raw);
  } catch {
    return null;
  }
  return Number(big) / 10 ** decimals;
}

export type UsdPriceSource =
  /** A fixed constant, not a live market price -- DevNet's TEST_ASSET_PRICES_USD/SOL_TEST_PRICE_USD/devUSDC=$1. Never presented as real market data. */
  | "devnet-fixed-test-price"
  /** A real price oracle (Pyth or similar) -- Mainnet-only, not wired up yet (see docs/protocol/LEDGER_ARCHITECTURE.md's Mainnet-readiness note). */
  | "pyth"
  /** Design-time assumption that a Reserve Token trades at its own NAV, itself derived from underlying composition -- an approximation, not a market quote. */
  | "reserve-token-nav-approximation"
  /** No price could be determined -- usd_value_at_event is left null, never fabricated as 0 or an invented number. */
  | "unavailable";

export interface UsdValuation {
  usdPriceAtEvent: number | null;
  usdPriceSource: UsdPriceSource;
  usdValueAtEvent: number | null;
}

/**
 * Never fabricates a USD figure it cannot actually source. If `unitPriceUsd`
 * is null (no price source available for this asset/cluster), the whole
 * valuation is `unavailable` with every numeric field null -- an honest gap,
 * not an invented one. Matches principle: "Do not fabricate historical
 * values that cannot be reconstructed."
 */
export function computeUsdValuation(normalizedAmount: number | null, unitPriceUsd: number | null, source: UsdPriceSource): UsdValuation {
  if (normalizedAmount === null || unitPriceUsd === null || source === "unavailable") {
    return { usdPriceAtEvent: null, usdPriceSource: "unavailable", usdValueAtEvent: null };
  }
  return { usdPriceAtEvent: unitPriceUsd, usdPriceSource: source, usdValueAtEvent: normalizedAmount * unitPriceUsd };
}

/** BigInt-safe sum of raw decimal-string amounts -- see activityLog.ts's addBig for the same pattern; duplicated here (not imported) so lib/ledger has zero runtime dependency on packages/sdk beyond what it already needs for RPC types, keeping this module trivially portable. */
export function sumRawAmounts(vals: (string | null | undefined)[]): string {
  return vals.reduce((sum: bigint, v) => sum + BigInt(v && v.length > 0 ? v : "0"), 0n).toString();
}

export type ActorRole = "creator" | "manager" | "delegate" | "protocol" | "keeper" | "holder" | "unknown";

/**
 * Best-effort actor-role classification from wallet-identity comparisons
 * already available at decode time (no extra RPC call). Falls back to
 * "unknown" rather than guessing -- an unclassified actor is an honest gap
 * a report can flag, not a silently wrong label.
 */
export function classifyActorRole(actorWallet: string | null, context: { reserveManager?: string | null; reserveCreator?: string | null; knownDelegates?: string[]; protocolTreasury?: string | null; isKeeperTriggered?: boolean }): ActorRole {
  if (!actorWallet) return "unknown";
  if (context.isKeeperTriggered) return "keeper";
  if (context.protocolTreasury && actorWallet === context.protocolTreasury) return "protocol";
  if (context.reserveManager && actorWallet === context.reserveManager) return "manager";
  if (context.reserveCreator && actorWallet === context.reserveCreator) return "creator";
  if (context.knownDelegates?.includes(actorWallet)) return "delegate";
  return "holder";
}
