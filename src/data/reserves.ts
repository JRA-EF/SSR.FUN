import type { ActivityEvent, Allocation, Reserve } from '../domain/types'
import { DAY, marketFromNav, mulberry32, walkSeries } from './mock'

/** The mock connected wallet (Reserve Creator / Manager for two seeded Reserves). */
export const MY_WALLET = 'EnigZ4kq9vXhRt2mYwL8cJd6UbPnAoF3sHgKe5NuT7Da'
export const MY_WALLET_LABEL = 'enigma.sol'

function alloc(assetId: string, targetBps: number, driftBps = 0): Allocation {
  return { assetId, targetBps, currentBps: targetBps + driftBps }
}

function mkActivity(seed: number, addr: string, createdAt: number, extra: ActivityEvent[] = []): ActivityEvent[] {
  const rnd = mulberry32(seed)
  const kinds = ['mint', 'mint', 'mint', 'redeem'] as const
  const wallets = [
    '3xKpKe2mQvTnRw8uYhBdLcAg51fEjZs9XoMiC4NrV6St',
    '9rTwWq7pLmXbNv3kZcJf2gDh8sYaUeQi6BoKx1MtR5En',
    'B4nHu8sVgYtEw2rQxMk9jClf5dZaPo7iS3TbNe6KvL1m',
    'FvGm3jTq9wRxKu6yHnBs4cEd27ZlPaoi8SbXe5NtV1Dk',
  ]
  const evts: ActivityEvent[] = []
  const n = 6 + Math.floor(rnd() * 5)
  for (let i = 0; i < n; i++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)]
    evts.push({
      id: `${addr}-${i}`,
      kind,
      ts: Date.now() - Math.floor(rnd() * 21) * DAY - Math.floor(rnd() * 86_400_000),
      wallet: wallets[Math.floor(rnd() * wallets.length)],
      amountUsd: Math.round((500 + rnd() * 42_000) / 10) * 10,
      tokens: Math.round(rnd() * 4000 * 100) / 100,
    })
  }
  evts.push({ id: `${addr}-create`, kind: 'create', ts: createdAt, wallet: addr.slice(0, 8), note: 'Reserve created and seeded in kind' })
  return [...evts, ...extra].sort((a, b) => b.ts - a.ts)
}

function mkReserve(r: Omit<Reserve, 'navSeries' | 'marketSeries' | 'activity' | 'marketPrice'> & {
  seed: number
  volPct: number
  driftPct: number
  marketBiasPct: number | null
}): Reserve {
  const navEnd = r.supply > 0 ? r.navUsd / r.supply : 1
  const navSeries = walkSeries(r.seed, 90, navEnd, r.volPct, r.driftPct)
  const marketSeries = r.marketBiasPct == null ? null : marketFromNav(navSeries, r.seed + 7, r.marketBiasPct, Math.max(0.4, r.volPct / 3))
  const marketPrice = marketSeries ? marketSeries[marketSeries.length - 1] : null
  const { seed: _s, volPct: _v, driftPct: _d, marketBiasPct: _m, ...rest } = r
  return {
    ...rest,
    marketPrice,
    navSeries,
    marketSeries,
    activity: mkActivity(r.seed + 13, r.address, r.createdAt),
  }
}

const now = Date.now()

