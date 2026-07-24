import { useEffect, useState } from 'react'
import { Modal } from './ui'
import { useAppStore } from '@/store/useAppStore'
import type { WalletProviderId } from '@/lib/types'
import { useStore } from '../state/store'

/** The four wallets offered in the picker. MetaMask is listed but never actually
 *  connects — it doesn't support Solana — so selecting it always surfaces the
 *  "not installed" or "connection failed" state, which keeps both failure paths
 *  reachable deterministically instead of relying on randomness. */
type ModalWalletId = WalletProviderId | 'metamask'

interface WalletOption {
  id: ModalWalletId
  name: string
  color: string
  initial: string
  installUrl: string
  isInstalled: () => boolean
}

function hasGlobal(key: string): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>)[key])
}

const WALLET_OPTIONS: WalletOption[] = [
  {
    id: 'phantom',
    name: 'Phantom',
    color: '#AB9FF2',
    initial: 'P',
    installUrl: 'https://phantom.app/',
    isInstalled: () => Boolean((window as unknown as { phantom?: { solana?: unknown } }).phantom?.solana),
  },
  {
    id: 'solflare',
    name: 'Solflare',
    color: '#FC9231',
    initial: 'S',
    installUrl: 'https://solflare.com/',
    isInstalled: () => hasGlobal('solflare'),
  },
  {
    id: 'backpack',
    name: 'Backpack',
    color: '#E33E3F',
    initial: 'B',
    installUrl: 'https://backpack.app/',
    isInstalled: () => hasGlobal('backpack'),
  },
  {
    id: 'metamask',
    name: 'MetaMask',
    color: '#E2761B',
    initial: 'M',
    installUrl: 'https://metamask.io/',
    isInstalled: () => hasGlobal('ethereum'),
  },
]

type Step =
  | { kind: 'select' }
  | { kind: 'connecting'; wallet: WalletOption }
  | { kind: 'connected'; wallet: WalletOption }
  | { kind: 'not-installed'; wallet: WalletOption }
  | { kind: 'failed'; wallet: WalletOption; reason: string }

export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectWallet = useAppStore(s => s.connectWallet)
  const { toast } = useStore()
  const [step, setStep] = useState<Step>({ kind: 'select' })

  useEffect(() => {
    if (open) setStep({ kind: 'select' })
  }, [open])

  async function selectWallet(opt: WalletOption) {
    if (opt.id === 'metamask') {
      if (!opt.isInstalled()) {
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
    if (!opt.isInstalled()) {
      setStep({ kind: 'not-installed', wallet: opt })
      return
    }
    setStep({ kind: 'connecting', wallet: opt })
    try {
      await connectWallet(opt.id as WalletProviderId)
      setStep({ kind: 'connected', wallet: opt })
      toast('Wallet connected (simulated)', 'No real wallet is involved — this is a prototype.')
    } catch {
      setStep({ kind: 'failed', wallet: opt, reason: 'Connection failed. Please try again.' })
    }
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
            Choose a wallet to continue. Simulation Mode — no real wallet, network, or on-chain program is
            connected.
          </p>
          <div className="wm-list">
            {WALLET_OPTIONS.map(opt => (
              <button key={opt.id} type="button" className="wm-option" onClick={() => selectWallet(opt)}>
                <span className="ticon" style={{ width: 34, height: 34, background: opt.color, fontSize: 14 }} aria-hidden="true">
                  {opt.initial}
                </span>
                <span className="wm-option-name">{opt.name}</span>
                <span className="wm-option-hint">{opt.isInstalled() ? 'Detected' : 'Not installed'}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step.kind === 'connecting' && (
        <div className="wm-status">
          <span className="ticon wm-spinner" style={{ width: 44, height: 44, background: step.wallet.color, fontSize: 17 }} aria-hidden="true">
            {step.wallet.initial}
          </span>
          <p className="wm-status-text">Connecting to {step.wallet.name}…</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep({ kind: 'select' })}>
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
          <p className="wm-status-text">{step.wallet.name} connected (simulated).</p>
          <p className="wm-sub" style={{ textAlign: 'center' }}>
            No real wallet is involved — balances and activity in this app are entirely mocked.
          </p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {step.kind === 'not-installed' && (
        <div className="wm-status">
          <span className="ticon" style={{ width: 44, height: 44, background: step.wallet.color, fontSize: 17, opacity: 0.5 }} aria-hidden="true">
            {step.wallet.initial}
          </span>
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
