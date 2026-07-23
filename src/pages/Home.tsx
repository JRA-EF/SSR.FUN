import type { CSSProperties } from 'react'
import { Link } from '../lib/router'
import { useStore } from '../state/store'
import { fmtNum, fmtSigned, fmtUsd, fmtUsdExact } from '../lib/format'
import { navPerToken, type Reserve } from '../domain/types'
import { Sparkline } from '../components/charts'
import { HeroPlatforms } from '../components/HeroPlatforms'
import { bpsPct, ssrFeeBps } from '../lib/fees'

const FEE_EXAMPLES = [0, 100, 400, 2000]

/** Deterministic avatar gradient derived from the ticker. */
function avatarStyle(ticker: string): CSSProperties {
  let h = 0
  for (const ch of ticker) h = (h * 31 + ch.charCodeAt(0)) % 360
  return {
    background: `linear-gradient(135deg, hsl(${h} 72% 56%), hsl(${(h + 42) % 360} 68% 40%))`,
  }
}

function FeaturedCard({ r }: { r: Reserve }) {
  const s = r.navSeries
  const change24h = ((s[s.length - 1] - s[s.length - 2]) / s[s.length - 2]) * 100
  const price = r.marketPrice ?? navPerToken(r)
  const up = change24h >= 0
  return (
    <div className="fcard">
      <div className="fcard-head">
        <div className="fcard-name">
          <span className="favatar" style={avatarStyle(r.ticker)}>{r.ticker.slice(0, 2)}</span>
          <span className="nm">{r.name}</span>
          <span className="badge">{r.ticker}</span>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="num" style={{ fontWeight: 600, fontSize: 15 }}>{fmtUsdExact(price)}</div>
          <div className={`num ${up ? 'up' : 'down'}`} style={{ fontSize: 12 }}>{fmtSigned(change24h, 2)}</div>
        </div>
      </div>
      <p className="fcard-desc lc2">{r.description}</p>
      <Sparkline data={s.slice(-30)} width={300} height={60} stretch />
      <div className="fcard-foot">
        <div style={{ display: 'flex', gap: 18 }}>
          <div className="cell">
            <div className="k">TVL</div>
            <div className="v">{fmtUsd(r.navUsd)}</div>
          </div>
          <div className="cell">
            <div className="k">Price / Token</div>
            <div className="v">{fmtUsdExact(price)}</div>
          </div>
          <div className="cell">
            <div className="k">24h Change</div>
            <div className={`v ${up ? 'up' : 'down'}`}>{fmtSigned(change24h, 2)}</div>
          </div>
        </div>
        <Link to={`/reserve/${r.address}`} className="btn btn-trade btn-sm">Trade</Link>
      </div>
    </div>
  )
}

