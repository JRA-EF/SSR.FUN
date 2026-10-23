import { useEffect, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base'
import { Modal } from './ui'
import { useAppStore } from '@/store/useAppStore'
import type { WalletProviderId } from '@/lib/types'
import { useStore } from '../state/store'
import { IS_MAINNET } from '@/lib/solana-config'
import { DEMO_WALLET_ADDRESS, isDesignDemoEnabled, setDemoWalletConnected } from '@/lib/designDemo'
import { METAMASK_ENABLED } from '@/lib/metamaskFeature'

const CLUSTER_LABEL = IS_MAINNET ? 'Mainnet' : 'DevNet'

/** The four wallets offered in the picker. All four are matched against
 *  wallet-adapter-react's live Wallet Standard detection by name
 *  (case-insensitive substring) rather than raw `window.phantom`-style global
 *  checks, which is more reliable across wallet versions. MetaMask included:
 *  its extension registers a Solana wallet named "MetaMask" through the Wallet
 *  Standard, so `window.ethereum` (its EVM side) says nothing about Solana. */
interface WalletOption {
  id: WalletProviderId
  name: string
  /** Tile background behind the logo. */
  color: string
  /** Official logo file in public/wallets (sources listed below). */
  logo: string
  /** 'bleed': the file is the full square app icon (its own background) and fills the tile; 'mark': a bare mark centred on `color`. */
  logoFit: 'bleed' | 'mark'
  installUrl: string
}

/** Where each logo file came from -- the company's own brand assets, never a
 *  redraw. Re-download from these if a brand changes; do not edit the files.
 *  - Phantom: Phantom_SVG_Icon.svg, docs.phantom.com/resources/assets
 *  - Solflare: Solflare_INSIGNIA_Obsidian_Noir_BACKGROUND_Yellow.svg, solflare.com/solflare-brand-kit.zip
 *  - Backpack: Backpack-Icon.svg, Backpack Media Kit linked from backpack.app/media-kit (their store icon is this red mark on white)
 *  - MetaMask: MetaMask-icon-fox.svg, metamask.io/assets */

// Alphabetical order. MetaMask only when METAMASK_ENABLED (off on production).
const ALL_WALLET_OPTIONS: WalletOption[] = [
  { id: 'backpack', name: 'Backpack', color: '#FFFFFF', logo: '/wallets/backpack.svg', logoFit: 'mark', installUrl: 'https://backpack.app/' },
  { id: 'metamask', name: 'MetaMask', color: '#FFFFFF', logo: '/wallets/metamask.svg', logoFit: 'mark', installUrl: 'https://metamask.io/' },
  { id: 'phantom', name: 'Phantom', color: '#AB9FF2', logo: '/wallets/phantom.svg', logoFit: 'bleed', installUrl: 'https://phantom.app/' },
  { id: 'solflare', name: 'Solflare', color: '#FFEF46', logo: '/wallets/solflare.svg', logoFit: 'bleed', installUrl: 'https://solflare.com/' },
]
const WALLET_OPTIONS = ALL_WALLET_OPTIONS.filter(opt => METAMASK_ENABLED || opt.id !== 'metamask')

/** Wallet tile: the company's official logo, the same whether or not the
 *  extension is installed. */
function WalletTile({
  wallet,
  size,
  className,
  dimmed,
}: {
  wallet: WalletOption
  size: number
  className?: string
  dimmed?: boolean
}) {
  const bleed = wallet.logoFit === 'bleed'
  return (
    <span
      className={className ? `ticon ${className}` : 'ticon'}
      style={{ width: size, height: size, background: wallet.color, opacity: dimmed ? 0.5 : undefined, boxShadow: bleed ? undefined : 'inset 0 0 0 1px rgba(0, 0, 0, 0.08)' }}
      aria-hidden="true"
    >
      <img
        src={wallet.logo}
        alt=""
        draggable={false}
        style={bleed ? { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' } : { width: '58%', height: '58%', objectFit: 'contain' }}
      />
    </span>
  )
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

  function isDetected(opt: WalletOption): boolean {
    // Design preview (never on Mainnet): every Solana wallet reads as
    // available, since choosing one performs a simulated connection instead
    // of reaching an extension.
    if (!IS_MAINNET && isDesignDemoEnabled()) return true
    const found = findAdapter(opt.id)
    return found?.readyState === WalletReadyState.Installed || found?.readyState === WalletReadyState.Loadable
  }

  async function selectWallet(opt: WalletOption) {
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
                <WalletTile wallet={opt} size={34} />
                <span className="wm-option-name">{opt.name}</span>
                <span className="wm-option-hint">{isDetected(opt) ? 'Detected' : 'Not installed'}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step.kind === 'connecting' && (
        <div className="wm-status">
          <WalletTile wallet={step.wallet} size={44} className="wm-spinner" />
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
          <WalletTile wallet={step.wallet} size={44} dimmed />
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
