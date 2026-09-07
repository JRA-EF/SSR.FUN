import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base'
import { Modal } from './ui'
import { useAppStore } from '@/store/useAppStore'
import type { WalletProviderId } from '@/lib/types'
import { useStore } from '../state/store'
import { IS_MAINNET } from '@/lib/solana-config'
import { DEMO_WALLET_ADDRESS, isDesignDemoEnabled, setDemoWalletConnected } from '@/lib/designDemo'

const CLUSTER_LABEL = IS_MAINNET ? 'Mainnet' : 'DevNet'

/** The four wallets offered in the picker. MetaMask is listed but never actually
 *  connects — it doesn't support Solana — so selecting it always surfaces the
 *  "not installed" or "connection failed" state, which keeps both failure paths
 *  reachable deterministically instead of relying on randomness. The other
 *  three are matched against wallet-adapter-react's live Wallet Standard
 *  detection by name (case-insensitive substring) rather than raw
 *  `window.phantom`-style global checks, which is more reliable across wallet
 *  versions. */
type ModalWalletId = WalletProviderId | 'metamask'

interface WalletOption {
  id: ModalWalletId
  name: string
  color: string
  glyph: ReactNode
  installUrl: string
}

/** Simplified brand marks, used when the wallet extension isn't installed so no
 *  official icon is available from the Wallet Standard adapter. Detected
 *  wallets render their real `adapter.icon` instead (see WalletTile). */
const GLYPHS: Record<ModalWalletId, ReactNode> = {
  backpack: (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M9 4.2a3.1 3.1 0 0 1 6 0c2.9.8 5 3.4 5 6.4V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8.4c0-3 2.1-5.6 5-6.4Zm1.7-.3h2.6a1.35 1.35 0 0 0-2.6 0ZM12 10a3.2 3.2 0 1 0 0 6.4A3.2 3.2 0 0 0 12 10Z" />
    </svg>
  ),
  metamask: (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="currentColor" aria-hidden="true">
      <path d="M3.5 2.8 10 7.5h4l6.5-4.7-2 6.1 1.9 3.6-1.7 5L12 21.2l-6.7-3.7-1.7-5 1.9-3.6-2-6.1Zm5.6 10.1a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm5.8 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z" />
    </svg>
  ),
  phantom: (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="currentColor" aria-hidden="true">
      <path d="M12 3.5c-4.42 0-8 3.58-8 8v7.1c0 .66.74 1.05 1.29.68l1.71-1.16 1.86 1.26c.34.23.79.23 1.13 0L12 18.16l2.01 1.22c.34.23.79.23 1.13 0l1.86-1.26 1.71 1.16c.55.37 1.29-.02 1.29-.68v-7.1c0-4.42-3.58-8-8-8Zm-2.75 8.9a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm5.5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
    </svg>
  ),
  solflare: (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="currentColor" aria-hidden="true">
      <path d="M12 2.25c.52 3.1 1.9 5.23 4.02 6.98 2.18 1.8 3.73 3.77 3.73 6.17 0 3.87-3.47 6.35-7.75 6.35s-7.75-2.48-7.75-6.35c0-2.4 1.55-4.37 3.73-6.17C10.1 7.48 11.48 5.35 12 2.25Zm0 10.15c-1.9 1.05-2.9 2.2-2.9 3.55 0 1.6 1.3 2.7 2.9 2.7s2.9-1.1 2.9-2.7c0-1.35-1-2.5-2.9-3.55Z" />
    </svg>
  ),
}

// Alphabetical order.
const WALLET_OPTIONS: WalletOption[] = [
  { id: 'backpack', name: 'Backpack', color: '#E33E3F', glyph: GLYPHS.backpack, installUrl: 'https://backpack.app/' },
  { id: 'metamask', name: 'MetaMask', color: '#E2761B', glyph: GLYPHS.metamask, installUrl: 'https://metamask.io/' },
  { id: 'phantom', name: 'Phantom', color: '#AB9FF2', glyph: GLYPHS.phantom, installUrl: 'https://phantom.app/' },
  { id: 'solflare', name: 'Solflare', color: '#FC9231', glyph: GLYPHS.solflare, installUrl: 'https://solflare.com/' },
]

