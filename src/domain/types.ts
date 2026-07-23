/** Capability-based Reserve Asset compatibility — no universal yes/no flag. */
export interface AssetCapabilities {
  canHold: boolean
  canTransfer: boolean
  canPrice: boolean
  canRouteIn: boolean
  canRouteOut: boolean
  canMintInKind: boolean
  canRedeemInKind: boolean
  hasTransferRestrictions: boolean
  hasTransferFee: boolean
  hasFreezeAuthority: boolean
  tokenProgram: 'spl-token' | 'token-2022'
  decimalsVerified: boolean
  metadataVerified: boolean
  priceSource: string | null
  routeSource: string | null
}

export interface Asset {
  id: string
  symbol: string
  name: string
  decimals: number
  /** Mock oracle price in USD (display only). */
  price: number
  change24h: number
  category: 'core' | 'staked-sol' | 'defi' | 'meme' | 'depin' | 'stable' | 'rwa'
  capabilities: AssetCapabilities
}

export interface Allocation {
  assetId: string
  /** Target weight in basis points. Sum across assets ≤ 10000; remainder is Unallocated USDC. */
  targetBps: number
  /** Current drifted weight in bps (mock market drift). */
  currentBps: number
}

/** Manager fees in basis points, each 0–5000. */
export interface FeeConfig {
  mintBps: number
  redeemBps: number
  tvlBps: number
}

export interface DelegatePermissions {
  manageDelegates: boolean
  rebalance: boolean
  editFees: boolean
  editMetadata: boolean
  pauseOperations: boolean
  managePromotion: boolean
}

export interface Delegate {
  address: string
  label: string
  permissions: DelegatePermissions
}

export type ActivityKind = 'mint' | 'redeem' | 'rebalance' | 'create' | 'fee-update' | 'delegate' | 'wind-down'

export interface ActivityEvent {
  id: string
  kind: ActivityKind
  ts: number
  wallet: string
  /** USD value of the event where applicable. */
  amountUsd?: number
  tokens?: number
  note?: string
}

export type RiskLabel = 'High volatility' | 'Unpriced asset' | 'Transfer-restricted asset' | 'New reserve' | 'Concentrated'

export interface Reserve {
  address: string
  name: string // immutable after creation
  ticker: string // immutable after creation
  description: string
  creator: string // permanently identifiable
  manager: string // root Reserve Manager (transferable)
  createdAt: number
  allocations: Allocation[]
  fees: FeeConfig
  /** Reserve Token supply (display units). */
  supply: number
  /** Total Reserve value in USD (NAV). */
  navUsd: number
  /** External market price per Reserve Token — may deviate from NAV. */
  marketPrice: number | null
  holders: number
  verified: boolean
  indexed: boolean
  riskLabels: RiskLabel[]
  /** Daily NAV-per-token history, oldest first (90 points). */
  navSeries: number[]
  /** Daily market price history aligned with navSeries (null when no external liquidity). */
  marketSeries: number[] | null
  activity: ActivityEvent[]
  delegates: Delegate[]
  status: 'active' | 'winding-down'
  lastRebalanceTs: number | null
}

export function navPerToken(r: Reserve): number {
  return r.supply > 0 ? r.navUsd / r.supply : 0
}

export function unallocatedBps(allocs: { targetBps: number }[]): number {
  return 10000 - allocs.reduce((s, a) => s + a.targetBps, 0)
}

/** Premium(+)/discount(−) of market price to NAV per token, in percent. Null when no market. */
export function premiumPct(r: Reserve): number | null {
  const nav = navPerToken(r)
  if (r.marketPrice == null || nav === 0) return null
  return ((r.marketPrice - nav) / nav) * 100
}
