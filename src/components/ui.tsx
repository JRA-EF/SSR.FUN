import { useState, type ReactNode } from 'react'
import type { Reserve } from '../domain/types'
import { assetById } from '../data/assets'
import { shortAddr } from '../lib/format'

/* ------------------------------ token icon ------------------------------ */

const ICON_COLORS: Record<string, string> = {
  usdc: '#2775ca',
  usdt: '#26a17b',
  pyusd: '#0070e0',
  sol: '#6e56cf',
  msol: '#308d8a',
  jitosol: '#187e63',
  bsol: '#c25d3e',
  jup: '#3b6ea5',
  jto: '#7a5af8',
  pyth: '#53389e',
  ray: '#2f6fce',
  orca: '#b8860b',
  drift: '#8f4fd1',
  kmno: '#b34a72',
  bonk: '#c96a2b',
  wif: '#a08050',
  popcat: '#7d7d3a',
  mew: '#3a7d64',
  rndr: '#b03a3a',
  hnt: '#3a5bb0',
  io: '#5747b8',
  grass: '#3f8f3f',
  tbill: '#4a6f5d',
  newcoin: '#8a6d3b',
}

export function TokenIcon({ assetId, size = 26 }: { assetId: string; size?: number }) {
  const a = assetById(assetId)
  const bg = ICON_COLORS[assetId] ?? '#5a5470'
  return (
    <span
      className="ticon"
      style={{ width: size, height: size, background: bg, fontSize: Math.max(9, size * 0.38) }}
      aria-hidden="true"
    >
      {a.symbol.slice(0, 1)}
    </span>
  )
}

export function TokenStack({ assetIds, size = 22, max = 5 }: { assetIds: string[]; size?: number; max?: number }) {
  const shown = assetIds.slice(0, max)
  const rest = assetIds.length - shown.length
  return (
    <span className="ticon-stack">
      {shown.map(id => (
        <TokenIcon key={id} assetId={id} size={size} />
      ))}
      {rest > 0 && (
        <span className="ticon" style={{ width: size, height: size, background: 'var(--surface-3)', color: 'var(--text-2)', fontSize: 10 }}>
          +{rest}
        </span>
      )}
    </span>
  )
}

/* ------------------------------ badges ------------------------------ */

export function VerifiedBadge() {
  return (
    <span className="badge badge-verified" title="Listed as verified in the SSR.fun interface. Verification is an interface label, not an endorsement or audit.">
      ✓ verified
    </span>
  )
}

export function ReserveBadges({ r, compact = false }: { r: Reserve; compact?: boolean }) {
  return (
    <>
      {r.verified && <VerifiedBadge />}
      {r.status === 'winding-down' && <span className="badge badge-wind">winding down</span>}
      {!compact && r.riskLabels.map(l => (
        <span key={l} className="badge badge-risk">
          {l.toLowerCase()}
        </span>
      ))}
    </>
  )
}

/* ------------------------------ address ------------------------------ */

export function Addr({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="addr-line">
      {label && <span>{label}</span>}
      <span title={value}>{shortAddr(value)}</span>
      <button
        type="button"
        aria-label={`Copy address ${value}`}
        onClick={() => {
          navigator.clipboard?.writeText(value).catch(() => {})
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </button>
    </span>
  )
}

/* ------------------------------ modal ------------------------------ */

export function Modal({ open, onClose, children, labelledBy }: { open: boolean; onClose: () => void; children: ReactNode; labelledBy?: string }) {
  if (!open) return null
  return (
    <div
      className="modal-scrim"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  )
}

/* ------------------------------ toggle ------------------------------ */

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  )
}

/* ------------------------------ stat cell ------------------------------ */

export function Stat({ k, v, sub, subClass }: { k: string; v: ReactNode; sub?: ReactNode; subClass?: string }) {
  return (
    <div className="stat-cell">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub != null && <div className={`s ${subClass ?? 'faint'}`}>{sub}</div>}
    </div>
  )
}
