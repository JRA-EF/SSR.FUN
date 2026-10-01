// Quick-fill helpers for the Create Reserve basket (DEC-0203).
//
// Asked for by the Creator, by analogy with a payroll direct-deposit split:
// you set a few explicit amounts and then send "the rest" somewhere, instead
// of doing arithmetic in your head to make the column add up.
//
// Everything here works in BASIS POINTS and only converts to the fractional
// weights the form stores at the edges. Doing it in floats is how a basket
// ends up reading 99.9% or 100.1% after three equal splits -- the form then
// refuses to submit, and the user cannot see which row is wrong because each
// one displays correctly rounded. Integer bps with an explicit remainder pass
// means the column always sums to exactly what it claims.
//
// None of these mutate their input.

/** 100% in basis points. */
export const TOTAL_BPS = 10_000;

/** A fractional weight (0.1 = 10%) as basis points, clamped to [0, 10000]. */
export function toBps(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  return Math.min(TOTAL_BPS, Math.round(weight * TOTAL_BPS));
}

/** Basis points back to the fractional weight the form stores. */
export function toWeight(bps: number): number {
  return bps / TOTAL_BPS;
}

/** What is left unallocated, in bps. Never negative, even for an over-allocated basket. */
export function unallocatedBps(weights: number[]): number {
  const used = weights.reduce((sum, w) => sum + toBps(w), 0);
  return Math.max(0, TOTAL_BPS - used);
}

/**
 * "Rest": give one asset everything still unallocated, on top of what it
 * already has. The column then sums to exactly 100%.
 *
 * Returns the input unchanged when there is nothing left to give, so the
 * button is a no-op rather than a silent re-rounding of every other row.
 */
export function assignRemainder(weights: number[], index: number): number[] {
  if (index < 0 || index >= weights.length) return weights;
  const rest = unallocatedBps(weights);
  if (rest === 0) return weights;
  return weights.map((w, i) => (i === index ? toWeight(toBps(w) + rest) : w));
}

/**
 * "Split evenly": every asset gets an equal share of 100%. The division
 * rarely comes out whole (3 assets is 3333.33bps each), so the leftover bps
 * are handed out one at a time from the top rather than silently dropped --
 * three assets become 33.34/33.33/33.33, which sums to exactly 100%.
 */
export function splitEvenly(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(TOTAL_BPS / count);
  let leftover = TOTAL_BPS - base * count;
  return Array.from({ length: count }, () => {
    const extra = leftover > 0 ? 1 : 0;
    if (leftover > 0) leftover -= 1;
    return toWeight(base + extra);
  });
}

/** "Clear": every asset back to 0%, leaving the whole basket unallocated. */
export function clearAll(count: number): number[] {
  return Array.from({ length: count }, () => 0);
}

/**
 * True when the weights sum to exactly 100% in bps -- the condition the
 * quick-fill buttons are there to make reachable without arithmetic.
 */
export function isFullyAllocated(weights: number[]): boolean {
  return weights.reduce((sum, w) => sum + toBps(w), 0) === TOTAL_BPS;
}
