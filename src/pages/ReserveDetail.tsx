import { useState } from 'react'
import { useStore } from '../state/store'
import { Link } from '../lib/router'
import { navPerToken, premiumPct, unallocatedBps } from '../domain/types'
import { assetById, capabilityNotes } from '../data/assets'
import { bpsPct, ssrFeeBps } from '../lib/fees'
import { fmtDate, fmtNum, fmtPct, fmtSigned, fmtUsd, fmtUsdExact, fmtQty, shortAddr, timeAgo } from '../lib/format'
import { CompositionBar, PriceChart, SERIES_COLORS, UNALLOC_COLOR, OTHER_COLOR } from '../components/charts'
import { compItems } from '../components/composition'
import { Addr, ReserveBadges, Stat, TokenIcon } from '../components/ui'
import { TradePanel } from '../components/TradePanel'

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

const ACT_LABEL: Record<string, string> = {
  mint: 'Mint',
  redeem: 'Redemption',
  rebalance: 'Rebalance',
  create: 'Created',
  'fee-update': 'Fee update',
  delegate: 'Delegates',
  'wind-down': 'Wind-down',
}

const ACT_ICON: Record<string, string> = {
  mint: '+',
  redeem: '−',
  rebalance: '⇄',
  create: '✶',
  'fee-update': '%',
  delegate: '⚿',
  'wind-down': '◼',
}

function FeeCard({ title, managerBps, kind }: { title: string; managerBps: number; kind: string }) {
  const ssr = ssrFeeBps(managerBps)
  return (
    <div className="stat-cell">
      <div className="k">{title}</div>
      <div className="v">{bpsPct(managerBps + ssr)}</div>
      <div className="s faint">
        {bpsPct(managerBps)} Manager + {bpsPct(ssr)} SSR.fun{kind === 'tvl' ? ' · annualized' : ''}
      </div>
    </div>
  )
}

