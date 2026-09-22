import { useMemo } from 'react'
import { Link } from '../lib/router'
import { fmtNum, fmtUsd } from '../lib/format'
import { HeroPlatforms } from '../components/HeroPlatforms'
import { ReserveCard } from '../components/ReserveCard'
import { avatarStyle } from '../lib/avatarStyle'
import { useAppStore } from '@/store/useAppStore'
import { robinhoodEntry, selectFeaturedEntries, solanaEntry, type DirectoryEntry } from '@/lib/directoryEntry'
import { useRobinhoodReserves } from '@/hooks/useRobinhoodReserves'
import { computeMarketCap } from '@/lib/onChainReserve'
import { useLandingStats } from '@/hooks/useLandingStats'
import { IS_MAINNET } from '@/lib/solana-config'

const CLUSTER_LABEL = IS_MAINNET ? 'Mainnet' : 'DevNet'
const SETTLEMENT_SYMBOL = IS_MAINNET ? 'USDC' : 'devUSDC'

function FeaturedCard({ entry }: { entry: DirectoryEntry }) {
  return (
    <ReserveCard
      {...entry.card}
      avatarStyle={avatarStyle(entry.ticker)}
      renderCta={({ className, children }) => (
        <Link to={entry.href} className={className}>{children}</Link>
      )}
    />
  )
}

export function Home() {
  const dtrs = useAppStore(s => s.dtrs)
  const chainDiscoveryStatus = useAppStore(s => s.chainDiscoveryStatus)
  const chainDiscoveryError = useAppStore(s => s.chainDiscoveryError)

  const robinhood = useRobinhoodReserves()
  const onChainDtrs = useMemo(() => dtrs.filter(d => Boolean(d.onChain)), [dtrs])
  // Total Reserve Market Cap = sum over every live Reserve of circulating
  // Reserve Token supply x displayed Token Price (computeMarketCap) --
  // genuinely computed per Reserve, never a relabeled AUM sum, per the
  // Mainnet pricing-layer decision (see computeMarketCap's own header;
  // an unpriced Reserve contributes 0, never a fabricated figure).
  const totalMarketCap = onChainDtrs.reduce((s, d) => s + computeMarketCap(d.onChain?.reserveTokenSupplyRaw ?? '0', d.tokenPrice), 0)
  const activeCount = onChainDtrs.length
  const stillDiscovering = chainDiscoveryStatus === 'loading' && onChainDtrs.length === 0
  const discoveryUnavailable = chainDiscoveryStatus === 'error' && onChainDtrs.length === 0
  const landingStats = useLandingStats()

  // Featured spans BOTH chains: the largest live reserves, ranked together,
  // so Robinhood is a first-class citizen of the landing page rather than a
  // section bolted on underneath.
  const featured = useMemo(
    () =>
      selectFeaturedEntries([
        ...dtrs
          .filter(d => Boolean(d.onChain) && d.onChain?.status !== 'windDown')
          .map(d =>
            solanaEntry(d, IS_MAINNET, {
              status: landingStats.status,
              volumeAllTimeUsd: d.onChain ? landingStats.data?.perReserve[d.onChain.reserve]?.volumeAllTimeUsd : undefined,
            }),
          ),
        ...robinhood.reserves.map(robinhoodEntry),
      ]),
    [dtrs, robinhood.reserves, landingStats.status, landingStats.data],
  )

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

      <div className="kpi-band">
        <div className="container">
          {stillDiscovering ? (
            <div className="callout">Checking Solana {CLUSTER_LABEL} for live Reserves…</div>
          ) : discoveryUnavailable ? (
            <div className="callout warn">
              Live Reserve data is temporarily unavailable on Solana {CLUSTER_LABEL} ({chainDiscoveryError ?? 'unknown error'}).
            </div>
          ) : (
            <div className="kpi-cards">
              <div className="kpi-card">
                <div className="k">Total Reserve Market Cap</div>
                <div className="v">{fmtUsd(totalMarketCap)}</div>
              </div>
              <div className="kpi-card">
                <div className="k">All-Time Volume</div>
                <div className="v">
                  {landingStats.status === 'loading' && '…'}
                  {landingStats.status === 'unavailable' && <span className="faint">Unavailable</span>}
                  {landingStats.status === 'ready' && landingStats.data && (
                    landingStats.data.volumeAllTimeUsd == null
                      ? <span className="faint">Unavailable</span>
                      : fmtUsd(landingStats.data.volumeAllTimeUsd)
                  )}
                </div>
              </div>
              <div className="kpi-card">
                <div className="k">Active Reserves</div>
                <div className="v">{activeCount}</div>
              </div>
              <div className="kpi-card">
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
          {/* stillDiscovering/discoveryUnavailable render nothing here -- the
              kpi-strip section above already shows that exact state, once,
              so this section never repeats the same loading/error notice a
              second time on the same page load. */}
          {(stillDiscovering || discoveryUnavailable) && featured.length === 0 ? null : featured.length === 0 ? (
            <div className="callout">
              No Reserves have launched yet. <Link to="/create">Launch a Reserve</Link> to be the
              first.
            </div>
          ) : (
            <div className="fcards">
              {featured.map(entry => (
                <FeaturedCard key={entry.key} entry={entry} />
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
                Use {SETTLEMENT_SYMBOL} to mint and redeem Reserve Tokens. Genuine on-chain activity updates the reserve asset
                balances, Reserve Token supply, backing, and TVL.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
