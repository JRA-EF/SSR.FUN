// Reusable trading/portfolio math for the SSR.FUN simulation.
// Kept pure and deterministic so the store stays a thin wrapper around these.

import type { DTR, DTRAsset, Holding, TradeQuote } from "./types";

/** Fixed SSR.FUN-routed secondary-market fee, applied on both buy and sell. */
export const TRADING_FEE_RATE = 0.001; // 10 basis points

/** Default fee floors offered when creating a new DTR. */
export const DEFAULT_MINT_FEE_BPS = 50; // 0.50%
export const DEFAULT_TVL_FEE_BPS = 100; // 1.00% annualized
export const DEFAULT_MANAGER_TAX_BPS = 0;

/** Longest ticker in the seeded catalog (SSRRES) -- caps user-created tickers to a normal, real-world length. */
export const TICKER_MAX_LENGTH = 6;
/** Discount applied when Mint Fee is settled in SSR instead of USDC. */
export const SSR_SETTLEMENT_DISCOUNT = 0.25; // 25%

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

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Mint Fee owed, in USDC, with the optional SSR-settlement discount applied. */
export function calcMintFee(
  usdcAmount: number,
  mintFeeBps: number,
  settleInSsr: boolean,
): number {
  const gross = usdcAmount * (mintFeeBps / 10_000);
  return settleInSsr ? gross * (1 - SSR_SETTLEMENT_DISCOUNT) : gross;
}

/**
 * Applies a manual rebalance to a DTR's composition.
 * `edits` maps asset symbol -> new target weight (fraction of 1).
 * When `adjustRemaining` is true, non-edited assets are scaled proportionally
 * so the basket returns to 100%. When false, non-edited weights are left
 * untouched and the shortfall becomes the Unallocated USDC Reserve.
 */
export function applyRebalance(
  composition: DTRAsset[],
  edits: Record<string, number>,
  adjustRemaining: boolean,
): { composition: DTRAsset[]; unallocatedPct: number } {
  const editedSymbols = new Set(Object.keys(edits));
  const edited = composition.map((a) =>
    editedSymbols.has(a.symbol) ? { ...a, weight: edits[a.symbol] } : a,
  );

  if (!adjustRemaining) {
    const total = edited.reduce((sum, a) => sum + a.weight, 0);
    return { composition: edited, unallocatedPct: Math.max(0, 1 - total) };
  }

  const editedSum = edited
    .filter((a) => editedSymbols.has(a.symbol))
    .reduce((sum, a) => sum + a.weight, 0);
  const remaining = Math.max(0, 1 - editedSum);
  const othersOriginalSum = composition
    .filter((a) => !editedSymbols.has(a.symbol))
    .reduce((sum, a) => sum + a.weight, 0);

  const scaled = edited.map((a) => {
    if (editedSymbols.has(a.symbol)) return a;
    if (othersOriginalSum <= 0) return a;
    const original = composition.find((o) => o.symbol === a.symbol)!.weight;
    return { ...a, weight: remaining * (original / othersOriginalSum) };
  });

  return { composition: scaled, unallocatedPct: 0 };
}
