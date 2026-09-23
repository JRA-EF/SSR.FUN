// Header control for the Robinhood Chain wallet, sitting beside the Solana
// one. Both chains are first-class, so both are connectable from the shell --
// without it, the only way in was a button buried on a reserve page.
//
// Imports nothing from viem: the EVM stack is dynamic-imported by
// connectEvmWallet() on click, so the main bundle is unaffected.
import { useState } from 'react'
import { connectEvmWallet, disconnectEvmWallet, useEvmWallet } from '@/components/robinhood/useEvmWallet'

export function EvmWalletChip() {
  const { account, connecting } = useEvmWallet()
  const [error, setError] = useState<string | null>(null)

  async function onConnect() {
    setError(null)
    try {
      await connectEvmWallet()
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string }
      setError(err?.shortMessage ?? err?.message ?? 'Could not connect.')
    }
  }

  if (account) {
    return (
      <button
        type="button"
        className="wallet-chip"
        title={`Connected on Robinhood Chain — ${account}. Click to disconnect.`}
        onClick={disconnectEvmWallet}
      >
        <span className="dot" aria-hidden="true" style={{ background: 'var(--s4)' }} />
        RH {account.slice(0, 4)}…{account.slice(-4)}
      </button>
    )
  }

  return (
    <button
      type="button"
      className="wallet-chip"
      title={error ?? 'Connect an EVM wallet for Robinhood Chain reserves'}
      onClick={onConnect}
      disabled={connecting}
      style={error ? { borderColor: 'var(--down)' } : undefined}
    >
      <span className="dot" aria-hidden="true" style={{ background: error ? 'var(--down)' : 'var(--text-3)' }} />
      {connecting ? 'Connecting…' : 'Robinhood'}
    </button>
  )
}
