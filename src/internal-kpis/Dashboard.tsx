import { useCallback, useEffect, useState } from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts'

// Dark-mode categorical/status slots from the dataviz skill's validated
// reference palette (references/palette.md's "Dark" column) -- this page is
// fixed dark-mode only (see main.tsx), so only the dark steps are needed.
// Passed as literal hex to recharts props (not CSS custom properties --
// recharts' SVG renderer doesn't reliably resolve var() across browsers).
const KPI_COLORS = {
  blue: '#3987e5',
  orange: '#d95926',
  aqua: '#199e70',
  yellow: '#c98500',
  magenta: '#d55181',
  violet: '#9085e9',
  red: '#e66767',
  good: '#0ca30c',
  warning: '#fab219',
} as const

const LIFECYCLE_COLORS: Record<string, string> = {
  active: KPI_COLORS.good,
  windDown: KPI_COLORS.warning,
  closed: KPI_COLORS.red,
  assetsInitializing: KPI_COLORS.aqua,
  created: KPI_COLORS.violet,
  paused: KPI_COLORS.magenta,
}

interface ProtocolKpiTotals {
  reservesDiscovered: number
  totalMintVolumeRaw: string
  totalRedeemVolumeRaw: string
  totalProtocolFeeRaw: string
  totalManagerFeeRaw: string
  totalManagerFeeClaimedRaw: string
}

interface ProtocolKpis {
  generatedAt: string
  totals: ProtocolKpiTotals
  lifecycleCounts: { status: string; count: number }[]
  reservesCreatedByMonth: { month: string; count: number; cumulative: number }[]
  dailyVolume: { day: string; mintVolumeRaw: string; redeemVolumeRaw: string }[]
  monthlyFees: { month: string; protocolFeeRaw: string; managerFeeRaw: string }[]
  monthlyAvgAssetsPerReserve: { month: string; avgAssetCount: number; reserveCount: number }[]
  topReservesByVolume: { reserve: string; totalVolumeRaw: string }[]
  eventKindCounts: { kind: string; count: number }[]
  backfillStatus: { reservesFullyBackfilled: number; reservesStillIncomplete: number }
}

interface BackfillResult {
  reservesDiscovered: number
  reservesFullyBackfilled: number
  reservesStillIncomplete: number
  syncCallsMade: number
  errors: string[]
  timedOut: boolean
  durationMs: number
}

/** Raw Reserve Token base units -> human units (RESERVE_TOKEN_DECIMALS=6, matching every other display-layer conversion in this app). Display-only precision, never used for accounting. */
function humanAmount(raw: string): number {
  return Number(raw) / 1_000_000
}

function formatAmount(raw: string): string {
  return humanAmount(raw).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; kpis: ProtocolKpis }

