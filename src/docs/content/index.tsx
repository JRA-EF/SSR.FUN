import type { ReactNode } from 'react'
import { GettingStarted } from './GettingStarted'
import { ReserveTokensOnDexes } from './ReserveTokensOnDexes'
import { AddLiquidity } from './AddLiquidity'
import { ProtocolReference } from './ProtocolReference'

export interface DocEntry {
  /** URL segment: /docs/<slug>. */
  slug: string
  title: string
  /** One or two sentences for the index card and the sidebar tooltip. */
  blurb: string
  /** Who this is for -- shown as an eyebrow label. */
  audience: string
  /** Absolute date, updated by hand when the content changes. */
  updated: string
  render: () => ReactNode
}

export const DOCS: DocEntry[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    blurb: 'What a Reserve is, what a Reserve Token is, and how buying, selling, and launching work.',
    audience: 'Everyone',
    updated: '17 September 2026',
    render: () => <GettingStarted />,
  },
  {
    slug: 'reserve-tokens-on-dexes',
    title: 'Reserve Tokens on DEXes',
    blurb: 'How a Reserve Token behaves as a standard Solana token: what happens on SSR.fun versus on an exchange, its on-chain properties, and how any mint resolves to its Reserve.',
    audience: 'Holders, exchanges and wallets',
    updated: '17 September 2026',
    render: () => <ReserveTokensOnDexes />,
  },
  {
    slug: 'add-liquidity',
    title: 'Adding liquidity',
    blurb: 'Step by step: pooling a Reserve Token on Raydium or PumpSwap, and the fees and risks specific to Reserve Tokens.',
    audience: 'Holders and Managers',
    updated: '17 September 2026',
    render: () => <AddLiquidity />,
  },
  {
    slug: 'protocol-reference',
    title: 'Protocol reference',
    blurb: 'Program addresses, account seeds, the Reserve account layout, and fee limits, with code to derive and decode them.',
    audience: 'Developers',
    updated: '17 September 2026',
    render: () => <ProtocolReference />,
  },
]

export function findDoc(slug: string | null): DocEntry | undefined {
  if (!slug) return undefined
  return DOCS.find(d => d.slug === slug)
}
