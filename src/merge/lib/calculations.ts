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

/** Minimum spacing between routinely-appended sync points -- 6000 points at 5-minute spacing spans ~20 days, comfortably covering the 7d performance window. */
export const PRICE_SYNC_MIN_INTERVAL_MS = 5 * 60_000;
/** A genuine price move worth recording immediately, even before the routine interval elapses. */
export const PRICE_SYNC_MOVE_FRACTION = 0.001; // 0.1%

/**
 * The one refresh applied on EVERY real-Reserve sync (DEC-0158): appends the
 * freshly-computed NAV onto the Reserve's price history (throttled so a
 * 15-second poll doesn't burn the 6000-point budget in hours) and derives
 * the real 24h/7d performance from that history. Root cause this fixes: an
 * on-chain Reserve's change24h/change7d were constructed as 0 and NEVER
 * recomputed, and its price history only grew on the user's own confirmed
 * trades -- so "7D Performance" sat at +0.00% forever regardless of how the
 * underlying asset prices moved. Non-positive placeholder points (the
 * pre-first-fetch `price: 0` seed) are dropped rather than used as a
 * percent-change base.
 */
export function refreshPriceSeries(
  priceHistory: PricePoint[],
  nav: number,
  now: number = Date.now(),
): { priceHistory: PricePoint[]; change24h: number; change7d: number } {
  const cleaned = priceHistory.filter((p) => p.price > 0);
  if (!(nav > 0)) {
    // No real price this pass -- keep history untouched and report the
    // changes derivable from what's already recorded (0 when nothing is).
    const last = cleaned[cleaned.length - 1];
    const changes = last ? calcRecentChanges(cleaned, last.price, now) : { change24h: 0, change7d: 0 };
    return { priceHistory: cleaned.length === priceHistory.length ? priceHistory : cleaned, ...changes };
  }
  const last = cleaned[cleaned.length - 1];
  const movedEnough = last ? Math.abs(nav - last.price) / last.price >= PRICE_SYNC_MOVE_FRACTION : true;
  const intervalElapsed = last ? now - last.t >= PRICE_SYNC_MIN_INTERVAL_MS : true;
  const history = !last || intervalElapsed || movedEnough ? appendPricePoint(cleaned, nav, now) : cleaned;
  return { priceHistory: history, ...calcRecentChanges(history, nav, now) };
}

/**
 * Classic weighted-average cost basis after buying `addAmount` tokens for a
 * total of `addAmount * addPrice` (DEC-0158) -- the ONE place a confirmed
 * Buy moves a holding's avgPurchasePrice. A background balance sync must
 * never touch the basis (the DEC-0149 root cause: overwriting it with the
 * current nav made Unrealized P&L structurally ~$0). A Sell leaves the
 * basis unchanged (average-cost method).
 */
export function weightedAvgCostBasis(prevBalance: number, prevAvgPrice: number, addAmount: number, addPrice: number): number {
  const newBalance = prevBalance + addAmount;
  if (!(newBalance > 0)) return addPrice;
  return (prevBalance * prevAvgPrice + addAmount * addPrice) / newBalance;
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
  // Fewer than 2 real points has no genuine span to measure "All" against
  // (a single point spans zero time) -- fall back to the same 1-year default
  // used for a genuinely empty history, rather than a near-zero window.
  if (priceHistory.length < 2) return 365 * DAY;
  return Math.max(priceHistory[priceHistory.length - 1].t - priceHistory[0].t, MINUTE);
}

/** Evenly-spaced point count for a client-side flatline fallback -- enough for a smooth line and meaningfully-distinct tooltip positions across the full selected range, without being excessive (sampleLinePoints downsamples anyway for the chart itself). */
const FALLBACK_FLATLINE_POINTS = 30;

export interface LineSeriesResult {
  points: PricePoint[];
  /**
   * True when `points` is a client-side flatline fallback -- not genuine
   * recorded trade/mint/redeem observations. Never persisted anywhere; a
   * pure rendering aid so a Reserve with sparse real history still shows an
   * honest, current-value line instead of an empty panel. The caller should
   * disclose this (e.g. "No price movement recorded yet.") rather than
   * present it as indistinguishable from genuine history.
   */
  isFallback: boolean;
  /**
   * True when there is nothing valid to show at all -- fewer than 2 real
   * observations AND no genuine current value to fall back to. `points` is
   * always empty in this case; the caller must render an honest "Price
   * unavailable" state, never a fabricated $0 line.
   */
  unavailable: boolean;
}

/**
 * Line-chart series for a timeframe, always returning a renderable series
 * when either genuine history or a genuine current value exists -- see
 * `LineSeriesResult`'s three cases:
 *
 * 1. **2+ real recorded points**: real points within the lookback window are
 *    used as-is (`priorPoint`/`basePrice` below flatline a window with no
 *    points strictly inside it at the last real observed price beforehand,
 *    never inventing a trend). `currentNav`, when genuinely valid, is
 *    appended as the latest point if it's newer than the last real one --
 *    this reflects the Reserve's real live state, it never alters or removes
 *    a real historical point.
 * 2. **Fewer than 2 real points, but a genuine current value exists**:
 *    a client-side-only flatline, anchored to that ONE real point's price if
 *    exactly one exists (extended backward across the whole range), or to
 *    `currentNav` if zero real points exist. `isFallback: true` marks this
 *    as a rendering aid, never persisted as if it were a real observation.
 * 3. **Fewer than 2 real points AND no genuine current value**: `unavailable:
 *    true`, `points: []` -- never a fabricated flatline at an invalid ($0 or
 *    missing) value.
 *
 * Pure and independent per call: two calls (e.g. from two chart instances,
 * or two different Reserves) never share state and cannot influence each
 * other's result.
 */
