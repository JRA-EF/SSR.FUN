import { bpsPct, ssrFeeBps, MANAGER_FEE_MAX_BPS } from '../lib/fees'

export function FeeControl({
  label,
  bps,
  onChange,
  annualized,
}: {
  label: string
  bps: number
  onChange: (v: number) => void
  annualized?: boolean
}) {
  const ssr = ssrFeeBps(bps)
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <label htmlFor={`fee-${label}`} style={{ fontWeight: 600, fontSize: 14 }}>{label}</label>
        <span className="num" style={{ fontSize: 18 }}>{bpsPct(bps)}</span>
      </div>
      <input
        id={`fee-${label}`}
        type="range"
        className="slider"
        min={0}
        max={MANAGER_FEE_MAX_BPS}
        step={10}
        value={bps}
        onChange={e => onChange(Number(e.target.value))}
        aria-label={`${label} in percent`}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
        <span>0%</span>
        <span>50%</span>
      </div>
      <div className="fee-breakdown" style={{ marginTop: 12 }}>
        <div className="row">
          <span className="muted">Manager Fee</span>
          <span className="num">{bpsPct(bps)}</span>
        </div>
        <div className="row">
          <span className="muted">SSR.fun Fee</span>
          <span className="num">{bpsPct(ssr)}</span>
        </div>
        <div className="row total">
          <span>Total fee paid by users{annualized ? ' (annualized)' : ''}</span>
          <span className="num">{bpsPct(bps + ssr)}</span>
        </div>
      </div>
      <p className="fee-note">
        An SSR.fun fee is added to the Manager Fee. The SSR.fun fee is 0.5% or 50% of the Manager Fee, whichever is
        greater.
      </p>
    </div>
  )
}
