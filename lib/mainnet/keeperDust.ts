// DEC-0270: the fee keeper's dust rules (pure, no I/O). Every keeper swap or
// distribute costs about 65,000 lamports (base fee + priority fee on the full
// compute budget, ~$0.013), and every Jupiter call counts against the shared
// rate limit. Leftovers worth a fraction of a cent were retried every hour for
// 31 Reserves, the run spent its time budget on them, and the TVL accruals
// queued behind them were skipped (Reserve 61 went 41 h without one, live
// 2026-10-28). Dust now waits until it is worth moving; nothing is lost, it
// just accumulates in the same staging account or fee vault.

/** A staged non-USDC leg is swapped only when it is worth at least this much. */
export const KEEPER_MIN_SWAP_USD = 0.05;
/** Staged USDC is distributed only when it is worth at least this much (a distribute costs ~$0.013). */
export const KEEPER_MIN_DISTRIBUTE_USD = 0.02;
/** Fee vault shares are redeemed into staging only when they are worth at least this much. */
export const KEEPER_MIN_REDEEM_USD = 0.05;
/** A leg or vault the keeper cannot price is attempted once a day, in this UTC hour, instead of every hour. */
export const KEEPER_UNPRICED_RETRY_UTC_HOUR = 0;

export const USDC_DECIMALS = 6;
export const RESERVE_TOKEN_DECIMALS = 6;

export type DustDecision = "move" | "dust" | "unpriced-wait";

function usdValue(amountRaw: bigint, decimals: number, usdPrice: number): number {
  return (Number(amountRaw) / 10 ** decimals) * usdPrice;
}

function priced(usdPrice: number | null | undefined): usdPrice is number {
  return typeof usdPrice === "number" && Number.isFinite(usdPrice) && usdPrice > 0;
}

/** Whether a staged (or keeper-held) non-USDC amount is worth a Jupiter swap this run. */
export function stagedLegDecision(amountRaw: bigint, decimals: number, usdPrice: number | null | undefined, utcHour: number): DustDecision {
  if (amountRaw <= 0n) return "dust";
  if (!priced(usdPrice)) return utcHour === KEEPER_UNPRICED_RETRY_UTC_HOUR ? "move" : "unpriced-wait";
  return usdValue(amountRaw, decimals, usdPrice) >= KEEPER_MIN_SWAP_USD ? "move" : "dust";
}

/** Whether staged USDC is worth a distribute transaction. */
export function stagedUsdcWorthDistributing(amountRaw: bigint): boolean {
  return amountRaw > 0n && usdValue(amountRaw, USDC_DECIMALS, 1) >= KEEPER_MIN_DISTRIBUTE_USD;
}

/**
 * USD value of one Reserve Token from the Reserve's own vaults (sum of vault
 * balance x price, divided by supply), or null when any held asset is
 * unpriced or the supply is zero.
 */
export function navPerReserveTokenUsd(
  assets: { assetMint: string; decimals: number; vaultBalanceRaw: string }[],
  supplyRaw: string,
  priceOf: (mint: string) => number | null | undefined,
): number | null {
  let supply: bigint;
  try { supply = BigInt(supplyRaw); } catch { return null; }
  if (supply <= 0n) return null;
  let total = 0;
  for (const a of assets) {
    let bal: bigint;
    try { bal = BigInt(a.vaultBalanceRaw); } catch { return null; }
    if (bal === 0n) continue;
    const p = priceOf(a.assetMint);
    if (!priced(p)) return null;
    total += usdValue(bal, a.decimals, p);
  }
  return total / (Number(supply) / 10 ** RESERVE_TOKEN_DECIMALS);
}

/** Whether the fee vault's shares are worth redeeming into staging this run. */
export function vaultDecision(sharesRaw: bigint, navUsd: number | null, utcHour: number): DustDecision {
  if (sharesRaw <= 0n) return "dust";
  if (navUsd === null || !Number.isFinite(navUsd)) return utcHour === KEEPER_UNPRICED_RETRY_UTC_HOUR ? "move" : "unpriced-wait";
  return usdValue(sharesRaw, RESERVE_TOKEN_DECIMALS, navUsd) >= KEEPER_MIN_REDEEM_USD ? "move" : "dust";
}
