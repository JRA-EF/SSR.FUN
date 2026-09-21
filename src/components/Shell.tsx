import { useEffect, useState, type ReactNode } from 'react'
import { Link, usePath } from '../lib/router'
import { useStore } from '../state/store'
import { useAppStore } from '@/store/useAppStore'
import { WalletModal } from './WalletModal'
import { WalletPanel } from './WalletPanel'
import { AcceptanceModal } from './AcceptanceModal'
import { ReserveSearch } from './ReserveSearch'
import { IS_MAINNET } from '@/lib/solana-config'

const CLUSTER_LABEL = IS_MAINNET ? 'Mainnet' : 'DevNet'

const LINKS = [
  { to: '/discover', label: 'Discover Reserves' },
  { to: '/create', label: 'Launch Reserve' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/manage', label: 'Manage' },
  { to: '/evm', label: 'Robinhood' },
]

type Theme = 'dark' | 'light'

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  )

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    if (next === 'light') document.documentElement.dataset.theme = 'light'
    else delete document.documentElement.dataset.theme
    localStorage.setItem('ssrfun-theme', next)
  }

  return (
    <button
      type="button"
      className="theme-btn"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme === 'dark' ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePath()
  const { toasts } = useStore()
  const { wallet } = useAppStore()
  const walletModalOpen = useAppStore(s => s.walletModalOpen)
  const setWalletModalOpen = useAppStore(s => s.setWalletModalOpen)
  const [walletPanelOpen, setWalletPanelOpen] = useState(false)

  useEffect(() => {
    setWalletPanelOpen(false)
  }, [path])

  return (
    <>
      <a
        href="#main"
        style={{ position: 'absolute', left: -9999, top: 0, zIndex: 100, background: 'var(--surface)', padding: 8 }}
        onFocus={e => {
          e.currentTarget.style.left = '8px'
        }}
        onBlur={e => {
          e.currentTarget.style.left = '-9999px'
        }}
      >
        Skip to content
      </a>

      <header className="nav">
        <div className="container nav-inner">
          <Link to="/" className="nav-logo" ariaLabel="SSR.fun home">
            <img src="/ssr-seal.png" alt="" />
            <span>
              SSR<span className="fun">.FUN</span>
            </span>
          </Link>
          <span
            className="sim-badge"
            title={IS_MAINNET ? 'Connected to the SSR Protocol on Solana Mainnet — real funds, real economic value.' : 'Connected to the SSR Protocol on Solana DevNet — a public test network, not Mainnet. No real economic value.'}
          >
            Solana {CLUSTER_LABEL}
          </span>
          {!IS_MAINNET && (
            <span className="testing-badge" title="Unlisted testing deployment — not indexed or linked publicly.">
              Testing Environment
            </span>
          )}
          <nav className="nav-links" aria-label="Primary">
            {LINKS.map(l => (
              <Link key={l.to} to={l.to} className={`nav-link${path.startsWith(l.to) ? ' active' : ''}`}>
                {l.label}
              </Link>
            ))}
            {/* Public Documentation site: a real path (docs.html via the
                /docs rewrite), not a hash route, so it is a plain anchor. */}
            <a href="/docs" className="nav-link">Docs</a>
          </nav>
          <ReserveSearch />
          <ThemeToggle />
          {wallet.connected ? (
            <div className="wallet-panel-wrap">
              <button
                type="button"
                className="wallet-chip"
                title={`Connected on Solana ${CLUSTER_LABEL} — click for wallet details`}
                aria-haspopup="true"
                aria-expanded={walletPanelOpen}
                onClick={() => setWalletPanelOpen(v => !v)}
              >
                <span className="dot" aria-hidden="true" />
                {wallet.address?.slice(0, 4)}…{wallet.address?.slice(-4)}
              </button>
              <WalletPanel open={walletPanelOpen} onClose={() => setWalletPanelOpen(false)} />
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary nav-cta"
              onClick={() => setWalletModalOpen(true)}
            >
              <span className="cw-full">Connect Wallet</span>
              <span className="cw-short">Connect</span>
            </button>
          )}
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="footer">
        <div className="container footer-grid">
          <div>
            <div className="brand">SSR.fun</div>
            <p>
              A launchpad for tokenized reserves. Create, launch, and trade decentralized tokenized reserves on Solana.
            </p>
            <p style={{ marginTop: 12 }}>
              {IS_MAINNET
                ? 'Connected to the SSR Protocol on Solana Mainnet — real funds, real transactions. Reserve Tokens do not confer ownership of any company. Nothing here is a guarantee of value, liquidity, or performance.'
                : 'Testing interface connected to the SSR Protocol on Solana DevNet — a public test network with no real economic value. Some Reserves and balances shown are still illustrative/mocked. Reserve Tokens do not confer ownership of any company. Nothing here is a guarantee of value, liquidity, or performance.'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 40 }}>
            <div>
              <div style={{ color: 'var(--text-2)', marginBottom: 8, fontWeight: 600 }}>Product</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Link to="/discover" className="faint">Discover Reserves</Link>
                <Link to="/create" className="faint">Launch Reserve</Link>
                <Link to="/portfolio" className="faint">Portfolio</Link>
                <Link to="/manage" className="faint">Reserve Manager</Link>
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-2)', marginBottom: 8, fontWeight: 600 }}>Understand</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Link to="/#how" className="faint">How it works</Link>
                <a href="/docs" className="faint">Documentation</a>
                <Link to="/legal/terms" className="faint">Terms</Link>
                <Link to="/legal/disclosures" className="faint">Disclosures</Link>
                <Link to="/legal/privacy" className="faint">Privacy</Link>
              </div>
            </div>
          </div>
        </div>
      </footer>

      <div className="toasts" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="toast">
            <div className="t">{t.title}</div>
            {t.body && <div className="b">{t.body}</div>}
          </div>
        ))}
      </div>

      <WalletModal open={walletModalOpen} onClose={() => setWalletModalOpen(false)} />
      {/* First-visit Terms acceptance -- suppressed on the legal pages so a
          visitor can read the documents they are being asked to accept. */}
      {!path.startsWith('/legal/') && <AcceptanceModal />}
    </>
  )
}
