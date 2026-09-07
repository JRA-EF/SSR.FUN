import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

/**
 * First-visit acceptance modal (see docs/project/DECISION_LOG.md's entry for
 * the legal-framework pass). Shown once per browser, before first use of the
 * interface: requires an affirmative checkbox before Continue enables, links
 * to the three legal pages, and records acceptance under a single
 * localStorage flag -- deliberately no versioning system. Suppressed on the
 * /legal/* routes (Shell.tsx) so a first-time visitor can read the documents
 * they are being asked to accept. No wallet signature is involved.
 */
const ACCEPT_KEY = 'ssrfun-terms-accepted'

function hasAcceptedTerms(): boolean {
  try {
    return localStorage.getItem(ACCEPT_KEY) === '1'
  } catch {
    // Storage unavailable: still ask, and fall back to session-only
    // acceptance below so the modal never becomes an un-dismissable loop.
    return false
  }
}

export function AcceptanceModal() {
  const [accepted, setAccepted] = useState(hasAcceptedTerms)
  const [checked, setChecked] = useState(false)
  const [declined, setDeclined] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!accepted) dialogRef.current?.focus()
  }, [accepted])

  if (accepted) return null

  function onContinue() {
    try {
      localStorage.setItem(ACCEPT_KEY, '1')
    } catch {
      // Persistence unavailable -- acceptance still holds for this session.
    }
    setAccepted(true)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      setDeclined(true)
      return
    }
    if (e.key !== 'Tab') return
    // Keep keyboard focus inside the dialog while it is open.
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input',
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-scrim accept-scrim">
      <div
        ref={dialogRef}
        className="modal accept-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="accept-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h3 id="accept-title">Before you continue</h3>
        <p className="accept-body">
          SSR.FUN is an interface to experimental blockchain software on Solana. Transactions are irreversible, and
          you can lose the funds you commit.
        </p>
        <p className="accept-body">
          Please review the{' '}
          <a href="#/legal/terms" target="_blank" rel="noopener noreferrer">Terms of Use</a>,{' '}
          <a href="#/legal/disclosures" target="_blank" rel="noopener noreferrer">Disclosures</a>, and{' '}
          <a href="#/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
        </p>
        <label className="accept-check">
          <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />
          <span>I have read and agree to the Terms of Use and acknowledge the Disclosures.</span>
        </label>
        <div className="accept-actions">
          <button type="button" className="btn btn-primary" disabled={!checked} onClick={onContinue}>
            Continue
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setDeclined(true)}>
            Decline
          </button>
        </div>
        {declined && (
          <p className="accept-declined" role="status">
            You need to accept the Terms to use this interface.
          </p>
        )}
      </div>
    </div>
  )
}