/** Colored wallet tile: shows the official adapter icon when the wallet is
 *  detected, falling back to the simplified brand glyph. */
function WalletTile({
  wallet,
  iconUrl,
  size,
  className,
  dimmed,
}: {
  wallet: WalletOption
  iconUrl?: string
  size: number
  className?: string
  dimmed?: boolean
}) {
  return (
    <span
      className={className ? `ticon ${className}` : 'ticon'}
      style={{ width: size, height: size, background: wallet.color, opacity: dimmed ? 0.5 : undefined }}
      aria-hidden="true"
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" style={{ width: '62%', height: '62%', objectFit: 'contain', borderRadius: 4 }} />
      ) : (
        wallet.glyph
      )}
    </span>
  )
}

function hasGlobal(key: string): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>)[key])
}

type Step =
  | { kind: 'select' }
  | { kind: 'connecting'; wallet: WalletOption }
  | { kind: 'connected'; wallet: WalletOption }
  | { kind: 'not-installed'; wallet: WalletOption }
  | { kind: 'failed'; wallet: WalletOption; reason: string }

export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallets, select, connected, publicKey } = useWallet()
  const walletError = useAppStore(s => s.walletError)
  const setWalletError = useAppStore(s => s.setWalletError)
  const { toast } = useStore()
  const [step, setStep] = useState<Step>({ kind: 'select' })
  const pendingRef = useRef<WalletOption | null>(null)

  useEffect(() => {
    if (open) {
      setStep({ kind: 'select' })
      pendingRef.current = null
    }
  }, [open])

  // The real adapter resolved a pending selection -- either connected...
  useEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    if (connected && publicKey) {
      setStep({ kind: 'connected', wallet: pending })
      pendingRef.current = null
      toast('Wallet connected', `Connected to ${pending.name} on Solana ${CLUSTER_LABEL}.`)
    }
  }, [connected, publicKey, toast])

  // ...or failed (user rejected in the extension, etc.), surfaced via SolanaProviders' onError.
  useEffect(() => {
    const pending = pendingRef.current
    if (!pending || !walletError) return
    setStep({ kind: 'failed', wallet: pending, reason: walletError })
    pendingRef.current = null
    setWalletError(null)
  }, [walletError, setWalletError])

  function findAdapter(id: WalletProviderId) {
    return wallets.find(w => w.adapter.name.toLowerCase().includes(id))
  }

  function iconFor(opt: WalletOption): string | undefined {
    if (opt.id === 'metamask') return undefined
    return findAdapter(opt.id)?.adapter.icon
  }

  function isDetected(opt: WalletOption): boolean {
    if (opt.id === 'metamask') return hasGlobal('ethereum')
    // Design preview (never on Mainnet): every Solana wallet reads as
    // available, since choosing one performs a simulated connection instead
    // of reaching an extension.
    if (!IS_MAINNET && isDesignDemoEnabled()) return true
    const found = findAdapter(opt.id)
    return found?.readyState === WalletReadyState.Installed || found?.readyState === WalletReadyState.Loadable
  }

  async function selectWallet(opt: WalletOption) {
    if (opt.id === 'metamask') {
      if (!hasGlobal('ethereum')) {
        setStep({ kind: 'not-installed', wallet: opt })
        return
      }
      setStep({
        kind: 'failed',
        wallet: opt,
        reason: "MetaMask doesn't support Solana yet. Choose a Solana wallet like Phantom, Solflare, or Backpack instead.",
      })
      return
    }

    // Design preview: simulate the whole connect flow in the store. The real
    // wallet adapter never engages (no extension popup, no keys), so this is
    // safe even when a real Phantom/Solflare is installed in the browser.
    // Never on Mainnet: production users must only ever see real connection
    // state, so the ?demo=1 flag is ignored there.
    if (!IS_MAINNET && isDesignDemoEnabled()) {
      setStep({ kind: 'connecting', wallet: opt })
      pendingRef.current = opt
      window.setTimeout(() => {
        if (pendingRef.current !== opt) return
        pendingRef.current = null
        setDemoWalletConnected(true, opt.id)
        useAppStore.getState().syncWalletFromChain({
          connected: true,
          connecting: false,
          address: DEMO_WALLET_ADDRESS,
          provider: opt.id as WalletProviderId,
          solLamports: 5_000_000_000,
        })
        setStep({ kind: 'connected', wallet: opt })
        toast('Wallet connected', `Simulated ${opt.name} connection — design preview, no real wallet involved.`)
      }, 900)
      return
    }

    const found = findAdapter(opt.id)
    if (!found || !isDetected(opt)) {
      setStep({ kind: 'not-installed', wallet: opt })
      return
    }

    setStep({ kind: 'connecting', wallet: opt })
    pendingRef.current = opt
    // select() triggers wallet-adapter-react's own auto-connect effect (the
    // provider is mounted with autoConnect); resolution/failure is observed
    // above via the connected/publicKey and walletError effects.
    select(found.adapter.name as WalletName)
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="wallet-modal-title">
      <div className="wm-head">
        <h3 id="wallet-modal-title">
          {step.kind === 'select' && 'Connect a wallet'}
          {step.kind === 'connecting' && 'Connecting…'}
          {step.kind === 'connected' && 'Wallet connected'}
          {step.kind === 'not-installed' && 'Wallet not installed'}
          {step.kind === 'failed' && 'Connection failed'}
        </h3>
        <button type="button" className="wm-close" aria-label="Close" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {step.kind === 'select' && (
        <>
          <p className="wm-sub">
            {IS_MAINNET ? 'Choose a wallet to continue. Connects on Solana Mainnet — real funds.' : 'Choose a wallet to continue. Testing Environment — connects on Solana DevNet, not Mainnet.'}
          </p>
          <div className="wm-list">
            {WALLET_OPTIONS.map(opt => (
              <button key={opt.id} type="button" className="wm-option" onClick={() => selectWallet(opt)}>
                <WalletTile wallet={opt} iconUrl={iconFor(opt)} size={34} />
                <span className="wm-option-name">{opt.name}</span>
                <span className="wm-option-hint">{isDetected(opt) ? 'Detected' : 'Not installed'}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step.kind === 'connecting' && (
        <div className="wm-status">
          <WalletTile wallet={step.wallet} iconUrl={iconFor(step.wallet)} size={44} className="wm-spinner" />
          <p className="wm-status-text">Connecting to {step.wallet.name}…</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              pendingRef.current = null
              setStep({ kind: 'select' })
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {step.kind === 'connected' && (
        <div className="wm-status">
          <span className="wm-icon wm-icon-success" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <p className="wm-status-text">{step.wallet.name} connected.</p>
          <p className="wm-sub" style={{ textAlign: 'center' }}>
            {IS_MAINNET ? 'Connected on Solana Mainnet — real funds, real economic value.' : 'Connected on Solana DevNet — a test network with no real economic value.'}
          </p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {step.kind === 'not-installed' && (
        <div className="wm-status">
          <WalletTile wallet={step.wallet} iconUrl={iconFor(step.wallet)} size={44} dimmed />
          <p className="wm-status-text">{step.wallet.name} isn't installed in this browser.</p>
          <p className="wm-sub" style={{ textAlign: 'center' }}>
            Install the extension to connect it, or choose a different wallet.
          </p>
          <div className="wm-actions">
            <a href={step.wallet.installUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Get {step.wallet.name}
            </a>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setStep({ kind: 'select' })}>
              Choose another wallet
            </button>
          </div>
        </div>
      )}

      {step.kind === 'failed' && (
        <div className="wm-status">
          <span className="wm-icon wm-icon-fail" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </span>
          <p className="wm-status-text">Couldn't connect {step.wallet.name}.</p>
          <p className="wm-sub" style={{ textAlign: 'center' }}>{step.reason}</p>
          <div className="wm-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setStep({ kind: 'select' })}>
              Try again
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
