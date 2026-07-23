import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'

/** Minimal hash router. Routes look like #/discover, #/reserve/:address, #/create … */

function parseHash(): string {
  const h = window.location.hash
  if (!h || h === '#') return '/'
  return h.startsWith('#') ? h.slice(1) : h
}

const RouteContext = createContext<string>('/')

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(parseHash)
  useEffect(() => {
    const onChange = () => {
      setPath(parseHash())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return <RouteContext.Provider value={path}>{children}</RouteContext.Provider>
}

export function usePath(): string {
  return useContext(RouteContext)
}

export function navigate(to: string) {
  window.location.hash = to
}

/** Match "/reserve/:address" against the current path. Returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const a = path.split('?')[0].split('/').filter(Boolean)
  if (p.length !== a.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i])
    else if (p[i] !== a[i]) return null
  }
  return params
}

export function Link({
  to,
  children,
  className,
  style,
  onClick,
  ariaLabel,
}: {
  to: string
  children: ReactNode
  className?: string
  style?: CSSProperties
  onClick?: () => void
  ariaLabel?: string
}) {
  return (
    <a
      href={`#${to}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      onClick={() => {
        onClick?.()
      }}
    >
      {children}
    </a>
  )
}
