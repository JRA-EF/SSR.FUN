// Reusable trading/portfolio math for the SSR.FUN simulation.
// Kept pure and deterministic so the store stays a thin wrapper around these.

import type { DTR, DTRAsset, Holding, PricePoint, PriceRange, TradeQuote } from "./types";

/** Fixed SSR.FUN-routed secondary-market fee, applied on both buy and sell. */
export const TRADING_FEE_RATE = 0.001; // 10 basis points

/** Share of AUM that backs the secondary-market trading curve (deeper AUM = deeper liquidity = less slippage). */
export const LIQUIDITY_TO_AUM_RATIO = 0.06;
/** Floor so thin/new DTRs still have a tradeable, not-infinitely-volatile curve. */
export const MIN_LIQUIDITY_USDC = 5_000;
/** Starting liquidity depth granted to a freshly deployed (user-created) DTR. */
export const DEFAULT_NEW_DTR_LIQUIDITY_USDC = 25_000;

/** Derives a DTR's curve liquidity depth from its AUM. */
export function initialLiquidityForAum(aum: number): number {
  return Math.max(aum * LIQUIDITY_TO_AUM_RATIO, MIN_LIQUIDITY_USDC);
}

/** Default fee floors offered when creating a new DTR, all expressed as plain percentages (0.5 = 0.5%). */
export const DEFAULT_MINT_FEE_PCT = 0.5;
export const DEFAULT_TVL_FEE_PCT = 1.0; // annualized
export const DEFAULT_MANAGER_BUY_TAX_PCT = 0;
export const DEFAULT_MANAGER_SELL_TAX_PCT = 0;

/** Longest ticker in the seeded catalog (SSRRES) -- caps user-created tickers to a normal, real-world length. */
export const TICKER_MAX_LENGTH = 6;
/** Discount applied when Mint Fee is settled in SSR instead of USDC. */
export const SSR_SETTLEMENT_DISCOUNT = 0.25; // 25%

/** Fictional reference prices used only to value non-DTR wallet balances. */
export const SSR_PRICE_USDC = 0.42;
export const SOL_PRICE_USDC = 178.5;

/**
 * Buying: user spends `usdcAmount` against a constant-product (x*y=k) curve
 * seeded from the DTR's current price and liquidity depth. This makes buys
 * push the price up -- more so for larger trades against thinner liquidity --
 * instead of filling at a flat, unmoving price.
 * Fee is taken out of the tokens received.
 */
export function calcTokensReceived(
  usdcAmount: number,
  tokenPrice: number,
  liquidityUsdc: number,
  buyTaxPct: number = 0,
): TradeQuote {
  if (usdcAmount <= 0 || tokenPrice <= 0 || liquidityUsdc <= 0) {
    return { grossAmount: 0, fee: 0, netAmount: 0, newPrice: tokenPrice, priceImpactPct: 0 };
  }
  const tokenReserve = liquidityUsdc / tokenPrice;
  const k = liquidityUsdc * tokenReserve;
  const newUsdcReserve = liquidityUsdc + usdcAmount;
  const newTokenReserve = k / newUsdcReserve;
  const grossAmount = tokenReserve - newTokenReserve;
  const fee = grossAmount * (TRADING_FEE_RATE + buyTaxPct / 100);
  const netAmount = grossAmount - fee;
  const newPrice = newUsdcReserve / newTokenReserve;
  const priceImpactPct = ((newPrice - tokenPrice) / tokenPrice) * 100;
  return { grossAmount, fee, netAmount, newPrice, priceImpactPct };
}

/**
 * Selling: user sells `tokenAmount` DTR Tokens against the same constant-product
 * curve, pushing the price down -- more so for larger trades against thinner liquidity.
 * Fee is taken out of the USDC received.
 */
export function calcUsdcReceived(
  tokenAmount: number,
  tokenPrice: number,
  liquidityUsdc: number,
  sellTaxPct: number = 0,
): TradeQuote {
  if (tokenAmount <= 0 || tokenPrice <= 0 || liquidityUsdc <= 0) {
    return { grossAmount: 0, fee: 0, netAmount: 0, newPrice: tokenPrice, priceImpactPct: 0 };
  }
  const tokenReserve = liquidityUsdc / tokenPrice;
  const k = liquidityUsdc * tokenReserve;
  const newTokenReserve = tokenReserve + tokenAmount;
  const newUsdcReserve = k / newTokenReserve;
  const grossAmount = liquidityUsdc - newUsdcReserve;
  const fee = grossAmount * (TRADING_FEE_RATE + sellTaxPct / 100);
  const netAmount = grossAmount - fee;
  const newPrice = newUsdcReserve / newTokenReserve;
  const priceImpactPct = ((newPrice - tokenPrice) / tokenPrice) * 100;
  return { grossAmount, fee, netAmount, newPrice, priceImpactPct };
}

/**
 * Appends a fresh price point (now, newPrice) onto every range bucket of a
 * DTR's price history so charts reflect trades immediately, trimming each
 * bucket back to a sane max length so history doesn't grow unbounded.
 */
export function appendPricePoint(
  priceHistory: Record<PriceRange, PricePoint[]>,
  newPrice: number,
  now: number,
): Record<PriceRange, PricePoint[]> {
  const MAX_POINTS = 400;
  const point: PricePoint = { t: now, price: newPrice };
  const ranges: PriceRange[] = ["24H", "7D", "30D", "All"];
  const next = {} as Record<PriceRange, PricePoint[]>;
  for (const range of ranges) {
    const series = [...priceHistory[range], point];
    next[range] = series.length > MAX_POINTS ? series.slice(series.length - MAX_POINTS) : series;
  }
  return next;
}

/** 24h/7d percent change derived from the earliest point still inside each history window vs. the latest price. */
export function calcRecentChanges(
  priceHistory: Record<PriceRange, PricePoint[]>,
  currentPrice: number,
): { change24h: number; change7d: number } {
  const change = (series: PricePoint[]): number => {
    if (series.length === 0) return 0;
    const base = series[0].price;
    if (base <= 0) return 0;
    return ((currentPrice - base) / base) * 100;
  };
  return { change24h: change(priceHistory["24H"]), change7d: change(priceHistory["7D"]) };
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

export function formatPct(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

/** Mint Fee owed, in USDC, with the optional SSR-settlement discount applied. */
export function calcMintFee(
  usdcAmount: number,
  mintFeePct: number,
  settleInSsr: boolean,
): number {
  const gross = usdcAmount * (mintFeePct / 100);
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
