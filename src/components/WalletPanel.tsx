import { useEffect, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { DEVUSDC, DEVUSDC_MINT, fetchTokenBalanceRaw } from '@ssr/sdk'
import { useAppStore } from '@/store/useAppStore'
import {
  getCached,
  isRateLimitError,
  tokenBalanceCacheKey,
  withReadConcurrencyLimit,
  BALANCE_CACHE_TTL_MS,
} from '@/lib/rpcResilience'
import { Addr } from './ui'

type BalanceStatus = 'loading' | 'ready' | 'unavailable' | 'rate-limited'

/** Wallet dropdown shown when the connected wallet chip is clicked -- replaces the old
 *  click-to-disconnect behavior. Every balance is a genuine on-chain read (or already-synced
 *  store state); a failed read shows "Unavailable"/"Rate-limited", never a fabricated zero. */
export function WalletPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connection } = useConnection()
  const { publicKey, disconnect } = useWallet()
  const wallet = useAppStore(s => s.wallet)
  const holdings = useAppStore(s => s.holdings)
  const dtrs = useAppStore(s => s.dtrs)
  const panelRef = useRef<HTMLDivElement>(null)

  const [devUsdcStatus, setDevUsdcStatus] = useState<BalanceStatus>('loading')
  const [devUsdcRaw, setDevUsdcRaw] = useState<bigint | null>(null)

  useEffect(() => {
    if (!open || !publicKey) return
    let cancelled = false
    setDevUsdcStatus('loading')
    const owner = publicKey
    getCached(tokenBalanceCacheKey(connection.rpcEndpoint, DEVUSDC_MINT.toBase58(), owner.toBase58()), BALANCE_CACHE_TTL_MS, () =>
      withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, DEVUSDC_MINT, owner)),
    )
      .then(raw => {
        if (cancelled) return
        setDevUsdcRaw(BigInt(raw))
        setDevUsdcStatus('ready')
      })
      .catch(e => {
        if (cancelled) return
        setDevUsdcStatus(isRateLimitError(e) ? 'rate-limited' : 'unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [open, publicKey, connection])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function onPointerDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [open, onClose])

  if (!open) return null

  const reserveHoldings = holdings
    .filter(h => h.tokenBalance > 0)
    .map(h => ({ holding: h, dtr: dtrs.find(d => d.id === h.dtrId) }))
    .filter((row): row is { holding: typeof row.holding; dtr: NonNullable<typeof row.dtr> } => Boolean(row.dtr?.onChain))

  const devUsdcHuman =
    devUsdcStatus === 'ready' && devUsdcRaw !== null
      ? (Number(devUsdcRaw) / 10 ** DEVUSDC.decimals).toLocaleString(undefined, { maximumFractionDigits: 2 })
      : null

  return (
    <div ref={panelRef} className="wallet-panel" aria-label="Wallet details">
      <div className="wallet-panel-head">
        <span className="sim-badge" title="Connected to the SSR Protocol on Solana DevNet — a public test network, not Mainnet. No real economic value.">
          Solana DevNet
        </span>
      </div>

      {wallet.address && (
        <div className="wallet-panel-row">
          <Addr value={wallet.address} label="Address" />
        </div>
      )}

      <div className="wallet-panel-balances">
        <div className="wallet-panel-row">
          <span className="k">SOL</span>
          <span className="v">{wallet.sol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
        </div>
        <div className="wallet-panel-row">
          <span className="k">devUSDC</span>
          <span className="v">
            {devUsdcStatus === 'loading' && 'Loading…'}
            {devUsdcStatus === 'unavailable' && <span className="faint">Unavailable</span>}
            {devUsdcStatus === 'rate-limited' && <span className="faint">Rate-limited</span>}
            {devUsdcStatus === 'ready' && devUsdcHuman}
          </span>
        </div>
        {reserveHoldings.map(({ holding, dtr }) => (
          <div className="wallet-panel-row" key={holding.dtrId}>
            <span className="k">{dtr.ticker}</span>
            <span className="v">{holding.tokenBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="btn btn-ghost btn-sm wallet-panel-disconnect"
        onClick={() => {
          disconnect()
          onClose()
        }}
      >
        Disconnect
      </button>
    </div>
  )
}