export function ReserveDetail({ address }: { address: string }) {
  const { reserveByAddress } = useStore()
  const [rangeDays, setRangeDays] = useState(90)
  const [showMarket, setShowMarket] = useState(true)
  const r = reserveByAddress(address)

  if (!r) {
    return (
      <div className="container page">
        <div className="page-head">
          <h1>Reserve not found</h1>
          <p className="sub">No Reserve exists at this address in the prototype dataset.</p>
        </div>
        <Link to="/discover" className="btn btn-ghost">Back to discovery</Link>
      </div>
    )
  }

  const nav = navPerToken(r)
  const prem = premiumPct(r)
  const unBps = unallocatedBps(r.allocations)
  const navData = r.navSeries.slice(-rangeDays)
  const marketData = r.marketSeries?.slice(-rangeDays) ?? null
  const series = [
    { label: 'NAV per Reserve Token', color: 'var(--s1)', data: navData },
    ...(showMarket && marketData ? [{ label: 'Market price', color: 'var(--s2)', data: marketData, dashed: true }] : []),
  ]

  return (
    <div className="container page">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h1 className="display" style={{ fontSize: 40 }}>{r.name}</h1>
        <span className="mono muted" style={{ fontSize: 15 }}>{r.ticker}</span>
        <ReserveBadges r={r} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 8 }}>
        <Addr label="Reserve" value={r.address} />
        <Addr label="Creator" value={r.creator} />
        <Addr label="Manager" value={r.manager} />
        <span className="addr-line">created {fmtDate(r.createdAt)}</span>
      </div>
      <p className="muted" style={{ maxWidth: '75ch', marginBottom: 24 }}>{r.description}</p>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            <Stat k="TVL (Reserve NAV)" v={fmtUsd(r.navUsd)} />
            <Stat k="NAV per token" v={fmtUsdExact(nav)} />
            <Stat
              k="Market price"
              v={r.marketPrice != null ? fmtUsdExact(r.marketPrice) : '—'}
              sub={r.marketPrice != null ? 'external DEX (mock)' : 'no external liquidity'}
            />
            <Stat
              k="Premium / discount"
              v={prem != null ? fmtSigned(prem, 2) : '—'}
              sub={prem != null ? (prem >= 0 ? 'above NAV' : 'below NAV') : 'needs a market price'}
              subClass={prem != null ? (prem >= 0 ? 'up' : 'down') : 'faint'}
            />
            <Stat k="Holders" v={fmtNum(r.holders)} sub={`${fmtNum(r.supply)} ${r.ticker} supply`} />
          </div>

          <div className="card card-pad">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>Performance</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {marketData && (
                  <button
                    className={`badge ${showMarket ? 'badge-accent' : 'badge-mock'}`}
                    onClick={() => setShowMarket(v => !v)}
                    aria-pressed={showMarket}
                  >
                    market overlay
                  </button>
                )}
                <div className="seg seg-sm" role="tablist" aria-label="Chart range">
                  {RANGES.map(x => (
                    <button key={x.days} role="tab" aria-selected={rangeDays === x.days} className={rangeDays === x.days ? 'active' : ''} onClick={() => setRangeDays(x.days)}>
                      {x.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <PriceChart series={series} />
            <p className="fee-note" style={{ marginTop: 14 }}>
              NAV per Reserve Token is computed from the Reserve's holdings. Market price comes from external liquidity
              and may trade above or below NAV — minting and redemption are the arbitrage path that pulls them together.
            </p>
          </div>

          <div className="card card-pad">
            <div className="card-title">Composition</div>
            <CompositionBar items={compItems(r, 'current')} showList={false} />
            <div className="tbl-scroll" style={{ marginTop: 14 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Reserve Asset</th>
                    <th className="r">Target</th>
                    <th className="r">Current</th>
                    <th className="r">Value</th>
                    <th className="r">Price</th>
                    <th className="r">24h</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {r.allocations.map((a, i) => {
                    const asset = assetById(a.assetId)
                    const notes = capabilityNotes(asset)
                    const value = (r.navUsd * a.currentBps) / 10000
                    return (
                      <tr key={a.assetId}>
                        <td>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ width: 3, height: 22, borderRadius: 2, background: i < SERIES_COLORS.length ? SERIES_COLORS[i] : OTHER_COLOR }} />
                            <TokenIcon assetId={a.assetId} size={24} />
                            <span>
                              <span style={{ fontWeight: 600 }}>{asset.symbol}</span>
                              <span className="faint" style={{ fontSize: 12, display: 'block' }}>{asset.name}</span>
                            </span>
                          </span>
                        </td>
                        <td className="r num">{fmtPct(a.targetBps / 100)}</td>
                        <td className="r num">
                          {fmtPct(a.currentBps / 100)}
                          {Math.abs(a.currentBps - a.targetBps) >= 100 && (
                            <span className="faint" style={{ fontSize: 11 }}> (drift)</span>
                          )}
                        </td>
                        <td className="r num">{asset.capabilities.canPrice ? fmtUsd(value) : '—'}</td>
                        <td className="r num">{asset.capabilities.canPrice ? fmtUsdExact(asset.price) : '—'}</td>
                        <td className={`r num ${asset.change24h >= 0 ? 'up' : 'down'}`}>
                          {asset.capabilities.canPrice ? fmtSigned(asset.change24h) : '—'}
                        </td>
                        <td>
                          <span className="cap-chips">
                            {notes.map(nt => (
                              <span key={nt.label} className={`cap-chip${nt.severity === 'warn' ? ' warn' : ''}`}>{nt.label}</span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                  {unBps > 0 && (
                    <tr>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 3, height: 22, borderRadius: 2, background: UNALLOC_COLOR }} />
                          <TokenIcon assetId="usdc" size={24} />
                          <span>
                            <span style={{ fontWeight: 600 }}>Unallocated USDC</span>
                            <span className="faint" style={{ fontSize: 12, display: 'block' }}>held in USDC by design</span>
                          </span>
                        </span>
                      </td>
                      <td className="r num">{fmtPct(unBps / 100)}</td>
                      <td className="r num">{fmtPct(unBps / 100)}</td>
                      <td className="r num">{fmtUsd((r.navUsd * unBps) / 10000)}</td>
                      <td className="r num">$1.00</td>
                      <td className="r num faint">0.0%</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {r.allocations.some(a => !assetById(a.assetId).capabilities.canPrice) && (
              <div className="callout warn" style={{ marginTop: 14 }}>
                <b>Unpriced holding.</b> At least one Reserve Asset has no price source, so displayed NAV excludes it.
                Minting and redemption for this Reserve carry additional uncertainty.
              </div>
            )}
          </div>

          <div className="card card-pad">
            <div className="card-title">Fees</div>
            <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <FeeCard title="Total Mint Fee" managerBps={r.fees.mintBps} kind="mint" />
              <FeeCard title="Total Redemption Fee" managerBps={r.fees.redeemBps} kind="redeem" />
              <FeeCard title="Total TVL Fee" managerBps={r.fees.tvlBps} kind="tvl" />
            </div>
            <p className="fee-note" style={{ marginTop: 14 }}>
              An SSR.fun fee is added to the Manager Fee. The SSR.fun fee is 0.5% or 50% of the Manager Fee, whichever
              is greater. Both parts are always shown separately before you sign.
            </p>
          </div>

          <div className="card card-pad">
            <div className="card-title">Manager powers</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18, fontSize: 13 }}>
              <div>
                <div className="faint" style={{ marginBottom: 6 }}>Root Reserve Manager</div>
                <Addr value={r.manager} />
                <p className="muted" style={{ marginTop: 8 }}>
                  Can change target weights, add or remove Reserve Assets, edit fees within 0–50%, and delegate specific
                  permissions. Root authority is transferable.
                </p>
              </div>
              <div>
                <div className="faint" style={{ marginBottom: 6 }}>Reserve Creator (permanent)</div>
                <Addr value={r.creator} />
                <p className="muted" style={{ marginTop: 8 }}>
                  The original creator remains identifiable forever and is the only wallet that can initiate a complete
                  wind-down.
                </p>
              </div>
              <div>
                <div className="faint" style={{ marginBottom: 6 }}>Delegates</div>
                {r.delegates.length === 0 ? (
                  <p className="muted">No delegated wallets.</p>
                ) : (
                  r.delegates.map(d => (
                    <div key={d.address} style={{ marginBottom: 8 }}>
                      <Addr value={d.address} label={d.label} />
                      <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
                        {Object.entries(d.permissions).filter(([, v]) => v).map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(' · ')}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="callout" style={{ marginTop: 16 }}>
              <b>What no one can do:</b> neither the Reserve Manager, delegates, nor SSR.fun can withdraw Reserve Assets
              outside minting, redemption, rebalancing, or a complete wind-down. Name and ticker are immutable.
            </div>
          </div>

          <div className="card card-pad">
            <div className="card-title">Activity</div>
            <div>
              {r.activity.slice(0, 10).map(e => (
                <div className="act-row" key={e.id}>
                  <span className="act-ic" aria-hidden="true">{ACT_ICON[e.kind]}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{ACT_LABEL[e.kind]}</span>
                    <span className="faint"> · {shortAddr(e.wallet)}</span>
                    {e.note && <span className="faint" style={{ display: 'block', fontSize: 12 }}>{e.note}</span>}
                  </span>
                  {e.amountUsd != null && (
                    <span className="num muted">
                      {fmtUsd(e.amountUsd)}
                      {e.tokens != null && <span className="faint"> · {fmtQty(e.tokens, 1)} {r.ticker}</span>}
                    </span>
                  )}
                  <span className="faint" style={{ whiteSpace: 'nowrap' }}>{timeAgo(e.ts)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <TradePanel reserve={r} />
        </div>
      </div>
    </div>
  )
}