export function buildLineSeries(
  priceHistory: PricePoint[],
  timeframe: ChartTimeframe,
  currentNav: number | null,
  now: number = Date.now(),
): LineSeriesResult {
  const hasValidNav = currentNav !== null && Number.isFinite(currentNav) && currentNav > 0;

  if (priceHistory.length >= 2) {
    const windowStart = now - resolveTimeframeLookback(timeframe, priceHistory);
    const windowPoints = priceHistory.filter((p) => p.t >= windowStart);

    const priorPoint = [...priceHistory].reverse().find((p) => p.t <= windowStart);
    const basePrice = priorPoint?.price ?? windowPoints[0]?.price ?? priceHistory[0].price;

    let points: PricePoint[];
    if (windowPoints.length === 0) {
      points = [
        { t: windowStart, price: basePrice },
        { t: now, price: basePrice },
      ];
    } else {
      const needsLeadIn = windowPoints[0].t > windowStart + SECOND;
      points = needsLeadIn ? [{ t: windowStart, price: basePrice }, ...windowPoints] : [...windowPoints];
    }
    // Reflect the Reserve's genuinely current value as the latest point when
    // it's newer than the last real observation -- never replaces or backdates
    // a real historical point, only extends the line to "now."
    if (hasValidNav) {
      const last = points[points.length - 1];
      if (!last || now > last.t) points = [...points, { t: now, price: currentNav as number }];
    }
    return { points, isFallback: false, unavailable: false };
  }

  // Truly nothing to anchor even a fallback to: no real observation AND no
  // valid current value. A single real point is used below regardless of
  // whether currentNav is valid -- only a genuinely EMPTY history with no
  // valid NAV is "unavailable."
  if (priceHistory.length === 0 && !hasValidNav) {
    return { points: [], isFallback: false, unavailable: true };
  }

  // Fewer than 2 real points: a client-side-only flatline, never persisted.
  // Exactly one real point extends THAT real (once-observed) value backward;
  // zero real points anchors to the current live value instead.
  const anchorPrice = priceHistory.length === 1 ? priceHistory[0].price : (currentNav as number);
  const windowMs = resolveTimeframeLookback(timeframe, priceHistory);
  const windowStart = now - windowMs;
  const points: PricePoint[] = [];
  for (let i = 0; i < FALLBACK_FLATLINE_POINTS; i++) {
    points.push({ t: windowStart + (windowMs * i) / (FALLBACK_FLATLINE_POINTS - 1), price: anchorPrice });
  }
  return { points, isFallback: true, unavailable: false };
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

/**
 * Asset-level P&L % for a Reserve's OWN underlying holding (e.g. an asset
 * sitting in a Reserve's vault) -- distinct from calcUnrealizedPnlPct above,
 * which is a USER's Reserve Token position. Compares the asset's current USD
 * price against its fixed ENTRY price (the price it had when it was first
 * seen inside the Reserve -- see the Reserve Asset Entry Price Store,
 * api/mainnet/reserve-entry-prices.ts / entryPriceClient.ts). Returns null,
 * never a fabricated 0%, when either side is missing or invalid -- the
 * caller renders that honestly as "no P&L available". On DevNet both sides
 * come from the same fixed TEST_ASSET_PRICES_USD fixture table, so 0.00% is
 * the genuine answer there (fixture prices never move).
 *
 * This replaces calcReserveAssetPnlPct/referenceAssetPriceUsd, which
 * compared TEST_ASSET_PRICES_USD against itself and therefore reported a
 * structural 0.00% for every Mainnet asset forever -- the "P&L is not
 * updating" bug reported live on DELTA (mainnet-beta-16).
 */
export function calcAssetPnlPct(currentPriceUsd: number | null | undefined, entryPriceUsd: number | null | undefined): number | null {
  if (typeof currentPriceUsd !== "number" || !Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) return null;
  if (typeof entryPriceUsd !== "number" || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  return ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
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

/** Same formatting as formatUsdc, but renders the honest "Price unavailable" instead of a misleading "$0.00" whenever `available` is false (see onChainReserve.ts's computeAumFromPrices -- pricingComplete === false is exactly this case: at least one materially-held Reserve Asset has no valid Pyth/Jupiter price this pass). */
export function formatUsdcOrUnavailable(value: number, available: boolean, opts: { compact?: boolean } = {}): string {
  if (!available) return "Price unavailable";
  return formatUsdc(value, opts);
}

/**
 * A single Reserve Asset's own per-unit USD price -- unlike formatUsdc's
 * fixed 2 decimals (fine for an aggregate USD total, or a Reserve Token's
 * own NAV-anchored price which stays roughly $0.01+), a real underlying
 * asset can genuinely be a thin-liquidity token worth a small fraction of a
 * cent (e.g. a real observed SSR price of ~$0.00048 -- see DEC-0134).
 * formatUsdc would round that to "$0.00", true but useless. Shows up to 6
 * significant decimal places for anything under $1, otherwise the normal
 * 2-decimal currency format. `null` (never fabricated) renders as an
 * explicit "unavailable" label, matching formatUsdcOrUnavailable's honesty
 * convention.
 */
export function formatAssetPriceUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "Price unavailable";
  if (value >= 1) return formatUsdc(value);
  return `$${value.toPrecision(3)}`;
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
