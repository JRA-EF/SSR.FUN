/* OHLC candle aggregation for the Reserve-detail price chart's "Candles"
 * view. Buckets an already-windowed price series (buildLineSeries output)
 * into a fixed number of candles: each candle opens at the previous close
 * (so bodies always chain gaplessly), and high/low span every observation
 * inside the bucket. An empty bucket carries the previous close forward as
 * a doji rather than leaving a hole. Pure and dependency-free so it stays
 * trivially testable alongside calculations.ts.
 */

import type { PricePoint } from "./types";

export interface Candle {
  /** Bucket midpoint, unix ms — what the x-axis labels. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** [low, high] — Recharts range-Bar dataKey, sizing each candle's plot band. */
  range: [number, number];
  up: boolean;
}

/**
 * Exponential moving average over a value series. Seeded with the SMA of the
 * first `period` values (the conventional charting seed), null until the seed
 * window has filled — so the indicator line simply starts `period` candles in
 * rather than fabricating early values.
 */
export function ema(values: number[], period: number): Array<number | null> {
  if (period < 1 || values.length < period) return values.map(() => null);
  const k = 2 / (period + 1);
  const out: Array<number | null> = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      prev += values[i];
    } else if (i === period - 1) {
      prev = (prev + values[i]) / period;
      out.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

export function buildCandleSeries(points: PricePoint[], bucketCount = 36): Candle[] {
  const clean = points.filter((p) => Number.isFinite(p.price));
  if (clean.length < 2) return [];
  const t0 = clean[0].t;
  const t1 = clean[clean.length - 1].t;
  if (t1 <= t0) return [];

  const size = (t1 - t0) / bucketCount;
  const candles: Candle[] = [];
  let i = 0;
  let prevClose: number | null = null;
  for (let b = 0; b < bucketCount; b++) {
    const end = b === bucketCount - 1 ? Infinity : t0 + (b + 1) * size;
    const bucket: number[] = [];
    while (i < clean.length && clean[i].t < end) {
      bucket.push(clean[i].price);
      i++;
    }
    if (bucket.length === 0) {
      if (prevClose === null) continue;
      bucket.push(prevClose);
    }
    const open = prevClose ?? bucket[0];
    const close = bucket[bucket.length - 1];
    const high = Math.max(open, ...bucket);
    const low = Math.min(open, ...bucket);
    candles.push({
      t: t0 + (b + 0.5) * size,
      open,
      high,
      low,
      close,
      range: [low, high],
      up: close >= open,
    });
    prevClose = close;
  }
  return candles;
}
