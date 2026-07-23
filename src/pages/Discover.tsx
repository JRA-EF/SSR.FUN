import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { navigate, Link, usePath } from '../lib/router'
import { navPerToken, premiumPct, type Reserve } from '../domain/types'
import { fmtNum, fmtSigned, fmtUsd, fmtUsdExact } from '../lib/format'
import { Sparkline } from '../components/charts'
import { ReserveBadges, TokenStack } from '../components/ui'

type Filter = 'all' | 'verified' | 'new' | 'my'
type Sort = 'tvl' | '7d' | 'holders' | 'newest'

function change7d(r: Reserve): number {
  const s = r.navSeries.slice(-7)
  return ((s[s.length - 1] - s[0]) / s[0]) * 100
}

export function Discover() {
  const { reserves, wallet } = useStore()
  const path = usePath()
  // The navbar search lands here as /discover?q=…
  const urlQ = useMemo(() => new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '', [path])
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('tvl')
  const [q, setQ] = useState(urlQ)
  useEffect(() => {
    if (urlQ) setQ(urlQ)
  }, [urlQ])
  const [addr, setAddr] = useState('')
  const [addrErr, setAddrErr] = useState<string | null>(null)

  const rows = useMemo(() => {
    let list = reserves.filter(r => r.indexed)
    if (filter === 'verified') list = list.filter(r => r.verified)
    if (filter === 'new') list = list.filter(r => Date.now() - r.createdAt < 14 * 86_400_000)
    if (filter === 'my') list = list.filter(r => r.manager === wallet || r.creator === wallet)
    if (q.trim()) {
      const t = q.trim().toLowerCase()
      list = list.filter(r => r.name.toLowerCase().includes(t) || r.ticker.toLowerCase().includes(t))
    }
    const sorted = [...list]
    if (sort === 'tvl') sorted.sort((a, b) => b.navUsd - a.navUsd)
    if (sort === '7d') sorted.sort((a, b) => change7d(b) - change7d(a))
    if (sort === 'holders') sorted.sort((a, b) => b.holders - a.holders)
    if (sort === 'newest') sorted.sort((a, b) => b.createdAt - a.createdAt)
    return sorted
  }, [reserves, filter, sort, q, wallet])

  function openByAddress() {
    const target = reserves.find(r => r.address === addr.trim())
    if (target) {
      setAddrErr(null)
      navigate(`/reserve/${target.address}`)
    } else {
      setAddrErr('No Reserve found at that address in this prototype.')
    }
  }

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Discover Reserves</h1>
        <p className="sub">
          Reserves indexed by the SSR.fun interface. Listing is an interface decision, not an endorsement — any Reserve
          remains reachable by its address below.
        </p>
      </div>

      <div className="filter-row">
        <div className="seg" role="tablist" aria-label="Filter reserves">
          {([['all', 'All'], ['verified', 'Verified'], ['new', 'New'], ['my', 'Mine']] as [Filter, string][]).map(([f, label]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <label className="faint" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Sort
          <select className="select" style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }} value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="tvl">TVL</option>
            <option value="7d">7d NAV change</option>
            <option value="holders">Holders</option>
            <option value="newest">Newest</option>
          </select>
        </label>
        <div className="spacer" />
        <div className="search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input placeholder="Search name or ticker" value={q} onChange={e => setQ(e.target.value)} aria-label="Search reserves" />
        </div>
      </div>

      <div className="card tbl-scroll">
        <table className="tbl tbl-hover">
          <thead>
            <tr>
              <th>Reserve</th>
              <th>Composition</th>
              <th className="r">TVL</th>
              <th className="r">NAV / token</th>
              <th className="r">Market</th>
              <th className="r">Premium</th>
              <th className="r">7d NAV</th>
              <th className="r">Holders</th>
              <th>30d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const prem = premiumPct(r)
              const w = change7d(r)
              return (
                <tr key={r.address} onClick={() => navigate(`/reserve/${r.address}`)}>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600 }}>{r.name}</span>
                        <span className="mono faint" style={{ fontSize: 12 }}>{r.ticker}</span>
                      </span>
                      <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        <ReserveBadges r={r} />
                      </span>
                    </div>
                  </td>
                  <td><TokenStack assetIds={r.allocations.map(a => a.assetId)} size={20} max={5} /></td>
                  <td className="r num">{fmtUsd(r.navUsd)}</td>
                  <td className="r num">{fmtUsdExact(navPerToken(r))}</td>
                  <td className="r num">{r.marketPrice != null ? fmtUsdExact(r.marketPrice) : <span className="faint">no market</span>}</td>
                  <td className={`r num ${prem == null ? 'faint' : prem >= 0 ? 'up' : 'down'}`}>
                    {prem == null ? '—' : fmtSigned(prem)}
                  </td>
                  <td className={`r num ${w >= 0 ? 'up' : 'down'}`}>{fmtSigned(w)}</td>
                  <td className="r num">{fmtNum(r.holders)}</td>
                  <td><Sparkline data={r.navSeries.slice(-30)} width={96} height={30} /></td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: 40 }} className="faint">
                  No Reserves match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card card-pad" style={{ marginTop: 24 }}>
        <div className="card-title">Open a Reserve by address</div>
        <p className="faint" style={{ fontSize: 13, marginBottom: 12 }}>
          Direct-address access works even for Reserves not shown in discovery.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            className="input mono"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="Reserve address"
            value={addr}
            onChange={e => { setAddr(e.target.value); setAddrErr(null) }}
            onKeyDown={e => { if (e.key === 'Enter') openByAddress() }}
            aria-label="Reserve address"
          />
          <button className="btn btn-ghost" onClick={openByAddress}>Open</button>
        </div>
        {addrErr && <p className="down" style={{ fontSize: 13, marginTop: 10 }}>{addrErr}</p>}
        <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>
          Try: <Link to={`/reserve/${reserves[0]?.address}`} className="mono">{reserves[0]?.address}</Link>
        </p>
      </div>
    </div>
  )
}
