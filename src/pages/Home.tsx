import { useMemo } from 'react'
import { Link } from '../lib/router'
import { useStore } from '../state/store'
import { fmtNum, fmtSigned, fmtUsd, fmtUsdExact } from '../lib/format'
import { navPerToken, type Reserve } from '../domain/types'
import { HeroPlatforms } from '../components/HeroPlatforms'
import { ReserveCard } from '../components/ReserveCard'
import { bpsPct, ssrFeeBps } from '../lib/fees'
import { ASSETS } from '../data/assets'
import { avatarStyle } from '../lib/avatarStyle'
import { hashSeed, hourlySeries7d } from '../data/mock'

const FEE_EXAMPLES = [0, 100, 400, 2000]

function topAssetSymbols(r: Reserve, n = 3): string[] {
  return [...r.allocations]
    .sort((a, b) => b.targetBps - a.targetBps)
    .slice(0, n)
    .map(a => ASSETS.find(x => x.id === a.assetId)?.symbol ?? a.assetId.toUpperCase())
}

function FeaturedCard({ r }: { r: Reserve }) {
  const s = r.navSeries
  const change24h = ((s[s.length - 1] - s[s.length - 2]) / s[s.length - 2]) * 100
  const price = r.marketPrice ?? navPerToken(r)
  // Same 7-day, ~hourly-resolution shape as Discover Reserves' real trade history,
  // synthesized here since native Reserves only track one NAV point per day.
  const history = useMemo(() => hourlySeries7d(hashSeed(r.address), price), [r.address, price])
  return (
    <ReserveCard
      name={r.name}
      ticker={r.ticker}
      description={r.description}
      avatarLabel={r.ticker.slice(0, 2)}
      avatarStyle={avatarStyle(r.ticker)}
      priceFormatted={fmtUsdExact(price)}
      changePct={change24h}
      changeFormatted={fmtSigned(change24h, 2)}
      sparkline={history.map(p => p.price)}
      sparklineTimestamps={history.map(p => p.t)}
      topAssets={topAssetSymbols(r)}
      metrics={[
        { key: 'tvl', label: 'TVL', value: fmtUsd(r.navUsd) },
        { key: 'price', label: 'Price / Token', value: fmtUsdExact(price) },
        { key: 'chg', label: '24h Change', value: fmtSigned(change24h, 2), tone: change24h >= 0 ? 'up' : 'down' },
      ]}
      renderCta={({ className, children }) => (
        <Link to={`/reserve/${r.address}`} className={className}>{children}</Link>
      )}
    />
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
            <p className="lede">
              SSR.fun is where anyone can create, launch, and trade decentralized tokenized reserves. Build a basket
              of Solana assets, set your fees, and issue a Reserve Token backed by transparent, on-chain holdings.
            </p>
            <div className="hero-ctas">
              <Link to="/create" className="btn btn-primary btn-lg">Launch Reserve</Link>
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
                Launch your Reserve and start earning fees today.
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
