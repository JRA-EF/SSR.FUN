import { useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { fmtDate, fmtHour, fmtPct, fmtUsdExact } from '../lib/format'
import { DAY } from '../data/mock'

/* Categorical slots as CSS variables — each theme supplies its own validated steps (see index.css tokens). */
export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)']
export const UNALLOC_COLOR = 'var(--s-unalloc)'
export const OTHER_COLOR = 'var(--s-other)'

/* ------------------------------ sparkline ------------------------------ */

export function Sparkline({
  data,
  timestamps,
  width = 120,
  height = 36,
  stretch = false,
  valueFmt = fmtUsdExact,
}: {
  data: number[]
  /** Per-point unix-ms timestamps, same length as `data`. When omitted, points are
   *  assumed to be one-per-day, oldest first, ending today (matches how Reserve
   *  nav/price series are seeded elsewhere in this app). */
  timestamps?: number[]
  width?: number
  height?: number
  /** Scale the SVG to fill its container width (keeps aspect ratio). */
  stretch?: boolean
  valueFmt?: (v: number) => string
}) {
  const id = useId()
  const [hover, setHover] = useState<{ i: number; xPct: number } | null>(null)
  if (data.length < 2) return null
  const n = data.length
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const xAt = (i: number) => (i / (n - 1)) * (width - 2) + 1
  const yAt = (v: number) => height - 3 - ((v - min) / span) * (height - 6)
  const pts = data.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
  const up = data[n - 1] >= data[0]
  const color = up ? 'var(--up)' : 'var(--down)'
  const dateAt = (i: number) => (timestamps ? timestamps[i] : Date.now() - (n - 1 - i) * DAY)
  /** Hover label is always hour-precision -- keeps Featured Reserves and Discover Reserves reading the same way. */
  const dateFmt = fmtHour
  /** Short "Jul 17" axis label -- drops the year fmtDate() includes, same trick PriceChart uses for its own x-axis. */
  const axisFmt = (ts: number) => fmtDate(ts).replace(/, \d{4}$/, '')

  function onMove(e: ReactMouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width
    const i = Math.max(0, Math.min(n - 1, Math.round(((relX - 1) / (width - 2)) * (n - 1))))
    setHover({ i, xPct: (xAt(i) / width) * 100 })
  }

  return (
    <div className="chart-wrap" style={stretch ? undefined : { width, height }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={stretch ? { width: '100%', height: 'auto', display: 'block' } : undefined}
        role="img"
        aria-label={`Price sparkline, currently ${valueFmt(data[n - 1])}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`sg-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: up ? 'var(--up)' : 'var(--down)' }} stopOpacity="0.22" />
            <stop offset="100%" style={{ stopColor: up ? 'var(--up)' : 'var(--down)' }} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`1,${height - 1} ${pts.join(' ')} ${width - 1},${height - 1}`} fill={`url(#sg-${id})`} />
        <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {/* Wide invisible hit-target so hover/tooltip tracking works between the sparse real data points too. */}
        <rect x="0" y="0" width={width} height={height} fill="transparent" />
        {hover && (
          <g>
            <line x1={xAt(hover.i)} x2={xAt(hover.i)} y1="1" y2={height - 1} stroke="var(--axis)" strokeWidth="1" />
            <circle cx={xAt(hover.i)} cy={yAt(data[hover.i])} r="3" fill={color} stroke="var(--surface)" strokeWidth="1.5" />
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="viz-tip spark-tip"
          style={{
            left: `min(max(0px, calc(${hover.xPct.toFixed(1)}% - 52px)), calc(100% - 104px))`,
          }}
        >
          <div className="k">{dateFmt(dateAt(hover.i))}</div>
          <div className="v">{valueFmt(data[hover.i])}</div>
        </div>
      )}

      <div className="spark-axis">
        <span>{axisFmt(dateAt(0))}</span>
        <span>{axisFmt(dateAt(n - 1))}</span>
      </div>
    </div>
  )
}

/* ------------------------------ price chart ------------------------------ */

export interface ChartSeries {
  label: string
  color: string
  data: number[]
  dashed?: boolean
}

interface Hover {
  i: number
  px: number
  py: number
}

/**
 * Line/area chart with crosshair + tooltip. Series arrays must be equal length,
 * one point per day, ending today.
 */
