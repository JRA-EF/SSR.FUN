import { useEffect, useState } from 'react'
import type { DecisionEntry, ProjectStatus } from '../../lib/dashboard/parseMarkdown'

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; status: ProjectStatus; decisions: DecisionEntry[] }

function statusTone(overallStatus: string): 'up' | 'warn' | 'down' | 'neutral' {
  const s = overallStatus.toLowerCase()
  if (s.includes('on track')) return 'up'
  if (s.includes('at risk')) return 'warn'
  if (s.includes('off track') || s.includes('blocked')) return 'down'
  return 'neutral'
}

function phaseTone(status: string): 'up' | 'accent' | 'muted' {
  if (status === 'done') return 'up'
  if (status === 'in_progress') return 'accent'
  return 'muted'
}

function decisionTone(status: string): 'up' | 'warn' | 'muted' {
  if (status === 'confirmed') return 'up'
  if (status === 'superseded' || status === 'rejected') return 'muted'
  return 'warn'
}

export function Dashboard() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [showFullLog, setShowFullLog] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/dashboard/content', { credentials: 'same-origin' })
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          setState({ kind: 'error', message: 'Your session has expired. Refresh the page to sign in again.' })
          return
        }
        const data = (await res.json()) as { status: ProjectStatus; decisions: DecisionEntry[] }
        setState({ kind: 'ready', status: data.status, decisions: data.decisions })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'Could not reach the dashboard data endpoint.' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  function logout() {
    setLoggingOut(true)
    fetch('/api/dashboard/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => {
      window.location.reload()
    })
  }

  if (state.kind === 'loading') {
    return (
      <div className="dash-shell dash-center">
        <p className="dash-muted">Loading…</p>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="dash-shell dash-center">
        <p className="dash-error">{state.message}</p>
      </div>
    )
  }

  const { status, decisions } = state
  const tone = statusTone(status.overallStatus)
  const visibleDecisions = showFullLog ? decisions : decisions.slice(0, 3)

  return (
    <div className="dash-shell">
      <header className="dash-header">
        <div className="dash-header-left">
          <span className={`dash-pill dash-pill-${tone}`}>{status.overallStatus}</span>
          <div className="dash-header-meta">
            <div className="dash-completion">{status.overallCompletionPercent}%</div>
            <div className="dash-header-text">
              <div className="dash-phase">{status.currentPhase}</div>
              <div className="dash-muted dash-small">Updated {status.lastUpdated}</div>
            </div>
          </div>
        </div>
        <button type="button" className="dash-btn dash-btn-ghost" onClick={logout} disabled={loggingOut}>
          {loggingOut ? 'Signing out…' : 'Log out'}
        </button>
      </header>

      <div className="dash-grid">
        <section className="dash-card dash-card-wide">
          <h2>Current Objective</h2>
          <p className="dash-objective">{status.currentObjective}</p>
        </section>

        <section className="dash-card dash-card-wide">
          <h2>Executive Summary</h2>
          <div className="dash-prose" dangerouslySetInnerHTML={{ __html: status.executiveSummaryHtml }} />
        </section>

        <section className="dash-card dash-card-wide">
          <h2>Roadmap</h2>
          <div className="dash-roadmap">
            {status.roadmap.map(phase => (
              <div key={phase.phase} className="dash-roadmap-row">
                <div className="dash-roadmap-label">
                  <span className="dash-roadmap-num">{phase.phase}</span>
                  <span>{phase.name}</span>
                </div>
                <div className="dash-roadmap-bar-track">
                  <div
                    className={`dash-roadmap-bar-fill dash-tone-${phaseTone(phase.status)}`}
                    style={{ width: `${Math.max(phase.completion * 100, phase.completion > 0 ? 4 : 0)}%` }}
                  />
                </div>
                <span className="dash-roadmap-pct">{Math.round(phase.completion * 100)}%</span>
                <span className="dash-muted dash-small dash-roadmap-weight">wt {phase.weight}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="dash-card">
          <h2>Last 5 Working Days</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.last5DaysHtml }} />
        </section>

        <section className="dash-card">
          <h2>Recently Completed</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.recentlyCompletedHtml }} />
        </section>

        <section className="dash-card">
          <h2>In Progress</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.inProgressHtml }} />
        </section>

        <section className="dash-card">
          <h2>Next Actions</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.nextActionsHtml }} />
        </section>

        <section className="dash-card">
          <h2>Blockers</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.blockersHtml }} />
        </section>

        <section className="dash-card">
          <h2>Dependencies</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.dependenciesHtml }} />
        </section>

        <section className="dash-card">
          <h2>Risks</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.risksHtml }} />
        </section>

        <section className="dash-card">
          <h2>Decisions Required</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.decisionsRequiredHtml }} />
        </section>

        <section className="dash-card">
          <h2>Technical Health</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.technicalHealthHtml }} />
        </section>

        <section className="dash-card">
          <h2>Environments</h2>
          <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.environmentStatusHtml }} />
        </section>

        <section className="dash-card dash-card-wide">
          <div className="dash-card-head">
            <h2>Decision Log</h2>
            {decisions.length > 3 && (
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setShowFullLog(v => !v)}>
                {showFullLog ? 'Show recent only' : `Show full log (${decisions.length})`}
              </button>
            )}
          </div>
          <div className="dash-decisions">
            {visibleDecisions.map(d => (
              <details key={d.id} className="dash-decision">
                <summary>
                  <span className={`dash-pill dash-pill-sm dash-pill-${decisionTone(d.status)}`}>{d.status}</span>
                  <span className="dash-decision-id">DEC-{d.id.replace(/^DEC-/, '')}</span>
                  <span className="dash-decision-title">{d.decision}</span>
                  <span className="dash-muted dash-small dash-decision-date">{d.date}</span>
                </summary>
                <div className="dash-decision-body">
                  <p>
                    <strong>Context.</strong> {d.context}
                  </p>
                  <p>
                    <strong>Rationale.</strong> {d.rationale}
                  </p>
                  {d.alternativesConsidered.length > 0 && (
                    <p>
                      <strong>Alternatives considered.</strong> {d.alternativesConsidered.join('; ')}
                    </p>
                  )}
                  <p>
                    <strong>Impact.</strong> {d.impact}
                  </p>
                  <p>
                    <strong>Affected areas.</strong> {d.affectedAreas.join(', ')}
                  </p>
                  {(d.supersedes || d.supersededBy) && (
                    <p>
                      <strong>Supersession.</strong> {d.supersedes ? `Supersedes ${d.supersedes}. ` : ''}
                      {d.supersededBy ? `Superseded by ${d.supersededBy}.` : ''}
                    </p>
                  )}
                  {d.evidence.length > 0 && (
                    <p>
                      <strong>Evidence.</strong> {d.evidence.join('; ')}
                    </p>
                  )}
                </div>
              </details>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
