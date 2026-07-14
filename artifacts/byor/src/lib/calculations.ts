// Reusable trading/portfolio math for the BYOR simulation.
// Kept pure and deterministic so the store stays a thin wrapper around these.

import type { DTR, Holding, TradeQuote } from "./types";

/** BYOR secondary-market trading fee, applied on both buy and sell. */
export const TRADING_FEE_RATE = 0.001; // 0.10%

/** Fictional reference prices used only to value non-DTR wallet balances. */
export const SSR_PRICE_USDC = 0.42;
export const SOL_PRICE_USDC = 178.5;

/**
 * Buying: user spends `usdcAmount` and receives DTR Tokens at `tokenPrice`.
 * Fee is taken out of the tokens received.
 */
export function calcTokensReceived(
  usdcAmount: number,
  tokenPrice: number,
): TradeQuote {
  if (usdcAmount <= 0 || tokenPrice <= 0) {
    return { grossAmount: 0, fee: 0, netAmount: 0 };
  }
  const grossAmount = usdcAmount / tokenPrice;
  const fee = grossAmount * TRADING_FEE_RATE;
  const netAmount = grossAmount - fee;
  return { grossAmount, fee, netAmount };
}

/**
 * Selling: user sells `tokenAmount` DTR Tokens at `tokenPrice` and receives USDC.
 * Fee is taken out of the USDC received.
 */
export function calcUsdcReceived(
  tokenAmount: number,
  tokenPrice: number,
): TradeQuote {
  if (tokenAmount <= 0 || tokenPrice <= 0) {
    return { grossAmount: 0, fee: 0, netAmount: 0 };
  }
  const grossAmount = tokenAmount * tokenPrice;
  const fee = grossAmount * TRADING_FEE_RATE;
  const netAmount = grossAmount - fee;
  return { grossAmount, fee, netAmount };
}

/** Volume-weighted average purchase price after adding a new lot. */
export function calcAvgPurchasePrice(
  existingBalance: number,
  existingAvgPrice: number,
  addedAmount: number,
  purchasePrice: number,
): number {
  const totalAmount = existingBalance + addedAmount;
  if (totalAmount <= 0) return 0;
  const totalCost = existingBalance * existingAvgPrice + addedAmount * purchasePrice;
  return totalCost / totalAmount;
}

/** Current value of a single DTR Token holding, in USDC. */
export function calcHoldingValue(holding: Holding, dtr: DTR | undefined): number {
  if (!dtr) return 0;
  return holding.tokenBalance * dtr.tokenPrice;
}

/** Unrealized profit/loss on a holding, in USDC. */
export function calcUnrealizedPnl(holding: Holding, dtr: DTR | undefined): number {
  if (!dtr) return 0;
  return (dtr.tokenPrice - holding.avgPurchasePrice) * holding.tokenBalance;
}

/** Unrealized P&L as a percent of cost basis. */
export function calcUnrealizedPnlPct(holding: Holding, dtr: DTR | undefined): number {
  if (!dtr || holding.avgPurchasePrice <= 0) return 0;
  return ((dtr.tokenPrice - holding.avgPurchasePrice) / holding.avgPurchasePrice) * 100;
}

/** Total value of all DTR Token holdings, in USDC. */
export function calcTotalDtrValue(holdings: Holding[], dtrs: DTR[]): number {
  return holdings.reduce((sum, h) => {
    const dtr = dtrs.find((d) => d.id === h.dtrId);
    return sum + calcHoldingValue(h, dtr);
  }, 0);
}

/** Total portfolio value across USDC, SSR, SOL, and DTR Token holdings. */
export function calcPortfolioValue(
  wallet: { usdc: number; ssr: number; sol: number },
  holdings: Holding[],
  dtrs: DTR[],
): number {
  const walletValue =
    wallet.usdc + wallet.ssr * SSR_PRICE_USDC + wallet.sol * SOL_PRICE_USDC;
  return walletValue + calcTotalDtrValue(holdings, dtrs);
}

export function formatUsdc(value: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatTokenAmount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}
