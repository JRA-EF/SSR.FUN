// Pure weight-redistribution model for the redesigned Manage Reserve ->
// Portfolio Rebalance tab's slider editor (DEC-0084). devUSDC acts as the
// Reserve's "cash" slot: reducing any other asset's slider feeds the freed
// weight into devUSDC; increasing one draws from devUSDC first, then
// proportionally from every other asset if devUSDC alone isn't enough.
// Dragging devUSDC's own slider is the symmetric case, spread across every
// other asset. This is deliberately separate from calculations.ts's
// applyRebalance (still used by ManageDTR.tsx's untouched simulated/demo
// branch) -- that function's generic "rescale everyone" model has no
// cash-bucket concept and the two must never be conflated.
//
// Preconditions/guarantees: `assets` must already sum to exactly 10,000bps
// on input; every function here preserves that sum exactly on output
// (integer bps only -- no floating point drift) and never mutates its
// input.

export interface SliderAsset {
  mint: string;
  weightBps: number;
}

/**
 * Spreads `amount` (bps, >=0) across `pool` proportional to each asset's
 * current weightBps share of the pool's total (equal split if the pool's
 * total is currently 0). `direction` "add" grows every pool asset; "subtract"
 * shrinks them, capped so no asset ever goes negative (capping only matters
 * defensively -- under this module's stated precondition, `amount` is always
 * exactly the pool's available total in a full-drain, so no cap ever bites).
 * Rounding: each share is floored, then the leftover bps from flooring is
 * applied one unit at a time, cycling through the pool in order, skipping
 * any entry that would go negative -- so a full drain always lands every
 * pool asset on exactly 0, never off by a stray bps.
 */
function distributeProportionally(
  pool: SliderAsset[],
  amount: number,
  direction: "add" | "subtract",
): Map<string, number> {
  const result = new Map<string, number>();
  if (pool.length === 0) return result;
  if (amount <= 0) {
    for (const a of pool) result.set(a.mint, a.weightBps);
    return result;
  }

  const poolTotal = pool.reduce((sum, a) => sum + a.weightBps, 0);
  const cappedAmount = direction === "subtract" ? Math.min(amount, poolTotal) : amount;
  const shares = poolTotal > 0
    ? pool.map((a) => a.weightBps / poolTotal)
    : pool.map(() => 1 / pool.length);

  let allocated = 0;
  const floors = shares.map((share) => Math.floor(cappedAmount * share));
  for (let i = 0; i < pool.length; i++) {
    const base = pool[i].weightBps;
    const next = direction === "add" ? base + floors[i] : Math.max(0, base - floors[i]);
    result.set(pool[i].mint, next);
    allocated += Math.abs(next - base);
  }

  let leftover = cappedAmount - allocated;
  let idx = 0;
  let safety = pool.length * pool.length + pool.length + 5;
  while (leftover > 0 && safety-- > 0) {
    const mint = pool[idx % pool.length].mint;
    const cur = result.get(mint)!;
    if (direction === "add") {
      result.set(mint, cur + 1);
      leftover--;
    } else if (cur > 0) {
      result.set(mint, cur - 1);
      leftover--;
    }
    idx++;
  }

  return result;
}

/**
 * Applies one user-driven slider/input edit to a proposed Reserve
 * composition. See this file's header comment for the devUSDC-priority
 * cash-bucket rules. Returns a new array (same length/order/mints as
 * `assets`) with only the affected mints' weightBps changed -- never
 * mutates `assets`.
 */
export function applySliderWeightChange(
  assets: SliderAsset[],
  editedMint: string,
  newWeightBps: number,
  devUsdcMint: string,
): SliderAsset[] {
  const edited = assets.find((a) => a.mint === editedMint);
  if (!edited) return assets;

  const clamped = Math.max(0, Math.min(10_000, Math.round(newWeightBps)));
  const delta = clamped - edited.weightBps;
  if (delta === 0) return assets;

  const devUsdc = assets.find((a) => a.mint === devUsdcMint);
  const byMint = new Map(assets.map((a) => [a.mint, a.weightBps]));

  if (editedMint === devUsdcMint || !devUsdc) {
    // Direct edit of devUSDC itself, or devUSDC isn't part of this
    // composition at all: symmetric proportional distribute/pull across
    // every OTHER asset.
    const others = assets.filter((a) => a.mint !== editedMint);
    const changes = distributeProportionally(others, Math.abs(delta), delta < 0 ? "add" : "subtract");
    for (const [mint, val] of changes) byMint.set(mint, val);
  } else if (delta < 0) {
    // Decreasing a non-devUSDC asset: the freed weight goes 1:1 into devUSDC.
    byMint.set(devUsdcMint, (byMint.get(devUsdcMint) ?? 0) + -delta);
  } else {
    // Increasing a non-devUSDC asset: draw from devUSDC first, then
    // proportionally from every other non-devUSDC asset if still short.
    const devUsdcAvailable = byMint.get(devUsdcMint) ?? 0;
    const drawnFromDevUsdc = Math.min(delta, devUsdcAvailable);
    byMint.set(devUsdcMint, devUsdcAvailable - drawnFromDevUsdc);
    const stillNeeded = delta - drawnFromDevUsdc;
    if (stillNeeded > 0) {
      const pool = assets.filter((a) => a.mint !== editedMint && a.mint !== devUsdcMint);
      const changes = distributeProportionally(pool, stillNeeded, "subtract");
      for (const [mint, val] of changes) byMint.set(mint, val);
    }
  }

  byMint.set(editedMint, clamped);
  return assets.map((a) => ({ mint: a.mint, weightBps: byMint.get(a.mint) ?? a.weightBps }));
}
