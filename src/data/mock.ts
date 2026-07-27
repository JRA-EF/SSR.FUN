/** Deterministic numeric seed derived from a string (e.g. a Reserve address). */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h >>> 0
}

/** Deterministic seeded PRNG so mock data is stable across reloads. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random-walk price series ending at `end`, with daily vol and drift (percent). */
export function walkSeries(seed: number, days: number, end: number, dailyVolPct: number, driftPct: number): number[] {
  const rnd = mulberry32(seed)
  const out: number[] = [1]
  for (let i = 1; i < days; i++) {
    const shock = (rnd() - 0.5) * 2 * (dailyVolPct / 100)
    out.push(out[i - 1] * (1 + driftPct / 100 + shock))
  }
  const scale = end / out[out.length - 1]
  return out.map(v => v * scale)
}

/** A market series that tracks NAV with a noisy premium/discount band. */
export function marketFromNav(nav: number[], seed: number, biasPct: number, noisePct: number): number[] {
  const rnd = mulberry32(seed)
  return nav.map(v => v * (1 + biasPct / 100 + (rnd() - 0.5) * 2 * (noisePct / 100)))
}

export const HOUR = 3_600_000
export const DAY = 86_400_000

/**
 * Synthetic hourly-resolution price walk covering the last 7 days, ending exactly at
 * `endPrice`. Same Brownian-scaled-shock/normalization shape as the ported DTR price
 * history (see src/merge/lib/seed-data.ts buildPriceHistory) so Featured Reserves and
 * Discover Reserves charts read as one consistent system: a 7-day window at roughly
 * hourly granularity, not one coarse daily point vs. a dense real trade history.
 */
export function hourlySeries7d(seed: number, endPrice: number, dailyVolPct = 0.9): { t: number; price: number }[] {
  const rnd = mulberry32(seed)
  const hours = 7 * 24
  const now = Date.now()
  const start = now - hours * HOUR
  const walk: number[] = [0]
  for (let i = 1; i <= hours; i++) {
    const shock = (rnd() - 0.5) * 2 * (dailyVolPct / 100) * Math.sqrt(1 / 24)
    walk.push(walk[i - 1] + shock)
  }
  const lastWalk = walk[walk.length - 1]
  return walk.map((w, i) => ({
    t: start + i * HOUR,
    price: Math.max(endPrice * (1 + (w - lastWalk) * 0.15), endPrice * 0.05),
  }))
}
