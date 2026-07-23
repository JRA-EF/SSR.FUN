import { RouterProvider, matchPath, usePath } from './lib/router'
import { StoreProvider } from './state/store'
import { Shell } from './components/Shell'
import { Home } from './pages/Home'
import { Discover } from './pages/Discover'
import { ReserveDetail } from './pages/ReserveDetail'
import { Create } from './pages/Create'
import { Portfolio } from './pages/Portfolio'
import { Manage } from './pages/Manage'

function Routes() {
  const path = usePath()
  const reserve = matchPath('/reserve/:address', path)
  if (reserve) return <ReserveDetail address={reserve.address} />
  if (matchPath('/discover', path)) return <Discover />
  if (matchPath('/create', path)) return <Create />
  if (matchPath('/portfolio', path)) return <Portfolio />
  if (matchPath('/manage', path)) return <Manage />
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
