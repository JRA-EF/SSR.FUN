import { createContext, forwardRef, useContext, type AnchorHTMLAttributes } from 'react'
import { navigate, usePath } from '../../lib/router'

/**
 * Minimal wouter-API-compatible shim backed by FABLE's own hash router
 * (../../lib/router). The copied MERGE pages (CreateDTR/ManageDTR/DTRDetail/
 * Portfolio) import from "wouter" unmodified; vite.config.ts aliases that
 * bare specifier to this file so the whole app keeps a single router
 * mechanism instead of running two routers side by side.
 */

export const MergeParamsContext = createContext<Record<string, string>>({})

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useContext(MergeParamsContext) as T
}

export function useLocation(): [string, (to: string) => void] {
  return [usePath(), navigate]
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, onClick, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      href={`#${href}`}
      {...rest}
      onClick={(e) => {
        onClick?.(e)
      }}
    />
  )
})