function ChartTooltip({ active, payload, label, formatter }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; formatter?: (v: number) => string }) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="kpi-tooltip">
      <p className="kpi-tooltip-label">{label}</p>
      {payload.map((p) => (
        <div className="kpi-tooltip-row" key={p.name}>
          <span className="kpi-tooltip-swatch" style={{ background: p.color }} />
          <span>{p.name}: {formatter ? formatter(p.value) : p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="kpi-legend">
      {items.map((it) => (
        <span className="kpi-legend-item" key={it.label}>
          <span className="kpi-legend-swatch" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

export function KpiDashboard() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    fetch('/api/kpis/kpis', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          // Surface the real backend error body (stage/error/stack -- see
          // kpis.ts's outer try/catch) instead of just the status code, so
          // a failure is diagnosable from the page itself, not just server
          // logs. Falls back to the bare status if the body isn't JSON.
          const body = await res.json().catch(() => null) as { stage?: string; error?: string } | null
          const detail = body?.error ? `${body.stage ? `[${body.stage}] ` : ''}${body.error}` : `HTTP ${res.status}`
          throw new Error(detail)
        }
        return res.json()
      })
      .then((kpis: ProtocolKpis) => setState({ kind: 'ready', kpis }))
      .catch((e: Error) => setState({ kind: 'error', message: e.message }))
  }, [])

  useEffect(() => { load() }, [load])

  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    setRefreshMsg(null)
    fetch('/api/kpis/kpis-refresh', { method: 'POST', credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((result: BackfillResult) => {
        setRefreshMsg(
          `Swept ${result.reservesDiscovered} Reserve(s), ${result.reservesFullyBackfilled} fully indexed` +
            (result.reservesStillIncomplete > 0 ? `, ${result.reservesStillIncomplete} still catching up` : '') +
            (result.timedOut ? ' (time budget reached, resumable -- run again)' : '') +
            '.',
        )
        load()
      })
      .catch((e: Error) => setRefreshMsg(`Refresh failed: ${e.message}`))
      .finally(() => setRefreshing(false))
  }, [load])

  if (state.kind === 'loading') {
    return (
      <div className="dash-shell dash-center">
        <p className="dash-muted">Loading protocol KPIs...</p>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="dash-shell dash-center">
        <p className="dash-error">Failed to load: {state.message}</p>
      </div>
    )
  }

  const { kpis } = state
  const totalVolume = (Number(kpis.totals.totalMintVolumeRaw) + Number(kpis.totals.totalRedeemVolumeRaw)).toString()

  return (
    <div className="dash-shell dash-fade-in">
      <div className="dash-header">
        <div className="dash-header-left">
          <div className="dash-header-text">
            <span className="dash-phase">Protocol KPIs</span>
            <span className="dash-muted dash-small">
              Generated {new Date(kpis.generatedAt).toLocaleString()} &middot; {kpis.totals.reservesDiscovered} Reserve(s) discovered live &middot;{' '}
              {kpis.backfillStatus.reservesFullyBackfilled}/{kpis.backfillStatus.reservesFullyBackfilled + kpis.backfillStatus.reservesStillIncomplete} fully backfilled
            </span>
          </div>
        </div>
        <div className="kpi-toolbar">
          {refreshMsg && <span className="kpi-refresh-msg dash-muted">{refreshMsg}</span>}
          <button className="dash-btn dash-btn-sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh data'}
          </button>
          <a className="dash-btn dash-btn-sm" href="/api/kpis/kpis-export">
            Download full CSV
          </a>
        </div>
      </div>

      <div className="dash-section">
        <h3 className="dash-section-title">Totals (Reserve Token units, all-time)</h3>
        <div className="kpi-metrics-grid">
          <div className="dash-metric-tile">
            <span className="dash-metric-value dash-mono">{kpis.totals.reservesDiscovered}</span>
            <span className="dash-metric-label dash-muted dash-small">Reserves (live)</span>
          </div>
          <div className="dash-metric-tile">
            <span className="dash-metric-value dash-mono">{formatAmount(totalVolume)}</span>
            <span className="dash-metric-label dash-muted dash-small">Total volume (mint + redeem)</span>
          </div>
          <div className="dash-metric-tile">
            <span className="dash-metric-value dash-mono">{formatAmount(kpis.totals.totalMintVolumeRaw)}</span>
            <span className="dash-metric-label dash-muted dash-small">Mint volume</span>
          </div>
          <div className="dash-metric-tile">
            <span className="dash-metric-value dash-mono">{formatAmount(kpis.totals.totalRedeemVolumeRaw)}</span>
            <span className="dash-metric-label dash-muted dash-small">Redeem volume</span>
          </div>
          <div className="dash-metric-tile">
            <span className="dash-metric-value dash-mono">{formatAmount(kpis.totals.totalProtocolFeeRaw)}</span>
            <span className="dash-metric-label dash-muted dash-small">Protocol fee revenue</span>
          </div>
          <div className="dash-metric-tile">
            <span className="dash-metric-value dash-mono">{formatAmount(kpis.totals.totalManagerFeeRaw)}</span>
            <span className="dash-metric-label dash-muted dash-small">Manager fee revenue accrued</span>
          </div>
        </div>
      </div>

      <div className="kpi-charts-grid">
        <div className="dash-card kpi-chart-card">
          <div className="dash-card-head">
            <h2>Reserves created by month</h2>
          </div>
          <div className="kpi-chart-body">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={kpis.reservesCreatedByMonth} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
                <XAxis dataKey="month" stroke="var(--text-2)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--text-2)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="count" name="Created this month" fill={KPI_COLORS.blue} radius={[3, 3, 0, 0]} />
                <Line type="monotone" dataKey="cumulative" name="Cumulative total" stroke={KPI_COLORS.orange} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'Created this month', color: KPI_COLORS.blue }, { label: 'Cumulative total', color: KPI_COLORS.orange }]} />
        </div>

        <div className="dash-card kpi-chart-card">
          <div className="dash-card-head">
            <h2>Daily volume</h2>
          </div>
          <div className="kpi-chart-body">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={kpis.dailyVolume.map((d) => ({ day: d.day, mint: humanAmount(d.mintVolumeRaw), redeem: humanAmount(d.redeemVolumeRaw) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
                <XAxis dataKey="day" stroke="var(--text-2)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--text-2)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip formatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })} />} />
                <Line type="monotone" dataKey="mint" name="Mint volume" stroke={KPI_COLORS.blue} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="redeem" name="Redeem volume" stroke={KPI_COLORS.orange} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'Mint volume', color: KPI_COLORS.blue }, { label: 'Redeem volume', color: KPI_COLORS.orange }]} />
        </div>

        <div className="dash-card kpi-chart-card">
          <div className="dash-card-head">
            <h2>Fee revenue by month</h2>
          </div>
          <div className="kpi-chart-body">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={kpis.monthlyFees.map((f) => ({ month: f.month, protocol: humanAmount(f.protocolFeeRaw), manager: humanAmount(f.managerFeeRaw) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
                <XAxis dataKey="month" stroke="var(--text-2)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--text-2)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip formatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })} />} />
                <Bar dataKey="protocol" name="Protocol fee" fill={KPI_COLORS.blue} radius={[3, 3, 0, 0]} />
                <Bar dataKey="manager" name="Manager fee" fill={KPI_COLORS.orange} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'Protocol fee', color: KPI_COLORS.blue }, { label: 'Manager fee', color: KPI_COLORS.orange }]} />
        </div>

        <div className="dash-card kpi-chart-card">
          <div className="dash-card-head">
            <h2>Reserves by lifecycle status (live)</h2>
          </div>
          <div className="kpi-chart-body">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={kpis.lifecycleCounts} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="0" horizontal={false} />
                <XAxis type="number" stroke="var(--text-2)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="status" stroke="var(--text-2)" fontSize={11} tickLine={false} width={110} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="count" name="Reserves" radius={[0, 3, 3, 0]}>
                  {kpis.lifecycleCounts.map((entry) => (
                    <Cell key={entry.status} fill={LIFECYCLE_COLORS[entry.status] ?? KPI_COLORS.violet} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="dash-card kpi-chart-card">
          <div className="dash-card-head">
            <h2>Avg. Reserve Assets per Reserve, by creation month</h2>
          </div>
          <div className="kpi-chart-body">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={kpis.monthlyAvgAssetsPerReserve} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
                <XAxis dataKey="month" stroke="var(--text-2)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--text-2)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip formatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })} />} />
                <Bar dataKey="avgAssetCount" name="Avg. asset count" fill={KPI_COLORS.aqua} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="dash-muted dash-small">Composition breadth (current, live) of Reserves created in each month -- not a historical snapshot at creation time.</p>
        </div>

        <div className="dash-card kpi-chart-card">
          <div className="dash-card-head">
            <h2>Top 10 Reserves by total volume</h2>
          </div>
          <div className="kpi-chart-body">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={kpis.topReservesByVolume.map((r) => ({ reserve: shortAddr(r.reserve), full: r.reserve, volume: humanAmount(r.totalVolumeRaw) }))} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="0" horizontal={false} />
                <XAxis type="number" stroke="var(--text-2)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="reserve" stroke="var(--text-2)" fontSize={11} tickLine={false} width={90} />
                <Tooltip content={<ChartTooltip formatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })} />} />
                <Bar dataKey="volume" name="Volume" fill={KPI_COLORS.blue} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="dash-section">
        <div className="dash-card">
          <div className="dash-card-head">
            <h2>Every event kind ever indexed</h2>
          </div>
          <div className="kpi-table-scroll">
            <table className="kpi-table">
              <thead>
                <tr>
                  <th>Event kind</th>
                  <th className="kpi-num">Count</th>
                </tr>
              </thead>
              <tbody>
                {kpis.eventKindCounts.map((e) => (
                  <tr key={e.kind}>
                    <td className="dash-mono">{e.kind}</td>
                    <td className="kpi-num">{e.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dash-muted dash-small" style={{ marginTop: 10 }}>
            Full row-level export (every event, every column, every Reserve) via "Download full CSV" above.
          </p>
        </div>
      </div>
    </div>
  )
}