export function PriceChart({
  series,
  height = 260,
  area = true,
  valueFmt = fmtUsdExact,
}: {
  series: ChartSeries[]
  height?: number
  area?: boolean
  valueFmt?: (v: number) => string
}) {
  const id = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const width = 720 // viewBox width; scales to container
  const padL = 8
  const padR = 56
  const padT = 12
  const padB = 24

  const n = series[0]?.data.length ?? 0
  const { min, max } = useMemo(() => {
    let mn = Infinity
    let mx = -Infinity
    for (const s of series) for (const v of s.data) {
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    const pad = (mx - mn || mx * 0.05 || 1) * 0.08
    return { min: mn - pad, max: mx + pad }
  }, [series])

  if (n < 2) return null

  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const x = (i: number) => padL + (i / (n - 1)) * plotW
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * plotH

  const yTicks = [0, 1, 2, 3].map(t => min + ((max - min) * t) / 3)
  const dateAt = (i: number) => Date.now() - (n - 1 - i) * DAY

  const xTickIdx = [0, Math.floor((n - 1) / 3), Math.floor(((n - 1) * 2) / 3), n - 1]

  function onMove(e: ReactMouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width
    const i = Math.max(0, Math.min(n - 1, Math.round(((relX - padL) / plotW) * (n - 1))))
    setHover({ i, px: ((x(i) / width) * rect.width) / 1, py: e.clientY - rect.top })
  }

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Chart: ${series.map(s => s.label).join(', ')}`}
      >
        {yTicks.map((v, ti) => (
          <g key={ti}>
            <line x1={padL} x2={width - padR + 6} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth="1" />
            <text x={width - padR + 10} y={y(v) + 3.5} fontSize="10" fill="var(--text-3)" fontFamily="var(--font-mono)">
              {valueFmt(v)}
            </text>
          </g>
        ))}
        {xTickIdx.map(i => (
          <text key={i} x={x(i)} y={height - 6} fontSize="10" fill="var(--text-3)" fontFamily="var(--font-mono)"
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
            {fmtDate(dateAt(i)).replace(/, \d{4}$/, '')}
          </text>
        ))}

        {series.map((s, si) => {
          const pts = s.data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
          return (
            <g key={s.label}>
              {area && si === 0 && (
                <>
                  <defs>
                    <linearGradient id={`ag-${id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" style={{ stopColor: s.color }} stopOpacity="0.18" />
                      <stop offset="100%" style={{ stopColor: s.color }} stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <polygon
                    points={`${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} ${pts.join(' ')} ${x(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)}`}
                    fill={`url(#ag-${id})`}
                  />
                </>
              )}
              <polyline
                points={pts.join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? '5 4' : undefined}
              />
            </g>
          )
        })}

        {hover && (
          <g>
            <line x1={x(hover.i)} x2={x(hover.i)} y1={padT} y2={padT + plotH} stroke="var(--axis)" strokeWidth="1" />
            {series.map(s => (
              <circle key={s.label} cx={x(hover.i)} cy={y(s.data[hover.i])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
            ))}
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="viz-tip"
          style={{
            left: `min(max(0px, calc(${((x(hover.i) / width) * 100).toFixed(2)}% - 70px)), calc(100% - 150px))`,
            top: 6,
          }}
        >
          <div className="k">{fmtDate(dateAt(hover.i))}</div>
          {series.map(s => (
            <div key={s.label} style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                <span className="k">{s.label}</span>
              </span>
              <span className="v">{valueFmt(s.data[hover.i])}</span>
            </div>
          ))}
        </div>
      )}

      {series.length > 1 && (
        <div className="chart-legend">
          {series.map(s => (
            <span className="item" key={s.label}>
              <span className="swatch line-swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------ composition bar ------------------------------ */

export interface CompItem {
  label: string
  bps: number
  color: string
  sub?: string
}

export function CompositionBar({ items, showList = true }: { items: CompItem[]; showList?: boolean }) {
  const [tip, setTip] = useState<{ label: string; text: string; xPct: number } | null>(null)
  const total = items.reduce((s, i) => s + i.bps, 0) || 1
  let acc = 0
  const withOffsets = items.map(i => {
    const start = acc
    acc += i.bps
    return { ...i, start }
  })
  return (
    <div className="chart-wrap">
      <div className="comp-bar" role="img" aria-label={`Composition: ${items.map(i => `${i.label} ${fmtPct(i.bps / 100, 1)}`).join(', ')}`}>
        {withOffsets.map(i => (
          <div
            key={i.label}
            className="segment"
            style={{ width: `${(i.bps / total) * 100}%`, background: i.color }}
            onMouseEnter={() => setTip({ label: i.label, text: fmtPct(i.bps / 100, 1), xPct: ((i.start + i.bps / 2) / total) * 100 })}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </div>
      {tip && (
        <div className="viz-tip" style={{ left: `min(max(0px, calc(${tip.xPct.toFixed(1)}% - 50px)), calc(100% - 110px))`, top: -44 }}>
          <span className="k">{tip.label} </span>
          <span className="v">{tip.text}</span>
        </div>
      )}
      {showList && (
        <div className="comp-list">
          {items.map(i => (
            <div className="row" key={i.label}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: i.color, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {i.label} {i.sub && <span className="faint">· {i.sub}</span>}
              </span>
              <span className="num">{fmtPct(i.bps / 100, 1)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
