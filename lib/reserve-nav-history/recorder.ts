// The write side of the Reserve NAV History store, called by
// api/mainnet/warm-cache-cron.ts on every self-warming refresh (~15s). Pure
// decision logic lives in navMath.ts; this module only sequences the DB reads
// and the throttled append. Best-effort by contract: a failure here must
// never fail the snapshot refresh that feeds the homepage.

import { appendNavPoints, readLatestNavPoints } from './db'
import { computeNavUsd, shouldRecordNavPoint, type NavInputReserve, type NavPoint } from './navMath'

/** Invocation-scoped recorder state: the last recorded point per Reserve, seeded from the DB once, then advanced in memory as points are written. */
export interface NavRecorderState {
  latest: Map<string, NavPoint> | null
}

export function createNavRecorderState(): NavRecorderState {
  return { latest: null }
}

/**
 * Computes every Reserve's NAV from the pass's live balances + prices and
 * appends the ones worth recording. Returns how many rows were written.
 */
export async function recordNavPoints(
  cluster: string,
  reserves: NavInputReserve[],
  priceByMint: Record<string, number>,
  state: NavRecorderState,
  now: number = Date.now(),
): Promise<number> {
  if (!state.latest) state.latest = await readLatestNavPoints(cluster)
  const toWrite: { reserve: string; t: number; nav: number }[] = []
  for (const r of reserves) {
    const nav = computeNavUsd(r, priceByMint)
    if (nav === null) continue
    if (!shouldRecordNavPoint(state.latest.get(r.reserve) ?? null, nav, now)) continue
    toWrite.push({ reserve: r.reserve, t: now, nav })
  }
  if (toWrite.length === 0) return 0
  await appendNavPoints(cluster, toWrite)
  for (const p of toWrite) state.latest.set(p.reserve, { t: p.t, nav: p.nav })
  return toWrite.length
}
