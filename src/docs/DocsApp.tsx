import { useEffect, useState } from 'react'
import { DOCS, findDoc } from './content'
import { DocLink, docHref, slugFromPath, useDocsPath } from './router'

type Theme = 'dark' | 'light'

/** Same control as the main app's (src/components/Shell.tsx), sharing its localStorage key. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'))
  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    if (next === 'light') document.documentElement.dataset.theme = 'light'
    else delete document.documentElement.dataset.theme
    localStorage.setItem('ssrfun-theme', next)
  }
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <button type="button" className="theme-btn" onClick={toggle} aria-label={label} title={label}>
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

function Header() {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <a href="/" className="nav-logo" aria-label="SSR.fun home">
          <img src="/ssr-seal.png" alt="" />
          <span>
            SSR<span className="fun">.FUN</span>
          </span>
        </a>
        <nav className="docs-nav-links" aria-label="Primary">
          <DocLink to={docHref(null)} className="nav-link active">
            Documentation
          </DocLink>
          <a href="/#/discover" className="nav-link">
            Discover Reserves
          </a>
          <a href="/#/create" className="nav-link">
            Launch Reserve
          </a>
        </nav>
        <ThemeToggle />
        <a href="/" className="btn btn-primary nav-cta">
          Open SSR.fun
        </a>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-grid">
        <div>
          <div className="brand">SSR.fun</div>
          <p>A launchpad for tokenized reserves. Create, launch, and trade decentralized tokenized reserves on Solana.</p>
          <p style={{ marginTop: 12 }}>
            Reserve Tokens do not confer ownership of any company. Nothing here is a guarantee of value, liquidity, or
            performance.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 40 }}>
          <div>
            <div className="footer-col-title">Documentation</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {DOCS.map(d => (
                <DocLink key={d.slug} to={docHref(d.slug)} className="faint">
                  {d.title}
                </DocLink>
              ))}
            </div>
          </div>
          <div>
            <div className="footer-col-title">SSR.fun</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <a href="/#/discover" className="faint">Discover Reserves</a>
              <a href="/#/create" className="faint">Launch Reserve</a>
              <a href="/#/legal/terms" className="faint">Terms</a>
              <a href="/#/legal/disclosures" className="faint">Disclosures</a>
              <a href="/#/legal/privacy" className="faint">Privacy</a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}

function Sidebar({ current }: { current: string | null }) {
  return (
    <nav className="docs-side" aria-label="Documentation pages">
      <DocLink to={docHref(null)} className={`docs-side-link${current === null ? ' active' : ''}`} ariaCurrent={current === null ? 'page' : undefined}>
        All documentation
      </DocLink>
      {DOCS.map(d => (
        <DocLink
          key={d.slug}
          to={docHref(d.slug)}
          className={`docs-side-link${current === d.slug ? ' active' : ''}`}
          ariaCurrent={current === d.slug ? 'page' : undefined}
        >
          {d.title}
        </DocLink>
      ))}
    </nav>
  )
}

function IndexPage() {
  return (
    <article className="doc-article">
      <div className="eyebrow">Documentation</div>
      <h1>SSR.fun Documentation</h1>
      <p className="doc-lede">
        Plain-language guides to Reserves and Reserve Tokens, with code where it helps. Pick a topic, then use the tabs
        inside each page to jump to the part you need.
      </p>
      <div className="docs-index-grid">
        {DOCS.map(d => (
          <DocLink key={d.slug} to={docHref(d.slug)} className="docs-index-card">
            <span className="eyebrow">{d.audience}</span>
            <span className="docs-index-title">{d.title}</span>
            <span className="docs-index-blurb">{d.blurb}</span>
          </DocLink>
        ))}
      </div>
    </article>
  )
}

function DocPage({ slug }: { slug: string }) {
  const doc = findDoc(slug)
  if (!doc) {
    return (
      <article className="doc-article">
        <div className="eyebrow">Documentation</div>
        <h1>Page not found</h1>
        <p className="doc-lede">
          There is no document at this address. <DocLink to={docHref(null)}>See all documentation</DocLink>.
        </p>
      </article>
    )
  }
  return (
    <article className="doc-article">
      <div className="eyebrow">{doc.audience}</div>
      <h1>{doc.title}</h1>
      <p className="doc-lede">{doc.blurb}</p>
      <p className="doc-updated">Last updated: {doc.updated}</p>
      {/* key: remount the tab set per document so the ?tab= state is re-read for the new page. */}
      <div key={doc.slug}>{doc.render()}</div>
    </article>
  )
}

export function DocsApp() {
  const path = useDocsPath()
  const slug = slugFromPath(path)
  const doc = findDoc(slug)

  useEffect(() => {
    document.title = doc ? `${doc.title} · SSR.fun Documentation` : 'SSR.fun Documentation'
  }, [doc])

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
      <Header />
      <main id="main" className="docs-page">
        <div className="container docs-layout">
          <Sidebar current={doc ? doc.slug : slug ? '__missing__' : null} />
          {slug === null ? <IndexPage /> : <DocPage slug={slug} />}
        </div>
      </main>
      <Footer />
    </>
  )
}
