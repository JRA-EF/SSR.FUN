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

/**
 * Fractional weights -> integer bps for the chain, rounded so the total is
 * exactly what the weights add up to (DEC-0247). Rounding each row on its own
 * overshoots: seven equal assets are 1428.57bps each, which rounds to 1429
 * and sums to 10003 -- "Invalid allocation total (100.03%)" at launch.
 *
 * Largest-remainder: the target total is the rounded sum, capped at 100%
 * (a basket over 100% is first scaled down to 100%); every row gets its
 * floor, then the leftover bps go one each to the rows with the biggest
 * fractional parts (ties to the earlier row). A basket that adds up to 100%
 * therefore always lands on exactly 10000, and one that is deliberately
 * under 100% keeps its unallocated share. The caller decides whether a
 * genuinely over-100% basket is an error; this never exceeds 100%.
 */
export function apportionBps(weights: number[]): number[] {
  let exact = weights.map((w) => (Number.isFinite(w) && w > 0 ? w * TOTAL_BPS : 0));
  const sum = exact.reduce((s, x) => s + x, 0);
  if (sum > TOTAL_BPS) exact = exact.map((x) => (x * TOTAL_BPS) / sum);
  const target = Math.min(TOTAL_BPS, Math.round(Math.min(sum, TOTAL_BPS)));
  const bps = exact.map((x) => Math.floor(x));
  let leftover = target - bps.reduce((s, b) => s + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .filter(({ i }) => exact[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; leftover > 0 && order.length > 0; k = (k + 1) % order.length) {
    bps[order[k].i] += 1;
    leftover -= 1;
  }
  return bps;
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

/**
 * DEC-0249: the Create Reserve gate. Null when the basket is exactly 100%;
 * otherwise the sentence that tells the user what to fix. The launch never
 * runs on a basket under or over 100% (Creator, 2026-10-15).
 */
export function allocationGateMessage(weights: number[]): string | null {
  if (weights.length === 0) return "Add at least one asset to the Reserve.";
  const used = weights.reduce((sum, w) => sum + toBps(w), 0);
  if (used === TOTAL_BPS) return null;
  const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  return used < TOTAL_BPS
    ? `Your allocations add up to ${pct(used)}. They must total exactly 100% before you can continue -- add the missing ${pct(TOTAL_BPS - used)} to one or more assets.`
    : `Your allocations add up to ${pct(used)}. They must total exactly 100% before you can continue -- take ${pct(used - TOTAL_BPS)} off one or more assets.`;
}
