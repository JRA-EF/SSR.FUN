import { useMemo } from 'react'
import { useStore } from '../state/store'
import { Link, navigate } from '../lib/router'
import { navPerToken, premiumPct } from '../domain/types'
import { fmtQty, fmtSigned, fmtUsd, fmtUsdExact, shortAddr, timeAgo } from '../lib/format'
import { CompositionBar, Sparkline, SERIES_COLORS, OTHER_COLOR, type CompItem } from '../components/charts'
import { Stat, TokenStack } from '../components/ui'

export function Portfolio() {
  const { holdings, reserves, wallet } = useStore()

  const rows = useMemo(
    () =>
      holdings
        .map(h => {
          const r = reserves.find(x => x.address === h.reserveAddress)
          if (!r) return null
          const nav = navPerToken(r)
          const value = h.tokens * nav
          return { h, r, nav, value, pnl: value - h.costBasisUsd }
        })
        .filter(x => x != null)
        .sort((a, b) => b.value - a.value),
    [holdings, reserves],
  )

  const totalValue = rows.reduce((s, x) => s + x.value, 0)
  const totalCost = rows.reduce((s, x) => s + x.h.costBasisUsd, 0)
  const totalPnl = totalValue - totalCost

  const comp: CompItem[] = rows.map((x, i) => ({
    label: x.r.ticker,
    sub: x.r.name,
    bps: totalValue > 0 ? Math.round((x.value / totalValue) * 10000) : 0,
    color: i < SERIES_COLORS.length ? SERIES_COLORS[i] : OTHER_COLOR,
  }))

  const myActivity = useMemo(
    () =>
      reserves
        .flatMap(r => r.activity.filter(e => e.wallet === wallet).map(e => ({ e, r })))
        .sort((a, b) => b.e.ts - a.e.ts)
        .slice(0, 8),
    [reserves, wallet],
  )

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Portfolio</h1>
        <p className="sub">Reserve Tokens held by {shortAddr(wallet)} in this prototype.</p>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        <Stat k="Total value (at NAV)" v={fmtUsd(totalValue)} />
        <Stat k="Cost basis" v={fmtUsd(totalCost)} />
        <Stat
          k="Unrealized P&L"
          v={<span className={totalPnl >= 0 ? 'up' : 'down'}>{`${totalPnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(totalPnl)).replace('$', '$')}`}</span>}
          sub={totalCost > 0 ? fmtSigned((totalPnl / totalCost) * 100) : undefined}
          subClass={totalPnl >= 0 ? 'up' : 'down'}
        />
        <Stat k="Positions" v={rows.length} />
      </div>

      {rows.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: 'center', padding: 60 }}>
          <p className="muted" style={{ marginBottom: 16 }}>No Reserve Tokens yet.</p>
          <Link to="/discover" className="btn btn-primary">Discover Reserves</Link>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 24, alignItems: 'start' }} className="detail-grid">
            <div className="card tbl-scroll">
              <table className="tbl tbl-hover">
                <thead>
                  <tr>
                    <th>Reserve</th>
                    <th className="r">Balance</th>
                    <th className="r">NAV / token</th>
                    <th className="r">Premium</th>
                    <th className="r">Value</th>
                    <th className="r">P&L</th>
                    <th>30d</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(x => {
                    const prem = premiumPct(x.r)
                    return (
                      <tr key={x.r.address} onClick={() => navigate(`/reserve/${x.r.address}`)}>
                        <td>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <TokenStack assetIds={x.r.allocations.map(a => a.assetId)} size={20} max={3} />
                            <span>
                              <span style={{ fontWeight: 600, display: 'block' }}>{x.r.name}</span>
                              <span className="mono faint" style={{ fontSize: 11 }}>{x.r.ticker}</span>
                            </span>
                          </span>
                        </td>
                        <td className="r num">{fmtQty(x.h.tokens, 2)}</td>
                        <td className="r num">{fmtUsdExact(x.nav)}</td>
                        <td className={`r num ${prem == null ? 'faint' : prem >= 0 ? 'up' : 'down'}`}>{prem == null ? '—' : fmtSigned(prem)}</td>
                        <td className="r num">{fmtUsd(x.value)}</td>
                        <td className={`r num ${x.pnl >= 0 ? 'up' : 'down'}`}>
                          {x.pnl >= 0 ? '+' : '−'}{fmtUsd(Math.abs(x.pnl))}
                        </td>
                        <td><Sparkline data={x.r.navSeries.slice(-30)} width={90} height={28} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div className="card card-pad">
                <div className="card-title">Allocation by Reserve</div>
                <CompositionBar items={comp} />
              </div>
              <div className="card card-pad">
                <div className="card-title">Your recent activity</div>
                {myActivity.length === 0 && <p className="faint" style={{ fontSize: 13 }}>No activity yet.</p>}
                {myActivity.map(({ e, r }) => (
                  <div className="act-row" key={e.id}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{e.kind === 'mint' ? 'Mint' : e.kind === 'redeem' ? 'Redemption' : e.kind}</span>
                      <span className="faint"> · {r.ticker}</span>
                    </span>
                    {e.amountUsd != null && <span className="num muted">{fmtUsd(e.amountUsd)}</span>}
                    <span className="faint">{timeAgo(e.ts)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
