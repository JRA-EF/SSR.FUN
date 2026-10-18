// DEC-0250: what a rebalance must actually trade. Pure: live vault balances,
// prices and the target weights in; the swap legs and the assets to remove
// out. Both the build endpoint and the tests call this.
//
// Each asset's value is its vault balance at SSR's price; its desired value
// is the Reserve's total value times its target weight. Over-target assets
// are sold, under-target assets bought, largest gaps paired first, each leg
// a direct asset-to-asset swap (no USDC hop unless USDC itself is a target).
// An asset whose target is 0% is sold in full -- its LAST leg takes every
// remaining raw unit, so its vault reaches exactly zero and it can then be
// removed from the Reserve.

export interface PlanAsset {
  mint: string;
  decimals: number;
  balanceRaw: bigint;
  /** USD per whole token; null when no price is available. */
  priceUsd: number | null;
  targetBps: number;
}

export interface PlannedLeg {
  sellMint: string;
  buyMint: string;
  amountInRaw: bigint;
  /** USD value of `amountInRaw` at SSR's price. */
  usd: number;
  /** This leg empties the sell asset's vault. */
  sellsAll: boolean;
}

export interface RebalancePlan {
  totalUsd: number;
  legs: PlannedLeg[];
  /** Assets whose target is 0% and whose vault the legs empty (or is already empty), in the order to remove them. */
  removals: string[];
  /** Assets that hold value but have no price -- a plan is refused while any exists. */
  unpriced: string[];
  /** Per asset, value now and after, for the confirmation screen. */
  rows: { mint: string; valueUsd: number; targetUsd: number; targetBps: number }[];
}

/** Gaps smaller than this are left alone: a swap's network fee would cost more than it fixes. */
export const REBALANCE_DUST_USD = 0.05;

export function planRebalance(assets: PlanAsset[], dustUsd: number = REBALANCE_DUST_USD): RebalancePlan {
  const totalBps = assets.reduce((s, a) => s + a.targetBps, 0);
  if (totalBps !== 10_000) throw new Error(`Target weights must add up to exactly 100% (they add up to ${(totalBps / 100).toFixed(2)}%).`);
  const unpriced = assets.filter((a) => (a.balanceRaw > 0n || a.targetBps > 0) && (a.priceUsd === null || !(a.priceUsd > 0))).map((a) => a.mint);
  const value = (a: PlanAsset) => (a.priceUsd && a.priceUsd > 0 ? (Number(a.balanceRaw) / 10 ** a.decimals) * a.priceUsd : 0);
  const totalUsd = assets.reduce((s, a) => s + value(a), 0);
  const rows = assets.map((a) => ({ mint: a.mint, valueUsd: value(a), targetUsd: (totalUsd * a.targetBps) / 10_000, targetBps: a.targetBps }));
  if (unpriced.length > 0) return { totalUsd, legs: [], removals: [], unpriced, rows };

  type Side = { a: PlanAsset; gap: number; remainingRaw: bigint };
  const sellers: Side[] = [];
  const buyers: Side[] = [];
  assets.forEach((a, i) => {
    const gap = rows[i].valueUsd - rows[i].targetUsd;
    // A 0% asset is always sold in full, however small, so it can be removed.
    if (a.targetBps === 0 && a.balanceRaw > 0n) sellers.push({ a, gap: rows[i].valueUsd, remainingRaw: a.balanceRaw });
    else if (gap > dustUsd) sellers.push({ a, gap, remainingRaw: a.balanceRaw });
    else if (-gap > dustUsd) buyers.push({ a, gap: -gap, remainingRaw: 0n });
  });
  sellers.sort((x, y) => y.gap - x.gap);
  buyers.sort((x, y) => y.gap - x.gap);

  const legs: PlannedLeg[] = [];
  // A 0% asset with nowhere under-target to go still has to be emptied: its
  // value then goes to the largest-target asset.
  const fallbackBuyer = [...assets].filter((a) => a.targetBps > 0).sort((x, y) => y.targetBps - x.targetBps)[0];
  for (const s of sellers) {
    const sellAll = s.a.targetBps === 0;
    while (s.gap > (sellAll ? 0 : dustUsd) && s.remainingRaw > 0n) {
      const b = buyers.find((x) => x.gap > dustUsd);
      const buyMint = b ? b.a.mint : sellAll && fallbackBuyer ? fallbackBuyer.mint : null;
      if (!buyMint) break;
      const usd = b ? Math.min(s.gap, b.gap) : s.gap;
      const lastForSeller = sellAll && (s.gap - usd <= dustUsd || !buyers.some((x) => x !== b && x.gap > dustUsd));
      const take = lastForSeller ? s.remainingRaw : minBig(s.remainingRaw, BigInt(Math.floor((usd / (s.a.priceUsd as number)) * 10 ** s.a.decimals)));
      if (take <= 0n) break;
      legs.push({ sellMint: s.a.mint, buyMint, amountInRaw: take, usd: lastForSeller ? s.gap : usd, sellsAll: take === s.remainingRaw });
      s.remainingRaw -= take;
      s.gap -= lastForSeller ? s.gap : usd;
      if (b) b.gap -= usd;
      if (lastForSeller) break;
    }
  }
  // Legs into the same buy asset from the same seller are merged.
  const merged: PlannedLeg[] = [];
  for (const l of legs) {
    const m = merged.find((x) => x.sellMint === l.sellMint && x.buyMint === l.buyMint);
    if (m) {
      m.amountInRaw += l.amountInRaw;
      m.usd += l.usd;
      m.sellsAll = m.sellsAll || l.sellsAll;
    } else merged.push({ ...l });
  }
  const emptied = new Set(merged.filter((l) => l.sellsAll).map((l) => l.sellMint));
  const removals = assets.filter((a) => a.targetBps === 0 && (a.balanceRaw === 0n || emptied.has(a.mint))).map((a) => a.mint);
  return { totalUsd, legs: merged, removals, unpriced: [], rows };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Pure: the sequence of compact removals for `removals`, given the Reserve's
 * assets in on-chain order. Each removal moves the current LAST asset into
 * the freed position (remove_reserve_asset_compact), so each step names the
 * asset that moves -- null when the removed one is itself last.
 */
export function compactRemovalSteps(orderedMints: string[], removals: string[]): { mint: string; lastAssetMint: string | null }[] {
  const order = [...orderedMints];
  const steps: { mint: string; lastAssetMint: string | null }[] = [];
  for (const mint of removals) {
    const idx = order.indexOf(mint);
    if (idx < 0) continue;
    const last = order[order.length - 1];
    steps.push({ mint, lastAssetMint: last === mint ? null : last });
    order[idx] = last;
    order.pop();
  }
  return steps;
}
