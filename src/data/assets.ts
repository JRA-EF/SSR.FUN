import type { Asset, AssetCapabilities } from '../domain/types'

const FULL: AssetCapabilities = {
  canHold: true,
  canTransfer: true,
  canPrice: true,
  canRouteIn: true,
  canRouteOut: true,
  canMintInKind: true,
  canRedeemInKind: true,
  hasTransferRestrictions: false,
  hasTransferFee: false,
  hasFreezeAuthority: false,
  tokenProgram: 'spl-token',
  decimalsVerified: true,
  metadataVerified: true,
  priceSource: 'Oracle (mock)',
  routeSource: 'Aggregator (mock)',
}

function cap(over: Partial<AssetCapabilities> = {}): AssetCapabilities {
  return { ...FULL, ...over }
}

/** Mock Solana asset catalog. Prices are illustrative, not live. */
export const ASSETS: Asset[] = [
  { id: 'usdc', symbol: 'USDC', name: 'USD Coin', decimals: 6, price: 1.0, change24h: 0.0, category: 'stable', capabilities: cap({ hasFreezeAuthority: true }) },
  { id: 'sol', symbol: 'SOL', name: 'Solana', decimals: 9, price: 168.42, change24h: 2.4, category: 'core', capabilities: cap() },
  { id: 'msol', symbol: 'mSOL', name: 'Marinade staked SOL', decimals: 9, price: 198.11, change24h: 2.6, category: 'staked-sol', capabilities: cap() },
  { id: 'jitosol', symbol: 'JitoSOL', name: 'Jito staked SOL', decimals: 9, price: 194.7, change24h: 2.5, category: 'staked-sol', capabilities: cap() },
  { id: 'bsol', symbol: 'bSOL', name: 'BlazeStake staked SOL', decimals: 9, price: 189.9, change24h: 2.3, category: 'staked-sol', capabilities: cap() },
  { id: 'jup', symbol: 'JUP', name: 'Jupiter', decimals: 6, price: 0.92, change24h: -1.2, category: 'defi', capabilities: cap() },
  { id: 'jto', symbol: 'JTO', name: 'Jito', decimals: 9, price: 2.61, change24h: 0.8, category: 'defi', capabilities: cap() },
  { id: 'pyth', symbol: 'PYTH', name: 'Pyth Network', decimals: 6, price: 0.31, change24h: -0.6, category: 'defi', capabilities: cap() },
  { id: 'ray', symbol: 'RAY', name: 'Raydium', decimals: 6, price: 2.87, change24h: 3.1, category: 'defi', capabilities: cap() },
  { id: 'orca', symbol: 'ORCA', name: 'Orca', decimals: 6, price: 3.44, change24h: 1.7, category: 'defi', capabilities: cap() },
  { id: 'drift', symbol: 'DRIFT', name: 'Drift Protocol', decimals: 6, price: 0.74, change24h: -2.2, category: 'defi', capabilities: cap() },
  { id: 'kmno', symbol: 'KMNO', name: 'Kamino', decimals: 6, price: 0.058, change24h: 0.4, category: 'defi', capabilities: cap() },
  { id: 'bonk', symbol: 'BONK', name: 'Bonk', decimals: 5, price: 0.0000221, change24h: 6.8, category: 'meme', capabilities: cap() },
  { id: 'wif', symbol: 'WIF', name: 'dogwifhat', decimals: 6, price: 1.86, change24h: 5.1, category: 'meme', capabilities: cap() },
  { id: 'popcat', symbol: 'POPCAT', name: 'Popcat', decimals: 9, price: 0.41, change24h: -4.3, category: 'meme', capabilities: cap() },
  { id: 'mew', symbol: 'MEW', name: 'cat in a dogs world', decimals: 5, price: 0.0034, change24h: 3.9, category: 'meme', capabilities: cap() },
  { id: 'rndr', symbol: 'RENDER', name: 'Render', decimals: 8, price: 4.12, change24h: 1.1, category: 'depin', capabilities: cap() },
  { id: 'hnt', symbol: 'HNT', name: 'Helium', decimals: 8, price: 3.05, change24h: -0.9, category: 'depin', capabilities: cap() },
  { id: 'io', symbol: 'IO', name: 'io.net', decimals: 8, price: 1.42, change24h: 2.0, category: 'depin', capabilities: cap() },
  { id: 'grass', symbol: 'GRASS', name: 'Grass', decimals: 9, price: 1.77, change24h: 4.6, category: 'depin', capabilities: cap() },
  { id: 'usdt', symbol: 'USDT', name: 'Tether USD', decimals: 6, price: 1.0, change24h: 0.0, category: 'stable', capabilities: cap({ hasFreezeAuthority: true }) },
  { id: 'pyusd', symbol: 'PYUSD', name: 'PayPal USD', decimals: 6, price: 1.0, change24h: 0.0, category: 'stable', capabilities: cap({ tokenProgram: 'token-2022', hasFreezeAuthority: true }) },
  {
    id: 'tbill',
    symbol: 'TBILL',
    name: 'Tokenized T-bill fund (mock)',
    decimals: 6,
    price: 1.043,
    change24h: 0.01,
    category: 'rwa',
    capabilities: cap({
      tokenProgram: 'token-2022',
      hasTransferRestrictions: true,
      hasFreezeAuthority: true,
      canRouteIn: false,
      canRouteOut: false,
      routeSource: null,
    }),
  },
  {
    id: 'newcoin',
    symbol: 'NEWX',
    name: 'Newly listed token (mock)',
    decimals: 9,
    price: 0.12,
    change24h: 14.2,
    category: 'meme',
    capabilities: cap({ canPrice: false, priceSource: null, metadataVerified: false }),
  },
]

export const ASSET_MAP: Record<string, Asset> = Object.fromEntries(ASSETS.map(a => [a.id, a]))

export function assetById(id: string): Asset {
  const a = ASSET_MAP[id]
  if (!a) throw new Error(`Unknown asset: ${id}`)
  return a
}

/** Human-readable capability limitations worth disclosing in the UI. */
export function capabilityNotes(a: Asset): { label: string; severity: 'info' | 'warn' }[] {
  const c = a.capabilities
  const notes: { label: string; severity: 'info' | 'warn' }[] = []
  if (!c.canPrice) notes.push({ label: 'No price source', severity: 'warn' })
  if (c.hasTransferRestrictions) notes.push({ label: 'Restricted transfers', severity: 'warn' })
  if (c.hasTransferFee) notes.push({ label: 'Transfer fee', severity: 'warn' })
  if (!c.canRouteIn || !c.canRouteOut) notes.push({ label: 'No conversion route', severity: 'warn' })
  if (c.hasFreezeAuthority) notes.push({ label: 'Freeze authority', severity: 'info' })
  if (!c.metadataVerified) notes.push({ label: 'Unverified metadata', severity: 'warn' })
  if (c.tokenProgram === 'token-2022') notes.push({ label: 'Token-2022', severity: 'info' })
  return notes
}
