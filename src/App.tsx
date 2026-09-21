import { Suspense, lazy } from 'react'
import { RouterProvider, matchPath, usePath } from './lib/router'
import { StoreProvider } from './state/store'
import { Shell } from './components/Shell'
import { Home } from './pages/Home'
import { MergeLayout } from './merge/MergeLayout'
import { MergeParamsContext } from './merge/lib/wouter-shim'
import { SolanaProviders } from './merge/lib/SolanaProviders'
import { WalletSync } from './merge/lib/WalletSync'
import { RealReserveSync } from './merge/lib/RealReserveSync'
import { ReserveSnapshotHydrator } from './merge/lib/ReserveSnapshotHydrator'
import { Discover } from './merge/pages/Discover'
import { Portfolio } from './merge/pages/Portfolio'
import { Manage } from './merge/pages/Manage'
import { ManageDTR } from './merge/pages/ManageDTR'
import { DTRDetail } from './merge/pages/DTRDetail'
import { CreateReserve } from './merge/pages/CreateReserve'
import { rhAddressFromId } from './merge/lib/evmReserveId'
// Robinhood Chain reserve pages pull in viem, which the Solana app never
// needs. Lazy so it lands in its own chunk instead of the main bundle.
const RobinhoodReserveDetail = lazy(() =>
  import('./merge/components/robinhood/RobinhoodReserveDetail').then((m) => ({ default: m.RobinhoodReserveDetail })),
)
const Loading = () => <div className="container mx-auto px-4 py-16 text-muted-foreground">Loading…</div>
import { Terms } from './pages/legal/Terms'
import { Disclosures } from './pages/legal/Disclosures'
import { Privacy } from './pages/legal/Privacy'

function Routes() {
  const path = usePath()

  if (matchPath('/legal/terms', path)) return <Terms />
  if (matchPath('/legal/disclosures', path)) return <Disclosures />
  if (matchPath('/legal/privacy', path)) return <Privacy />

  const dtrManage = matchPath('/dtr/:dtrId/manage', path)
  if (dtrManage) {
    return (
      <MergeLayout>
        <MergeParamsContext.Provider value={dtrManage}>
          <ManageDTR />
        </MergeParamsContext.Provider>
      </MergeLayout>
    )
  }

  const dtr = matchPath('/dtr/:dtrId', path)
  const rhAddress = dtr ? rhAddressFromId(dtr.dtrId) : null
  if (rhAddress) {
    return (
      <MergeLayout>
        <Suspense fallback={<Loading />}>
          <RobinhoodReserveDetail address={rhAddress} />
        </Suspense>
      </MergeLayout>
    )
  }
  if (dtr) {
    return (
      <MergeLayout>
        <MergeParamsContext.Provider value={dtr}>
          <DTRDetail />
        </MergeParamsContext.Provider>
      </MergeLayout>
    )
  }

  if (matchPath('/discover', path)) {
    return (
      <MergeLayout>
        <Discover />
      </MergeLayout>
    )
  }
  if (matchPath('/create', path)) {
    return (
      <MergeLayout>
        <CreateReserve />
      </MergeLayout>
    )
  }
  // Old link to the standalone Robinhood page: it is Discover now.
  if (matchPath('/evm', path)) {
    return (
      <MergeLayout>
        <Discover initialChain="robinhood" />
      </MergeLayout>
    )
  }
  if (matchPath('/portfolio', path)) {
    return (
      <MergeLayout>
        <Portfolio />
      </MergeLayout>
    )
  }
  if (matchPath('/manage', path)) {
    return (
      <MergeLayout>
        <Manage />
      </MergeLayout>
    )
  }

  return <Home />
}

export default function App() {
  return (
    <SolanaProviders>
      <WalletSync />
      <ReserveSnapshotHydrator />
      <RealReserveSync />
      <StoreProvider>
        <RouterProvider>
          <Shell>
            <Routes />
          </Shell>
        </RouterProvider>
      </StoreProvider>
    </SolanaProviders>
  )
}
