// Reusable trading/portfolio math for the SSR.FUN simulation.
// Kept pure and deterministic so the store stays a thin wrapper around these.

import type { ChartTimeframe, DTR, DTRAsset, Holding, OrderBookLevel, PricePoint, SimulatedOrderBook, TradeQuote } from "./types";

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
 * The amount of devUSDC the connected wallet can genuinely spend on a Buy:
 * simply its real devUSDC balance. devUSDC is SSR.fun's universal purchasing
 * currency -- it is never required to be one of a Reserve's own underlying
 * Reserve Assets, so this is deliberately independent of any Reserve's
 * composition/target-weights (see docs/project/DECISION_LOG.md's Buy
 * architecture correction). Whether a given Reserve's Buy can actually be
 * EXECUTED right now (i.e. whether a genuine devUSDC -> Reserve-Asset
 * conversion path exists on-chain for it) is a separate question -- see
 * DTRDetail.tsx's isGenuineDevUsdcBuySupported.
 */
export function buyAvailableFromDevUsdcBalance(devUsdcBalanceHuman: number): number {
  return Math.max(0, devUsdcBalanceHuman);
}

/**
 * Whether a Reserve's Buy can genuinely execute today: true only when EVERY
 * one of its registered assets is devUSDC itself. In that case
 * mint_reserve_tokens_in_kind's own transfer_checked moves the user's real
 * devUSDC directly into the vault -- no server-side minting/wrapping of any
 * other asset is involved. Any other composition (mockX/Y/Z, wrapped SOL)
 * has no genuine devUSDC -> Reserve-Asset conversion deployed on-chain right
 * now; Buy must be disabled for those rather than silently fabricating those
 * legs for free (see docs/project/DECISION_LOG.md's Buy architecture
 * correction). An empty asset list is never "pure devUSDC" -- that's an
 * unresolved/invalid Reserve shape, not a supported one.
 */
export function isReservePureDevUsdc(assetMints: string[], devUsdcMint: string): boolean {
  return assetMints.length > 0 && assetMints.every((m) => m === devUsdcMint);
}

/** Hard cap on stored points per Reserve so a long session can't grow the price history unbounded. */
const MAX_PRICE_POINTS = 6000;

/**
 * Appends a fresh price point (now, newPrice) onto a Reserve's flat, chronological
 * price history so charts reflect trades immediately, trimming back to a sane max
 * length so history doesn't grow unbounded.
 */
export function appendPricePoint(
  priceHistory: PricePoint[],
  newPrice: number,
  now: number,
): PricePoint[] {
  const lastT = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].t : -Infinity;
  // Guarantee strictly increasing timestamps -- keeps points unique and chronologically
  // ordered even if two trades settle within the same millisecond.
  const point: PricePoint = { t: Math.max(now, lastT + 1), price: newPrice };
  const series = [...priceHistory, point];
  return series.length > MAX_PRICE_POINTS ? series.slice(series.length - MAX_PRICE_POINTS) : series;
}

/** 24h/7d percent change derived from the earliest point still inside each rolling window vs. the latest price. */
export function calcRecentChanges(
  priceHistory: PricePoint[],
  currentPrice: number,
  now: number = Date.now(),
): { change24h: number; change7d: number } {
  const changeSince = (windowMs: number): number => {
    const cutoff = now - windowMs;
    const base = priceHistory.find((p) => p.t >= cutoff) ?? priceHistory[0];
    if (!base || base.price <= 0) return 0;
    return ((currentPrice - base.price) / base.price) * 100;
  };
  return { change24h: changeSince(24 * 60 * 60_000), change7d: changeSince(7 * 24 * 60 * 60_000) };
}

// --- Chart timeframes + the simulated order book -----------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Lookback window per timeframe. The day-scale entries (24h/7d/30d/1y) use their
 * literal duration, matching how this app's timeframe controls already behaved. The
 * sub-hour entries (1s/1m/5m/1h/4h) are widened well past their literal duration --
 * e.g. "1s" shows the last 60 seconds, not literally the last second -- so the view
 * is actually usable against a seeded dataset that isn't tick-dense; "1s" still means
 * "1-second resolution," it just isn't a 1-second-wide window. "All" resolves
 * dynamically to the Reserve's total history span.
 */
export const TIMEFRAME_LOOKBACK_MS: Record<Exclude<ChartTimeframe, "All">, number> = {
  "1s": 60 * SECOND,
  "1m": 10 * MINUTE,
  "5m": 30 * MINUTE,
  "1h": 2 * HOUR,
  "4h": 8 * HOUR,
  "24h": 24 * HOUR,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "1y": 365 * DAY,
};

/** Resolves a timeframe (including the dynamic "All") into a concrete lookback window. */
export function resolveTimeframeLookback(timeframe: ChartTimeframe, priceHistory: PricePoint[]): number {
  if (timeframe !== "All") return TIMEFRAME_LOOKBACK_MS[timeframe];
  if (priceHistory.length === 0) return 365 * DAY;
  return Math.max(priceHistory[priceHistory.length - 1].t - priceHistory[0].t, MINUTE);
}

