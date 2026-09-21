import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'

/**
 * Minimal path router for the Documentation site. Unlike the main app's
 * hash router (src/lib/router.tsx), docs use real paths (/docs/<slug>) so a
 * link can be shared with anyone (e.g. a DEX team) and served by the
 * /docs rewrite in vercel.json without the closed-beta gate.
 */

const DOCS_BASE = '/docs'

export function useDocsPath(): string {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onChange)
    return () => window.removeEventListener('popstate', onChange)
  }, [])
  return path
}

/** Client-side navigation: pushes a new history entry and notifies the router. */
export function navigateTo(href: string) {
  window.history.pushState(null, '', href)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo(0, 0)
}

/** "/docs" | "/docs/" | "/docs.html" -> null (index); "/docs/foo/" -> "foo". */
export function slugFromPath(path: string): string | null {
  let p = path
  if (p.endsWith('.html')) p = p.slice(0, -'.html'.length)
  if (!p.startsWith(DOCS_BASE)) return null
  p = p.slice(DOCS_BASE.length).replace(/^\/+|\/+$/g, '')
  return p ? decodeURIComponent(p) : null
}

export function docHref(slug: string | null, tab?: string): string {
  const base = slug ? `${DOCS_BASE}/${slug}` : DOCS_BASE
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base
}

/** In-site link: same-tab plain clicks are handled client-side, everything else falls back to the browser. */
export function DocLink({
  to,
  children,
  className,
  ariaCurrent,
}: {
  to: string
  children: ReactNode
  className?: string
  ariaCurrent?: 'page'
}) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigateTo(to)
  }
  return (
    <a href={to} className={className} aria-current={ariaCurrent} onClick={onClick}>
      {children}
    </a>
  )
}
