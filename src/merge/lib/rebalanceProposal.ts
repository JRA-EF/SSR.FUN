// How the Manager Dashboard's Rebalance tab (src/merge/pages/ManageDTR.tsx)
// derives its proposed composition from the Reserve's on-chain composition,
// and keeps it at exactly 100%. Pure, so tests cover it without React.
//
// The previous seeding was "fill gaps only": an on-chain asset's weight was
// copied into the proposal the first time its mint was seen and never
// again, and any shortfall against 100% was folded into the cash slot at
// that moment. Two real sequences broke the 100% invariant that way:
//   - a weight seeded from a stale or partial read (the warm snapshot, or a
//     discovery pass that resolved fewer assets than the Reserve holds)
//     stayed, and when the missing asset later appeared with its real
//     weight it was ADDED on top -- 100% + 100% = the reported 200%;
//   - slack folded into the cash slot while an asset was still unresolved
//     was likewise never taken back.
// Now an on-chain asset whose target CHANGED on-chain (or is seen for the
// first time) takes its real on-chain weight, an in-progress edit of an
// asset whose target did not change is kept, an unresolved composition
// seeds no slack at all, and the result is normalised to exactly 10,000 bps
// before it is shown.
import { distributeProportionally, type SliderAsset } from "./rebalanceSlider";

export interface OnChainWeight {
  mint: string;
  weightBps: number;
}

export const TOTAL_BPS = 10_000;

/**
 * Pure. Brings `rows` to exactly 10,000 bps. A shortfall goes to the cash
 * slot; an excess is taken from the cash slot first and then proportionally
 * from every other asset (equal split among all-zero assets). Mints in
 * `frozen` never receive weight (they may still give it up), so an asset the
 * Manager took out of the list stays at 0%. Rows already summing to 10,000
 * are returned as-is. Never mutates its input.
 */
export function normalizeProposal(rows: SliderAsset[], cashMint: string, frozen: ReadonlySet<string> = new Set()): SliderAsset[] {
  const total = rows.reduce((s, a) => s + a.weightBps, 0);
  const diff = TOTAL_BPS - total;
  if (diff === 0 || rows.length === 0) return rows;
  const byMint = new Map(rows.map((a) => [a.mint, a.weightBps]));
  const cash = rows.find((a) => a.mint === cashMint);
  const cashCanReceive = cash !== undefined && !frozen.has(cashMint);

  if (diff > 0) {
    // Shortfall: the cash slot absorbs it, else spread across the unfrozen assets.
    if (cashCanReceive) {
      byMint.set(cashMint, cash!.weightBps + diff);
    } else {
      const pool = rows.filter((a) => !frozen.has(a.mint));
      const target = pool.length > 0 ? pool : rows;
      for (const [mint, val] of distributeProportionally(target, diff, "add")) byMint.set(mint, val);
    }
  } else {
    // Excess: drain the cash slot first, then everything else proportionally.
    let excess = -diff;
    if (cash) {
      const fromCash = Math.min(excess, cash.weightBps);
      byMint.set(cashMint, cash.weightBps - fromCash);
      excess -= fromCash;
    }
    if (excess > 0) {
      const pool = rows.filter((a) => a.mint !== cashMint);
      for (const [mint, val] of distributeProportionally(pool, excess, "subtract")) byMint.set(mint, val);
    }
  }
  return rows.map((a) => ({ mint: a.mint, weightBps: byMint.get(a.mint) ?? a.weightBps }));
}

export interface ReseededProposal {
  /** The proposal to show, keyed by mint. */
  weights: Record<string, number>;
  /** The on-chain targets this proposal has now accounted for -- pass it back as `chainSeen` next time. */
  chainSeen: Record<string, number>;
}

/**
 * Pure. The proposal to show after an on-chain read (first load, a poll, or
 * the refresh after the Manager's own submit).
 *   - An on-chain asset whose target differs from `chainSeen` (changed
 *     on-chain, or seen for the first time) takes its on-chain weight; one
 *     whose target is unchanged keeps the Manager's in-progress value, so a
 *     poll that merely re-reports the same chain never snaps a slider back.
 *   - Every key in `prev` that is not on-chain is an asset added this
 *     session and keeps its proposed weight.
 *   - The cash slot is present (at 0 if new) even when the Reserve does not
 *     hold it, so every edit has somewhere to move weight.
 *   - Mints in `forcedZero` (taken out of the list by the Manager) are
 *     pinned at 0.
 *   - With `resolvedFully` false the chain view is incomplete: nothing is
 *     normalised and no slack is invented (the page disables Submit);
 *     otherwise the result sums to exactly 10,000 bps.
 */
export function reseedProposal(
  prev: Record<string, number>,
  onChain: OnChainWeight[],
  chainSeen: Record<string, number>,
  cashMint: string,
  resolvedFully: boolean,
  forcedZero: ReadonlySet<string> = new Set(),
): ReseededProposal {
  const onChainMints = new Set(onChain.map((a) => a.mint));
  const rows: SliderAsset[] = onChain.map((a) => {
    const changed = chainSeen[a.mint] !== a.weightBps || !(a.mint in prev);
    const weightBps = forcedZero.has(a.mint) ? 0 : changed ? a.weightBps : prev[a.mint];
    return { mint: a.mint, weightBps };
  });
  for (const [mint, weightBps] of Object.entries(prev)) {
    if (!onChainMints.has(mint)) rows.push({ mint, weightBps: forcedZero.has(mint) ? 0 : weightBps });
  }
  if (!rows.some((a) => a.mint === cashMint)) rows.push({ mint: cashMint, weightBps: 0 });
  const finalRows = resolvedFully ? normalizeProposal(rows, cashMint, forcedZero) : rows;
  const nextSeen = { ...chainSeen };
  for (const a of onChain) nextSeen[a.mint] = a.weightBps;
  return { weights: Object.fromEntries(finalRows.map((a) => [a.mint, a.weightBps])), chainSeen: nextSeen };
}
