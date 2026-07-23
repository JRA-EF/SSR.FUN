import type { Reserve } from '../domain/types'
import { unallocatedBps } from '../domain/types'
import { assetById } from '../data/assets'
import { OTHER_COLOR, SERIES_COLORS, UNALLOC_COLOR, type CompItem } from './charts'

/**
 * Build composition-bar items for a Reserve. Colors are assigned by the
 * Reserve's fixed allocation order (never re-sorted), so a given asset keeps
 * its color everywhere that Reserve is shown. Assets beyond the 8 validated
 * categorical slots fold into "Other"; Unallocated USDC is always neutral.
 */
export function compItems(r: Reserve, mode: 'target' | 'current' = 'target'): CompItem[] {
  const items: CompItem[] = []
  let otherBps = 0
  const others: string[] = []
  r.allocations.forEach((a, i) => {
    const bps = mode === 'target' ? a.targetBps : a.currentBps
    if (i < SERIES_COLORS.length) {
      const asset = assetById(a.assetId)
      items.push({ label: asset.symbol, sub: asset.name, bps, color: SERIES_COLORS[i] })
    } else {
      otherBps += bps
      others.push(assetById(a.assetId).symbol)
    }
  })
  if (otherBps > 0) items.push({ label: 'Other', sub: others.join(', '), bps: otherBps, color: OTHER_COLOR })
  const un = mode === 'target'
    ? unallocatedBps(r.allocations)
    : 10000 - r.allocations.reduce((s, a) => s + a.currentBps, 0)
  if (un > 0) items.push({ label: 'Unallocated USDC', bps: un, color: UNALLOC_COLOR })
  return items
}
