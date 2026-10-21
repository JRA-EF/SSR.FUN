// Header control for the Robinhood Chain wallet, beside the Solana one.
//
// Imports nothing from viem: the EVM stack is dynamic-imported on click, so
// the main bundle is unaffected.
import { useState } from 'react'
import { Modal } from './ui'
import {
  askEvmWalletChoice,
  connectEvmWallet,
  disconnectEvmWallet,
  discoverEvmProviders,
  dismissEvmWalletPicker,
  pickEvmWallet,
  useEvmWallet,
  type EvmProviderChoice,
} from '@/components/robinhood/useEvmWallet'

export function EvmWalletChip() {
  const { account, connecting, choices } = useEvmWallet()
  const [error, setError] = useState<string | null>(null)

  async function run(choice?: EvmProviderChoice) {
    setError(null)
    try {
      await connectEvmWallet(choice)
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string; code?: number }
      // 4001 is the user dismissing the wallet prompt: not an error worth shouting about.
      setError(err?.code === 4001 ? null : (err?.shortMessage ?? err?.message ?? 'Could not connect.'))
    }
  }

  // With more than one injected wallet installed, ASK instead of guessing --
  // window.ethereum is whichever extension won the race, which made connecting
  // hit the wrong wallet and take several attempts. The header always asks
  // (so the person can switch wallets); in-page connect buttons reuse the last
  // pick and open this same picker only when there is none.
  async function onClick() {
    setError(null)
    const found = await discoverEvmProviders()
    if (found.length === 0) {
      setError('No EVM wallet found. Install MetaMask, Phantom or another wallet.')
      return
    }
    if (found.length === 1) return run(found[0])
    try {
      await run(await askEvmWalletChoice(found))
    } catch {
      // Picker closed: nothing to connect.
    }
  }

  // Rendered whatever the connection state, since an in-page connect button
  // can open it.
  const picker = (
    <Modal open={!!choices} onClose={dismissEvmWalletPicker} labelledBy="evm-wallet-picker-title">
      <div className="wm-head">
        <h3 id="evm-wallet-picker-title">Choose a wallet</h3>
        <button type="button" className="wm-close" aria-label="Close" onClick={dismissEvmWalletPicker}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <p className="wm-sub">Several wallets are installed in this browser. Pick the one to connect on Robinhood Chain.</p>
      <div className="wm-list">
        {choices?.map(c => (
          <button key={c.uuid} type="button" className="wm-option" onClick={() => pickEvmWallet(c)}>
            <span className="ticon" style={{ width: 34, height: 34, overflow: 'hidden' }} aria-hidden="true">
              {c.icon && <img src={c.icon} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </span>
            <span className="wm-option-name">{c.name}</span>
          </button>
        ))}
      </div>
    </Modal>
  )

  if (account) {
    return (
      <>
        <button
          type="button"
          className="wallet-chip"
          title={`Connected on Robinhood Chain — ${account}. Click to disconnect.`}
          onClick={disconnectEvmWallet}
        >
          <span className="dot" aria-hidden="true" style={{ background: 'var(--s4)' }} />
          RH {account.slice(0, 4)}…{account.slice(-4)}
        </button>
        {picker}
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        className="wallet-chip"
        title={error ?? 'Connect an EVM wallet for Robinhood Chain reserves'}
        onClick={onClick}
        disabled={connecting}
        style={error ? { borderColor: 'var(--down)' } : undefined}
      >
        <span className="dot" aria-hidden="true" style={{ background: error ? 'var(--down)' : 'var(--text-3)' }} />
        {connecting ? 'Connecting…' : 'Robinhood'}
      </button>
      {picker}
    </>
  )
}