export function Home() {
  const { reserves } = useStore()
  const indexed = reserves.filter(r => r.indexed)
  const tvl = indexed.reduce((s, r) => s + r.navUsd, 0)
  const holders = indexed.reduce((s, r) => s + r.holders, 0)
  // Fictional 24h volume for the simulation: a fixed share of Reserve AUM.
  const volume24h = tvl * 0.054
  const featured = [...indexed].sort((a, b) => b.navUsd - a.navUsd).slice(0, 3)

  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <p className="hero-badge">Tokenized Reserve Protocol</p>
            <h1>
              One token.
              <br />
              <span className="grad">Infinite possibilities.</span>
            </h1>
            <p className="lede">Deploy your reserve on SSR.fun and start earning fees, today!</p>
            <div className="hero-ctas">
              <Link to="/create" className="btn btn-primary btn-lg">Deploy Your Reserve</Link>
              <Link to="/discover" className="btn btn-ghost btn-lg">Discover Reserves</Link>
            </div>
          </div>
          <HeroPlatforms />
        </div>
      </section>

      <div className="kpi-strip">
        <div className="container">
          <div className="kpi-grid">
            <div className="kpi-cell">
              <div className="k">Total Reserve AUM</div>
              <div className="v">{fmtUsd(tvl)}</div>
            </div>
            <div className="kpi-cell">
              <div className="k">24h Volume</div>
              <div className="v">{fmtUsd(volume24h)}</div>
            </div>
            <div className="kpi-cell">
              <div className="k">Active Reserves</div>
              <div className="v">{indexed.length}</div>
            </div>
            <div className="kpi-cell">
              <div className="k">Reserve Token Holders</div>
              <div className="v">{fmtNum(holders)}</div>
            </div>
          </div>
        </div>
      </div>

      <section className="section" id="featured">
        <div className="container">
          <div className="section-head">
            <h2>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 17l6-6 4 4 8-8" />
                <path d="M17 7h4v4" />
              </svg>
              Featured Reserves
            </h2>
            <Link to="/discover" className="faint" style={{ fontSize: 14 }}>View all →</Link>
          </div>
          <div className="fcards">
            {featured.map(r => (
              <FeaturedCard key={r.address} r={r} />
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <h2>Create. Launch. Trade.</h2>
          </div>
          <div className="how-grid">
            <div className="how-cell">
              <div className="n display">01</div>
              <h3>Create</h3>
              <p>
                Pick up to 10 Reserve Assets, set target allocations, and configure your Manager Fees. Anything left
                unallocated is held as Unallocated USDC. Creation is permissionless — no approval step.
              </p>
            </div>
            <div className="how-cell">
              <div className="n display">02</div>
              <h3>Launch</h3>
              <p>
                Seed your Reserve in kind with the assets it holds. Initial Reserve Tokens are minted at NAV and your
                wallet becomes the root Reserve Manager, with powers that stay visible to every holder.
              </p>
            </div>
            <div className="how-cell">
              <div className="n display">03</div>
              <h3>Trade</h3>
              <p>
                Anyone can mint at NAV, redeem for the underlying, or trade the Reserve Token on external liquidity
                venues. Minting and redemption keep backing proportional — market price may trade above or below NAV.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="fees">
        <div className="container">
          <div className="section-head">
            <h2>Fees without fine print</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 24 }} className="fee-2col">
            <div className="card card-pad">
              <div className="card-title">How fees work</div>
              <p className="muted" style={{ fontSize: 14 }}>
                Reserve Managers set their own Mint, Redemption, and Annualized TVL fees, each between 0% and 50%. An
                SSR.fun fee is added on top: 0.5% or 50% of the Manager Fee, whichever is greater. Every fee is shown
                separately before you sign — never combined into one unexplained number.
              </p>
              <p className="muted" style={{ fontSize: 14, marginTop: 12 }}>
                Create your reserve and start earning fees today.
              </p>
              <Link to="/create" className="btn btn-ghost" style={{ marginTop: 18 }}>Start creating</Link>
            </div>
            <div className="card card-pad">
              <div className="card-title">Example: total fee paid by users</div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Manager Fee</th>
                    <th className="r">SSR.fun Fee</th>
                    <th className="r">Total Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {FEE_EXAMPLES.map(m => (
                    <tr key={m}>
                      <td className="num">{bpsPct(m)}</td>
                      <td className="num r">{bpsPct(ssrFeeBps(m))}</td>
                      <td className="num r">{bpsPct(m + ssrFeeBps(m))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="card card-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 className="display" style={{ fontSize: 26 }}>Transparent by construction</h2>
              <p className="muted" style={{ fontSize: 14, marginTop: 8, maxWidth: '58ch' }}>
                Every Reserve shows its assets, balances, supply, fees, and Manager powers. There is no general
                withdrawal path — assets only move through minting, redemption, rebalancing, or a complete wind-down.
              </p>
            </div>
            <Link to="/discover" className="btn btn-primary btn-lg">Browse Reserves</Link>
          </div>
        </div>
      </section>
    </>
  )
}
