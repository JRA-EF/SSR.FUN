import type { ReactNode } from 'react'
import { Link } from '../../lib/router'

/**
 * Shared layout for the legal pages (/legal/terms, /legal/disclosures,
 * /legal/privacy). Native design system (src/index.css tokens) per the UI
 * baseline; content is authored as TSX in the sibling files. The acceptance
 * modal (src/components/AcceptanceModal.tsx) is deliberately suppressed on
 * these routes so a first-time visitor can read what they are accepting.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="legal-page">
      <div className="container">
        <nav className="legal-nav" aria-label="Legal documents">
          <Link to="/legal/terms" className="faint">Terms of Use</Link>
          <span aria-hidden="true">·</span>
          <Link to="/legal/disclosures" className="faint">Disclosures</Link>
          <span aria-hidden="true">·</span>
          <Link to="/legal/privacy" className="faint">Privacy Policy</Link>
        </nav>
        <h1>{title}</h1>
        <p className="legal-updated">Last updated: {updated}</p>
        {children}
      </div>
    </div>
  )
}
