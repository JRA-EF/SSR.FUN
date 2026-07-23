import { RouterProvider, matchPath, usePath } from './lib/router'
import { StoreProvider } from './state/store'
import { Shell } from './components/Shell'
import { Home } from './pages/Home'
import { MergeLayout } from './merge/MergeLayout'
import { MergeParamsContext } from './merge/lib/wouter-shim'
import { Discover } from './merge/pages/Discover'
import { CreateDTR } from './merge/pages/CreateDTR'
import { Portfolio } from './merge/pages/Portfolio'
import { Manage } from './merge/pages/Manage'
import { ManageDTR } from './merge/pages/ManageDTR'
import { DTRDetail } from './merge/pages/DTRDetail'

function Routes() {
  const path = usePath()

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
        <CreateDTR />
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
    <StoreProvider>
      <RouterProvider>
        <Shell>
          <Routes />
        </Shell>
      </RouterProvider>
    </StoreProvider>
  )
}
