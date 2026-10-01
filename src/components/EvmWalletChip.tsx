// Header control for the Robinhood Chain wallet, beside the Solana one.
//
// Imports nothing from viem: the EVM stack is dynamic-imported on click, so
// the main bundle is unaffected.
import { useEffect, useRef, useState } from 'react'
import { connectEvmWallet, disconnectEvmWallet, discoverEvmProviders, useEvmWallet, type EvmProviderChoice } from '@/components/robinhood/useEvmWallet'

export function EvmWalletChip() {
  const { account, connecting } = useEvmWallet()
  const [error, setError] = useState<string | null>(null)
  // With more than one injected wallet installed, ASK instead of guessing --
  // window.ethereum is whichever extension won the race, which made connecting
  // hit the wrong wallet and take several attempts.
  const [choices, setChoices] = useState<EvmProviderChoice[] | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!choices) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setChoices(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [choices])

  async function run(choice?: EvmProviderChoice) {
    setError(null)
    setChoices(null)
    try {
      await connectEvmWallet(choice)
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string; code?: number }
      // 4001 is the user dismissing the wallet prompt: not an error worth shouting about.
      setError(err?.code === 4001 ? null : (err?.shortMessage ?? err?.message ?? 'Could not connect.'))
    }
  }

  async function onClick() {
    setError(null)
    const found = await discoverEvmProviders()
    if (found.length === 0) {
      setError('No EVM wallet found. Install MetaMask, Phantom or another wallet.')
      return
    }
    if (found.length === 1) return run(found[0])
    setChoices(found)
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
    <div className="wallet-panel-wrap" ref={wrapRef}>
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

      {choices && (
        <div className="wallet-panel" role="menu" style={{ width: 220, padding: 8 }}>
          <p style={{ fontSize: 11, color: 'var(--text-3)', padding: '4px 8px 8px' }}>Choose a wallet</p>
          {choices.map(c => (
            <button
              key={c.uuid}
              type="button"
              role="menuitem"
              onClick={() => run(c)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '8px 10px', borderRadius: 8, background: 'transparent',
                color: 'var(--text)', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {c.icon && <img src={c.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} />}
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
