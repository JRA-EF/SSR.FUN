import type { CSSProperties, ReactNode } from 'react'
import { Sparkline } from './charts'

export interface ReserveCardMetric {
  key: string
  label: string
  value: string
  tone?: 'up' | 'down'
}

export interface ReserveCardProps {
  name: string
  ticker: string
  description: string
  avatarLabel: string
  avatarStyle?: CSSProperties
  avatarImageUrl?: string
  categoryLabel?: string
  /** Clearly distinguishes a real, chain-verified Reserve from a simulated/illustrative one -- see docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md item 10. Reuses the existing `.badge-verified`/`.badge-mock` styles. */
  sourceBadge?: { label: string; tone: 'onchain' | 'simulated' }
  priceFormatted: string
  changePct: number
  changeFormatted: string
  sparkline?: number[]
  /** Per-point unix-ms timestamps aligned with `sparkline`, for an accurate hover tooltip. */
  sparklineTimestamps?: number[]
  /** Formats the hovered sparkline value; defaults to the sparkline's own default. */
  sparklineValueFmt?: (v: number) => string
  topAssets?: string[]
  metrics: ReserveCardMetric[]
  ctaLabel?: string
  /** Rendered as the CTA — a router Link in both call sites, kept generic so this component doesn't depend on a specific router. */
  renderCta: (props: { className: string; children: ReactNode }) => ReactNode
}

/**
 * The one standard Reserve card, shared by Featured Reserves (Home) and
 * Discover Reserves. Both callers adapt their own data (native Reserve or
 * ported DTR) into this shape rather than the card knowing about either.
 */
export function ReserveCard({
  name,
  ticker,
  description,
  avatarLabel,
  avatarStyle,
  avatarImageUrl,
  categoryLabel,
  sourceBadge,
  priceFormatted,
  changePct,
  changeFormatted,
  sparkline,
  sparklineTimestamps,
  sparklineValueFmt,
  topAssets,
  metrics,
  ctaLabel = 'Trade',
  renderCta,
}: ReserveCardProps) {
  const up = changePct >= 0
  return (
    <div
      className="fcard fcard-clickable"
      // The whole card opens the Reserve: any click that isn't on a real
      // interactive element delegates to the card's own CTA link, so this
      // works identically under both routers without knowing the target URL.
      onClick={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('a, button, input')) return
        el.closest('.fcard')?.querySelector<HTMLAnchorElement>('a.btn-trade')?.click()
      }}
    >
      <div className="fcard-head">
        <div className="fcard-name">
          <span className="favatar" style={avatarStyle}>
            {avatarImageUrl ? <img src={avatarImageUrl} alt="" /> : avatarLabel}
          </span>
          <div className="fcard-titles">
            <div className="nm-row">
              <span className="nm">{name}</span>
              <span className="badge">{ticker}</span>
              {categoryLabel && <span className="badge badge-mock">{categoryLabel}</span>}
              {sourceBadge && (
                <span className={`badge ${sourceBadge.tone === 'onchain' ? 'badge-verified' : 'badge-mock'}`}>
                  {sourceBadge.label}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="fcard-price">
          <div className="num" style={{ fontWeight: 600, fontSize: 15 }}>{priceFormatted}</div>
          <div className={`num ${up ? 'up' : 'down'}`} style={{ fontSize: 12 }}>{changeFormatted}</div>
        </div>
      </div>

      <p className="fcard-desc lc3">{description}</p>

      {sparkline && sparkline.length > 1 && (
        <Sparkline
          data={sparkline}
          timestamps={sparklineTimestamps}
          valueFmt={sparklineValueFmt}
          width={300}
          height={60}
          stretch
        />
      )}

      {topAssets && topAssets.length > 0 && (
        <div className="fcard-assets">
          {topAssets.map(a => (
            <span key={a} className="fcard-asset-pill">{a}</span>
          ))}
        </div>
      )}

      <div className="fcard-foot">
        <div className="fcard-metrics">
          {metrics.map(m => (
            <div className="cell" key={m.key}>
              <div className="k">{m.label}</div>
              <div className={`v${m.tone ? ` ${m.tone}` : ''}`}>{m.value}</div>
            </div>
          ))}
        </div>
        {renderCta({ className: 'btn btn-trade btn-sm', children: ctaLabel })}
      </div>
    </div>
  )
}
