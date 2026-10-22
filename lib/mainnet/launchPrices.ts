// Pool launch prices for a Reserve's assets (initialReserveAtNav).
//
// Jupiter Price V3 reports each token's price with the block of its last
// trade (`blockId`). The launch refuses a price older than
// LAUNCH_PRICE_MAX_AGE_SLOTS (~10 minutes), so a thinly traded asset -- a
// pump.fun token with no swap in the last half hour -- blocked every pool
// launch for its Reserve even though its pools still quote it (live
// 2026-10-22: BpdH...pump, last trade ~4,300 slots back).
//
// For such an asset this asks Jupiter for a live quote both ways (USDC -> token,
// then that token amount back -> USDC) and uses the geometric mean of the two
// implied prices, stamped with the quote's own context slot. A quote reads the
// pools' current state, so it is current even when nobody traded. When the
// two directions differ by more than MAX_QUOTE_SPREAD (thin or broken
// liquidity), or Jupiter cannot quote it, the last traded price is accepted
// as long as it is under LOW_VOLUME_MAX_AGE_SLOTS (~24 hours) old: a
// low-volume token does not need a 10-minute-fresh price (Creator rule,
// 2026-10-22). Only a price older than that still refuses the launch.
import type { JupiterCallResult, JupiterQuote, JupiterQuoteParams } from "./jupiter";
import { MAINNET_USDC_MINT } from "./jupiter";

export interface LaunchPrice {
  usdPrice?: number | null;
  decimals?: number | null;
  blockId?: number | null;
}

/** USDC used to probe the price: small enough for negligible impact, large enough to clear dust rounding. */
export const QUOTE_PROBE_USDC_RAW = 10_000_000n;
/** Buy-side over sell-side implied price above this ratio is too wide to price a launch from. */
export const MAX_QUOTE_SPREAD = 1.05;
/** Creator rule 2026-10-22: a low-volume token's last traded price is good enough for a launch up to ~24 hours (400 ms slots). */
export const LOW_VOLUME_MAX_AGE_SLOTS = 216_000;

export interface LaunchPriceDeps {
  prices: (mints: string[]) => Promise<Map<string, LaunchPrice>>;
  quote: (p: Omit<JupiterQuoteParams, "apiKey">) => Promise<JupiterCallResult<JupiterQuote>>;
  currentSlot: () => Promise<number>;
  maxAgeSlots: number;
}

/** Pure: the price implied by a USDC -> token quote and its token -> USDC return quote, or null when unusable or too wide. */
export function priceFromQuotes(decimals: number, usdcIn: bigint, tokensOut: bigint, usdcBack: bigint): number | null {
  if (usdcIn <= 0n || tokensOut <= 0n || usdcBack <= 0n) return null;
  const tokens = Number(tokensOut) / 10 ** decimals;
  const buy = Number(usdcIn) / 1e6 / tokens;
  const sell = Number(usdcBack) / 1e6 / tokens;
  if (!(buy > 0 && sell > 0) || buy / sell > MAX_QUOTE_SPREAD) return null;
  return Math.sqrt(buy * sell);
}

function contextSlotOf(q: JupiterQuote): number | null {
  return typeof q.contextSlot === "number" && Number.isSafeInteger(q.contextSlot) ? q.contextSlot : null;
}

export async function fetchLaunchPrices(deps: LaunchPriceDeps, mints: string[]): Promise<Map<string, LaunchPrice>> {
  const [prices, slot] = await Promise.all([deps.prices(mints), deps.currentSlot()]);
  const stale = mints.filter((m) => {
    if (m === MAINNET_USDC_MINT) return false;
    const p = prices.get(m);
    return typeof p?.decimals === "number" && (typeof p.blockId !== "number" || p.blockId < slot - deps.maxAgeSlots);
  });
  // Accepting the last traded price restamps it at the current slot, the slot
  // initialReserveAtNav's freshness check reads.
  const acceptLastTrade = (mint: string) => {
    const p = prices.get(mint)!;
    if (typeof p.blockId === "number" && p.blockId >= slot - LOW_VOLUME_MAX_AGE_SLOTS) prices.set(mint, { ...p, blockId: slot });
  };
  await Promise.all(
    stale.map(async (mint) => {
      if (!(await quotePrice(mint))) acceptLastTrade(mint);
    }),
  );
  return prices;

  async function quotePrice(mint: string): Promise<boolean> {
    const p = prices.get(mint)!;
    const buy = await deps.quote({ inputMint: MAINNET_USDC_MINT, outputMint: mint, amount: QUOTE_PROBE_USDC_RAW, slippageBps: 50, maxAccounts: null });
    if (buy.kind !== "ok") return false;
    const tokensOut = BigInt(buy.value.outAmount);
    if (tokensOut <= 0n) return false;
    const sell = await deps.quote({ inputMint: mint, outputMint: MAINNET_USDC_MINT, amount: tokensOut, slippageBps: 50, maxAccounts: null });
    if (sell.kind !== "ok") return false;
      const usdPrice = priceFromQuotes(p.decimals!, BigInt(buy.value.inAmount), tokensOut, BigInt(sell.value.outAmount));
      const quotedAt = Math.min(contextSlotOf(buy.value) ?? 0, contextSlotOf(sell.value) ?? 0);
      if (usdPrice === null || quotedAt <= 0) return false;
      prices.set(mint, { usdPrice, decimals: p.decimals, blockId: quotedAt });
      return true;
  }
}
