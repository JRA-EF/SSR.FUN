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

export const DAY = 86_400_000
