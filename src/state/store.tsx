import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react'
import type { ActivityEvent, Allocation, Delegate, FeeConfig, Reserve } from '../domain/types'
import { navPerToken } from '../domain/types'
import { MY_WALLET, SEED_HOLDINGS, SEED_RESERVES, type Holding } from '../data/reserves'
import { applyFeeMicro, ssrFeeBps } from '../lib/fees'

export interface Toast {
  id: number
  title: string
  body?: string
}

interface State {
  connected: boolean
  reserves: Reserve[]
  holdings: Holding[]
  toasts: Toast[]
}

type Action =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'mint'; address: string; usdIn: number }
  | { type: 'redeem'; address: string; tokens: number }
  | { type: 'create-reserve'; reserve: Reserve; seedUsd: number }
  | { type: 'update-fees'; address: string; fees: FeeConfig }
  | { type: 'rebalance'; address: string; allocations: Allocation[] }
  | { type: 'set-delegates'; address: string; delegates: Delegate[] }
  | { type: 'wind-down'; address: string }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismiss-toast'; id: number }

let toastId = 1

function evt(kind: ActivityEvent['kind'], wallet: string, extra: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, ts: Date.now(), wallet, ...extra }
}

function updateReserve(rs: Reserve[], address: string, fn: (r: Reserve) => Reserve): Reserve[] {
  return rs.map(r => (r.address === address ? fn(r) : r))
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connect':
      return { ...state, connected: true }
    case 'disconnect':
      return { ...state, connected: false }

    case 'mint': {
      const r = state.reserves.find(x => x.address === action.address)
      if (!r) return state
      const nav = navPerToken(r)
      if (nav <= 0) return state
      const usdMicro = Math.round(action.usdIn * 1_000_000)
      const [mgrFee] = applyFeeMicro(usdMicro, r.fees.mintBps)
      const [platformFee] = applyFeeMicro(usdMicro, ssrFeeBps(r.fees.mintBps))
      const netUsd = (usdMicro - mgrFee - platformFee) / 1_000_000
      const tokensOut = netUsd / nav
      const reserves = updateReserve(state.reserves, action.address, x => ({
        ...x,
        supply: x.supply + tokensOut,
        navUsd: x.navUsd + netUsd,
        holders: x.holders + (state.holdings.some(h => h.reserveAddress === action.address) ? 0 : 1),
        activity: [evt('mint', MY_WALLET, { amountUsd: action.usdIn, tokens: tokensOut }), ...x.activity],
      }))
      const existing = state.holdings.find(h => h.reserveAddress === action.address)
      const holdings = existing
        ? state.holdings.map(h =>
            h.reserveAddress === action.address ? { ...h, tokens: h.tokens + tokensOut, costBasisUsd: h.costBasisUsd + action.usdIn } : h,
          )
        : [...state.holdings, { reserveAddress: action.address, tokens: tokensOut, costBasisUsd: action.usdIn }]
      return { ...state, reserves, holdings }
    }

    case 'redeem': {
      const r = state.reserves.find(x => x.address === action.address)
      const h = state.holdings.find(x => x.reserveAddress === action.address)
      if (!r || !h) return state
      const tokens = Math.min(action.tokens, h.tokens)
      const nav = navPerToken(r)
      const grossUsd = tokens * nav
      const reserves = updateReserve(state.reserves, action.address, x => ({
        ...x,
        supply: Math.max(0, x.supply - tokens),
        navUsd: Math.max(0, x.navUsd - grossUsd),
        activity: [evt('redeem', MY_WALLET, { amountUsd: grossUsd, tokens }), ...x.activity],
      }))
      const remaining = h.tokens - tokens
      const holdings =
        remaining > 0.000001
          ? state.holdings.map(x =>
              x.reserveAddress === action.address
                ? { ...x, tokens: remaining, costBasisUsd: x.costBasisUsd * (remaining / h.tokens) }
                : x,
            )
          : state.holdings.filter(x => x.reserveAddress !== action.address)
      return { ...state, reserves, holdings }
    }

    case 'create-reserve': {
      const reserves = [action.reserve, ...state.reserves]
      const holdings = [
        ...state.holdings,
        { reserveAddress: action.reserve.address, tokens: action.reserve.supply, costBasisUsd: action.seedUsd },
      ]
      return { ...state, reserves, holdings }
    }

    case 'update-fees': {
      const reserves = updateReserve(state.reserves, action.address, x => ({
        ...x,
        fees: action.fees,
        activity: [evt('fee-update', MY_WALLET, { note: 'Manager fees updated' }), ...x.activity],
      }))
      return { ...state, reserves }
    }

    case 'rebalance': {
      const reserves = updateReserve(state.reserves, action.address, x => ({
        ...x,
        allocations: action.allocations.map(a => ({ ...a, currentBps: a.targetBps })),
        lastRebalanceTs: Date.now(),
        activity: [evt('rebalance', MY_WALLET, { note: 'Targets updated and rebalance executed' }), ...x.activity],
      }))
      return { ...state, reserves }
    }

    case 'set-delegates': {
      const reserves = updateReserve(state.reserves, action.address, x => ({
        ...x,
        delegates: action.delegates,
        activity: [evt('delegate', MY_WALLET, { note: 'Co-Manager permissions updated' }), ...x.activity],
      }))
      return { ...state, reserves }
    }

    case 'wind-down': {
      const reserves = updateReserve(state.reserves, action.address, x => ({
        ...x,
        status: 'winding-down' as const,
        activity: [evt('wind-down', MY_WALLET, { note: 'Complete wind-down initiated — 1 month standard claim window' }), ...x.activity],
      }))
      return { ...state, reserves }
    }

    case 'toast':
      return { ...state, toasts: [...state.toasts, action.toast] }
    case 'dismiss-toast':
      return { ...state, toasts: state.toasts.filter(t => t.id !== action.id) }
  }
}

interface StoreValue extends State {
  wallet: string
  dispatch: (a: Action) => void
  toast: (title: string, body?: string) => void
  reserveByAddress: (address: string) => Reserve | undefined
  holdingFor: (address: string) => Holding | undefined
  managedReserves: Reserve[]
}

const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    connected: false,
    reserves: SEED_RESERVES,
    holdings: SEED_HOLDINGS,
    toasts: [],
  })

  const value = useMemo<StoreValue>(
    () => ({
      ...state,
      wallet: MY_WALLET,
      dispatch,
      toast: (title, body) => {
        const id = toastId++
        dispatch({ type: 'toast', toast: { id, title, body } })
        window.setTimeout(() => dispatch({ type: 'dismiss-toast', id }), 5200)
      },
      reserveByAddress: address => state.reserves.find(r => r.address === address),
      holdingFor: address => state.holdings.find(h => h.reserveAddress === address),
      managedReserves: state.reserves.filter(r => r.manager === MY_WALLET),
    }),
    [state],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext)
  if (!v) throw new Error('useStore outside StoreProvider')
  return v
}