export const SEED_RESERVES: Reserve[] = [
  mkReserve({
    seed: 101,
    address: 'Rsv1SoLBLuechipXk29fJdTq8mWnAe4gYhU6oPzC3vNb',
    name: 'Solana blue chips',
    ticker: 'SBLU',
    description:
      'Large-cap Solana exposure in one Reserve Token: SOL plus the highest-liquidity ecosystem tokens, with a USDC buffer for redemptions.',
    creator: '4mPzXcVbNrKt8wQe2yUj6iLhAo9sDf3gTn5RvEuS1WkM',
    manager: '4mPzXcVbNrKt8wQe2yUj6iLhAo9sDf3gTn5RvEuS1WkM',
    createdAt: now - 84 * DAY,
    allocations: [alloc('sol', 4000, 180), alloc('jup', 1500, -60), alloc('jto', 1200, -40), alloc('pyth', 1000, -30), alloc('ray', 800, 20)],
    fees: { mintBps: 100, redeemBps: 100, tvlBps: 150 },
    supply: 1_284_500,
    navUsd: 4_812_000,
    holders: 2841,
    verified: true,
    indexed: true,
    riskLabels: [],
    delegates: [],
    status: 'active',
    lastRebalanceTs: now - 12 * DAY,
    volPct: 2.4,
    driftPct: 0.18,
    marketBiasPct: 0.6,
  }),
  mkReserve({
    seed: 102,
    address: 'Rsv2StakedSoLyLdWq83nRtY5mKe1cJb7uHgA9oPzX4v',
    name: 'Staked SOL yield',
    ticker: 'YSOL',
    description: 'A basket of liquid-staked SOL tokens. NAV per Reserve Token accrues staking yield through the underlying LSTs.',
    creator: '8kQwErTy2uIoP9aSdFg4hJkL6zXcVb1nM3rTy5uIoP7a',
    manager: '8kQwErTy2uIoP9aSdFg4hJkL6zXcVb1nM3rTy5uIoP7a',
    createdAt: now - 71 * DAY,
    allocations: [alloc('jitosol', 4500, 40), alloc('msol', 3500, -20), alloc('bsol', 1800, -20)],
    fees: { mintBps: 30, redeemBps: 30, tvlBps: 50 },
    supply: 622_400,
    navUsd: 3_195_000,
    holders: 1567,
    verified: true,
    indexed: true,
    riskLabels: [],
    delegates: [],
    status: 'active',
    lastRebalanceTs: null,
    volPct: 1.1,
    driftPct: 0.14,
    marketBiasPct: -0.2,
  }),
  mkReserve({
    seed: 103,
    address: 'Rsv3DeFiGovAqW7e9rTyU2iOp5aSdF8gHjK4lZxCv6bN',
    name: 'DeFi governance',
    ticker: 'DGOV',
    description: 'Governance tokens of the major Solana DeFi protocols, weighted by liquidity.',
    creator: 'CqW3eRtY7uIoP1aSdFgHjKlZxCvBnM9qW2eRtY6uIoPa',
    manager: 'CqW3eRtY7uIoP1aSdFgHjKlZxCvBnM9qW2eRtY6uIoPa',
    createdAt: now - 55 * DAY,
    allocations: [alloc('jup', 2500, 120), alloc('ray', 2000, -80), alloc('orca', 1500, 30), alloc('drift', 1500, -50), alloc('kmno', 1000, 10), alloc('jto', 1000, -30)],
    fees: { mintBps: 150, redeemBps: 150, tvlBps: 200 },
    supply: 402_100,
    navUsd: 1_388_000,
    holders: 894,
    verified: true,
    indexed: true,
    riskLabels: ['High volatility'],
    delegates: [],
    status: 'active',
    lastRebalanceTs: now - 26 * DAY,
    volPct: 3.4,
    driftPct: -0.05,
    marketBiasPct: -1.1,
  }),
  mkReserve({
    seed: 104,
    address: 'Rsv4MemeIndexBw6t8yUjM3oPl9aSdFgH2jKzXcV5bNq',
    name: 'Meme rotation',
    ticker: 'ROTA',
    description: 'The large-cap Solana memecoins in one Reserve Token. Actively rebalanced by its Reserve Manager. High volatility.',
    creator: 'Dg8HjKl3ZxCvBnMqW5eRtYuIoP2aSdF7gHjK9lZxCvBn',
    manager: 'Dg8HjKl3ZxCvBnMqW5eRtYuIoP2aSdF7gHjK9lZxCvBn',
    createdAt: now - 38 * DAY,
    allocations: [alloc('bonk', 3000, 350), alloc('wif', 3000, -150), alloc('popcat', 1500, -240), alloc('mew', 1500, 40)],
    fees: { mintBps: 200, redeemBps: 200, tvlBps: 300 },
    supply: 1_930_000,
    navUsd: 902_000,
    holders: 3216,
    verified: false,
    indexed: true,
    riskLabels: ['High volatility', 'Concentrated'],
    delegates: [],
    status: 'active',
    lastRebalanceTs: now - 4 * DAY,
    volPct: 5.6,
    driftPct: 0.32,
    marketBiasPct: 2.3,
  }),
  mkReserve({
    seed: 105,
    address: 'Rsv5DePinAiXc4v6bNmQ1wEr8tYuI3oPaSdF5gHjKlZx',
    name: 'AI and DePIN',
    ticker: 'AIDN',
    description: 'Compute, rendering, and physical-infrastructure networks on Solana.',
    creator: 'Hj2KlZ9xCvBnMqWeR4tYuIoPaS6dFgHjKlZ8xCvBnMqW',
    manager: 'Hj2KlZ9xCvBnMqWeR4tYuIoPaS6dFgHjKlZ8xCvBnMqW',
    createdAt: now - 47 * DAY,
    allocations: [alloc('rndr', 3000, 90), alloc('hnt', 2500, -110), alloc('io', 2000, 60), alloc('grass', 1500, -40)],
    fees: { mintBps: 100, redeemBps: 100, tvlBps: 150 },
    supply: 355_700,
    navUsd: 1_071_000,
    holders: 743,
    verified: true,
    indexed: true,
    riskLabels: ['High volatility'],
    delegates: [],
    status: 'active',
    lastRebalanceTs: now - 19 * DAY,
    volPct: 3.8,
    driftPct: 0.1,
    marketBiasPct: 0.4,
  }),
  mkReserve({
    seed: 106,
    address: 'Rsv6StabLePlusVb2nM4qWe6rTyU9iOpAs1dFgH3jKlZ',
    name: 'Stability plus',
    ticker: 'STBL',
    description: 'Mostly stablecoins with a small SOL sleeve. A parking Reserve with low volatility, not a yield product.',
    creator: 'Kl5ZxCv2BnMqWeRtY8uIoPaSdF1gHjKlZxC6vBnMqWeR',
    manager: 'Kl5ZxCv2BnMqWeRtY8uIoPaSdF1gHjKlZxC6vBnMqWeR',
    createdAt: now - 63 * DAY,
    allocations: [alloc('usdt', 3000, 0), alloc('pyusd', 2000, 0), alloc('sol', 1000, 40)],
    fees: { mintBps: 10, redeemBps: 10, tvlBps: 20 },
    supply: 1_507_000,
    navUsd: 1_552_000,
    holders: 512,
    verified: true,
    indexed: true,
    riskLabels: [],
    delegates: [],
    status: 'active',
    lastRebalanceTs: null,
    volPct: 0.25,
    driftPct: 0.01,
    marketBiasPct: null,
  }),
  mkReserve({
    seed: 107,
    address: 'Rsv7RwaTreasXm8qW3eRt5yUiO7pAsDf2gHjK6lZxCvB',
    name: 'Treasury bill exposure',
    ticker: 'TBEX',
    description:
      'A Reserve holding a tokenized T-bill fund plus USDC. The T-bill token is transfer-restricted: in-kind minting and redemption require an allow-listed wallet.',
    creator: 'Zx9CvBnM1qWeRtYuIo4PaSdFgHj7KlZxCvBnMq2WeRtY',
    manager: 'Zx9CvBnM1qWeRtYuIo4PaSdFgHj7KlZxCvBnMq2WeRtY',
    createdAt: now - 29 * DAY,
    allocations: [alloc('tbill', 8000, 20)],
    fees: { mintBps: 20, redeemBps: 20, tvlBps: 30 },
    supply: 486_000,
    navUsd: 505_000,
    holders: 208,
    verified: false,
    indexed: true,
    riskLabels: ['Transfer-restricted asset'],
    delegates: [],
    status: 'active',
    lastRebalanceTs: null,
    volPct: 0.08,
    driftPct: 0.012,
    marketBiasPct: null,
  }),
  mkReserve({
    seed: 108,
    address: 'Rsv8FreshLaunchQn5wE2rTy7uIo9pAsD4fGhJ1kLzXc',
    name: 'New listings basket',
    ticker: 'FRSH',
    description: 'Early-stage tokens, including one without a price source yet. NAV shown excludes unpriced holdings; limitations are disclosed, not hidden.',
    creator: 'Mq7WeRtYu3IoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFg',
    manager: 'Mq7WeRtYu3IoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFg',
    createdAt: now - 6 * DAY,
    allocations: [alloc('newcoin', 3000, 200), alloc('wif', 2000, -100), alloc('grass', 2000, 0)],
    fees: { mintBps: 300, redeemBps: 300, tvlBps: 400 },
    supply: 96_400,
    navUsd: 61_200,
    holders: 121,
    verified: false,
    indexed: true,
    riskLabels: ['New reserve', 'Unpriced asset', 'High volatility'],
    delegates: [],
    status: 'active',
    lastRebalanceTs: null,
    volPct: 6.5,
    driftPct: 0.5,
    marketBiasPct: 4.1,
  }),
  // Reserves managed by the mock connected wallet
  mkReserve({
    seed: 109,
    address: 'RsvEnigmaMacroKp3wQ8eRtY2uIoPaSd6FgHjKlZxCvB',
    name: 'Enigma macro',
    ticker: 'ENMA',
    description: 'A discretionary macro Reserve: SOL beta, staked-SOL carry, and a deliberate Unallocated USDC buffer for opportunistic rebalancing.',
    creator: MY_WALLET,
    manager: MY_WALLET,
    createdAt: now - 52 * DAY,
    allocations: [alloc('sol', 3500, 210), alloc('jitosol', 2500, -90), alloc('jup', 1000, -60), alloc('rndr', 1000, 30)],
    fees: { mintBps: 100, redeemBps: 150, tvlBps: 200 },
    supply: 208_300,
    navUsd: 742_000,
    holders: 486,
    verified: true,
    indexed: true,
    riskLabels: [],
    delegates: [
      {
        address: '5tGhY7uJkLpQ2wSxCdVfRbNm8zAq4eOi6yUj9sHg3KlP',
        label: 'ops.enigma.sol',
        permissions: { manageDelegates: false, rebalance: true, editFees: false, editMetadata: true, pauseOperations: false, managePromotion: true },
      },
    ],
    status: 'active',
    lastRebalanceTs: now - 9 * DAY,
    volPct: 2.1,
    driftPct: 0.16,
    marketBiasPct: 0.9,
  }),
  mkReserve({
    seed: 110,
    address: 'RsvEnigmaLstQz6wE9rT3yU5iOpAsDfG2hJkL8zXcVbN',
    name: 'Enigma staked basket',
    ticker: 'ENST',
    description: 'Two-LST staked SOL basket with minimal fees. A low-touch companion to Enigma macro.',
    creator: MY_WALLET,
    manager: MY_WALLET,
    createdAt: now - 33 * DAY,
    allocations: [alloc('jitosol', 5000, 30), alloc('msol', 4500, -30)],
    fees: { mintBps: 20, redeemBps: 20, tvlBps: 40 },
    supply: 64_900,
    navUsd: 318_000,
    holders: 97,
    verified: false,
    indexed: true,
    riskLabels: [],
    delegates: [],
    status: 'active',
    lastRebalanceTs: null,
    volPct: 1.0,
    driftPct: 0.13,
    marketBiasPct: null,
  }),
]

/** Mock portfolio holdings for the connected wallet. */
export interface Holding {
  reserveAddress: string
  tokens: number
  costBasisUsd: number
}

export const SEED_HOLDINGS: Holding[] = [
  { reserveAddress: 'Rsv1SoLBLuechipXk29fJdTq8mWnAe4gYhU6oPzC3vNb', tokens: 4200, costBasisUsd: 13_950 },
  { reserveAddress: 'Rsv2StakedSoLyLdWq83nRtY5mKe1cJb7uHgA9oPzX4v', tokens: 1150, costBasisUsd: 5_420 },
  { reserveAddress: 'Rsv4MemeIndexBw6t8yUjM3oPl9aSdFgH2jKzXcV5bNq', tokens: 9800, costBasisUsd: 5_130 },
  { reserveAddress: 'RsvEnigmaMacroKp3wQ8eRtY2uIoPaSd6FgHjKlZxCvB', tokens: 12_500, costBasisUsd: 41_800 },
]