/**
 * Line-chart series for a timeframe. Real points within the lookback window are used
 * as-is. When the window has no real history at all, this flatlines at the last known
 * price rather than rendering nothing -- "no trades" reads as "no movement," not a
 * blank chart. When the window's real history starts partway through (e.g. a single
 * recent trade), a flat lead-in point is prepended at the window start so that trade
 * reads as a rise/fall off a baseline instead of an isolated dot floating alone.
 */
export function buildLineSeries(
  priceHistory: PricePoint[],
  timeframe: ChartTimeframe,
  now: number = Date.now(),
): PricePoint[] {
  if (priceHistory.length === 0) return [];
  const windowStart = now - resolveTimeframeLookback(timeframe, priceHistory);
  const windowPoints = priceHistory.filter((p) => p.t >= windowStart);

  const priorPoint = [...priceHistory].reverse().find((p) => p.t <= windowStart);
  const basePrice = priorPoint?.price ?? windowPoints[0]?.price ?? priceHistory[0].price;

  if (windowPoints.length === 0) {
    return [
      { t: windowStart, price: basePrice },
      { t: now, price: basePrice },
    ];
  }
  const needsLeadIn = windowPoints[0].t > windowStart + SECOND;
  return needsLeadIn ? [{ t: windowStart, price: basePrice }, ...windowPoints] : windowPoints;
}

/** Downsamples a point series for the line/area chart, always keeping the first and last (latest) point. */
export function sampleLinePoints(points: PricePoint[], maxPoints = 300): PricePoint[] {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const sampled: PricePoint[] = [];
  for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1]?.t !== last.t) sampled.push(last);
  return sampled;
}

/** Hypothetical order sizes to sample along the curve, as a fraction of current liquidity depth. */
const ORDER_BOOK_STEP_FRACTIONS = [0.004, 0.008, 0.014, 0.022, 0.032, 0.045, 0.06, 0.08];

/**
 * A deterministic, clearly-simulated order book: each level is "the price a market
 * order of this size would get right now," computed with the exact same constant-product
 * curve math (calcTokensReceived/calcUsdcReceived) that real buys/sells settle against.
 * Purely a function of (tokenPrice, liquidityUsdc) -- no randomness, nothing per-render.
 */
export function buildSimulatedOrderBook(tokenPrice: number, liquidityUsdc: number): SimulatedOrderBook {
  if (tokenPrice <= 0 || liquidityUsdc <= 0) {
    return { asks: [], bids: [], midPrice: tokenPrice };
  }
  const tokenReserve = liquidityUsdc / tokenPrice;

  let cumulativeUsdc = 0;
  const asks: OrderBookLevel[] = ORDER_BOOK_STEP_FRACTIONS.map((frac, i) => {
    const usdcSize = liquidityUsdc * frac;
    const stepUsdc = i === 0 ? usdcSize : usdcSize - liquidityUsdc * ORDER_BOOK_STEP_FRACTIONS[i - 1];
    const quote = calcTokensReceived(usdcSize, tokenPrice, liquidityUsdc);
    cumulativeUsdc += Math.max(stepUsdc, 0);
    return { price: quote.newPrice, tokenAmount: quote.grossAmount, usdcTotal: stepUsdc, cumulativeUsdc };
  });

  cumulativeUsdc = 0;
  const bids: OrderBookLevel[] = ORDER_BOOK_STEP_FRACTIONS.map((frac, i) => {
    const tokenSize = tokenReserve * frac;
    const prevTokenSize = i === 0 ? 0 : tokenReserve * ORDER_BOOK_STEP_FRACTIONS[i - 1];
    const stepTokens = tokenSize - prevTokenSize;
    const quote = calcUsdcReceived(tokenSize, tokenPrice, liquidityUsdc);
    const stepUsdc = quote.netAmount - (i === 0 ? 0 : calcUsdcReceived(prevTokenSize, tokenPrice, liquidityUsdc).netAmount);
    cumulativeUsdc += Math.max(stepUsdc, 0);
    return { price: quote.newPrice, tokenAmount: stepTokens, usdcTotal: stepUsdc, cumulativeUsdc };
  });

  return { asks: asks.reverse(), bids, midPrice: tokenPrice };
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

/** Cost basis of a holding (what was actually paid for it), in USDC. */
export function calcCostBasis(holding: Holding): number {
  return holding.avgPurchasePrice * holding.tokenBalance;
}

/** Estimated USDC P&L on a holding over the last 24h, derived from the DTR's 24h price change. */
export function calc24hPnl(holding: Holding, dtr: DTR | undefined): number {
  if (!dtr) return 0;
  const currentValue = calcHoldingValue(holding, dtr);
  const prevValue = currentValue / (1 + dtr.change24h / 100);
  return currentValue - prevValue;
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
