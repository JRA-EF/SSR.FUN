import { useMemo } from 'react'
import { Link } from '../lib/router'
import { fmtNum, fmtUsd } from '../lib/format'
import { HeroPlatforms } from '../components/HeroPlatforms'
import { ReserveCard } from '../components/ReserveCard'
import { avatarStyle } from '../lib/avatarStyle'
import { useAppStore } from '@/store/useAppStore'
import { buildReserveCardProps, selectFeaturedReserves } from '@/lib/reserveCardProps'
import { useLandingStats } from '@/hooks/useLandingStats'
import type { DTR } from '@/lib/types'

function FeaturedCard({ dtr }: { dtr: DTR }) {
  const cardProps = buildReserveCardProps(dtr)
  return (
    <ReserveCard
      {...cardProps}
      avatarStyle={avatarStyle(dtr.ticker)}
      renderCta={({ className, children }) => (
        <Link to={`/dtr/${dtr.id}`} className={className}>{children}</Link>
      )}
    />
  )
}

export function Home() {
  const dtrs = useAppStore(s => s.dtrs)
  const chainDiscoveryStatus = useAppStore(s => s.chainDiscoveryStatus)
  const chainDiscoveryError = useAppStore(s => s.chainDiscoveryError)

  const onChainDtrs = useMemo(() => dtrs.filter(d => Boolean(d.onChain)), [dtrs])
  const featured = useMemo(() => selectFeaturedReserves(dtrs), [dtrs])
  const tvl = onChainDtrs.reduce((s, d) => s + d.aum, 0)
  const activeCount = onChainDtrs.length
  const stillDiscovering = chainDiscoveryStatus === 'loading' && onChainDtrs.length === 0
  const discoveryUnavailable = chainDiscoveryStatus === 'error' && onChainDtrs.length === 0
  const landingStats = useLandingStats()

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
          {stillDiscovering ? (
            <div className="callout">Checking Solana DevNet for live Reserves…</div>
          ) : discoveryUnavailable ? (
            <div className="callout warn">
              Live Reserve data is temporarily unavailable on Solana DevNet ({chainDiscoveryError ?? 'unknown error'}).
            </div>
          ) : (
            <div className="kpi-grid">
              <div className="kpi-cell">
                <div className="k">Total Reserve AUM</div>
                <div className="v">{fmtUsd(tvl)}</div>
              </div>
              <div className="kpi-cell">
                <div className="k">24h Volume</div>
                <div className="v">
                  {landingStats.status === 'loading' && '…'}
                  {landingStats.status === 'unavailable' && <span className="faint">Unavailable</span>}
                  {landingStats.status === 'ready' && landingStats.data && fmtUsd(landingStats.data.volume24hUsd)}
                </div>
              </div>
              <div className="kpi-cell">
                <div className="k">Active Reserves</div>
                <div className="v">{activeCount}</div>
              </div>
              <div className="kpi-cell">
                <div className="k">Reserve Token Holders</div>
                <div className="v">
                  {landingStats.status === 'loading' && '…'}
                  {landingStats.status === 'unavailable' && <span className="faint">Unavailable</span>}
                  {landingStats.status === 'ready' && landingStats.data && fmtNum(landingStats.data.holders)}
                </div>
              </div>
            </div>
          )}
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
          {stillDiscovering ? (
            <div className="callout">Checking Solana DevNet for live Reserves…</div>
          ) : discoveryUnavailable ? (
            <div className="callout warn">
              Live Reserve data is temporarily unavailable on Solana DevNet ({chainDiscoveryError ?? 'unknown error'}).
            </div>
          ) : featured.length === 0 ? (
            <div className="callout">
              No Reserves have launched yet. <Link to="/create">Launch a Reserve</Link> to be the
              first.
            </div>
          ) : (
            <div className="fcards">
              {featured.map(dtr => (
                <FeaturedCard key={dtr.id} dtr={dtr} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <h2>How It Works</h2>
          </div>
          <div className="how-grid">
            <div className="how-cell">
              <div className="n display">01</div>
              <h3>Create</h3>
              <p>
                <span className="emphasis">Create a Reserve in less than one minute.</span> Select up to 10 reserve
                assets, define target allocations, and configure the available settings.
              </p>
            </div>
            <div className="how-cell">
              <div className="n display">02</div>
              <h3>Launch</h3>
              <p>
                Launch it on-chain through your wallet. Its accounts, vaults, and Reserve Token are created, and the
                creator becomes its visible root Reserve Manager.
              </p>
            </div>
            <div className="how-cell">
              <div className="n display">03</div>
              <h3>Trade</h3>
              <p>
                Use devUSDC to mint and redeem Reserve Tokens. Genuine on-chain activity updates the reserve asset
                balances, Reserve Token supply, backing, and TVL.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
