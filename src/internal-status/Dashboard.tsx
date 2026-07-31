import { useEffect, useMemo, useState } from 'react'
import {
  Blocks,
  Bot,
  CircleDot,
  Cloud,
  FlaskConical,
  FolderGit2,
  GitBranch,
  GitCommit,
  Globe,
  Layers,
  Lock,
  Rocket,
  ScrollText,
  Sparkles,
  Users,
} from 'lucide-react'
import type {
  DecisionEntry,
  EngineeringArea,
  EngineeringTimeline,
  InfraItem,
  Milestone,
  ProjectStatus,
  TimelineEntry,
} from '../../lib/dashboard/parseMarkdown'

interface RepoMetrics {
  generatedAt: string
  repository: {
    remoteUrl: string
    totalCommitsAllBranches: number
    firstCommit: { hash: string; date: string; author: string; subject: string }
    latestCommit: { hash: string; date: string; author: string; subject: string }
    currentBranch: string
    branches: { name: string; remote: boolean; lastCommitDate: string; lastCommitSubject: string }[]
    contributors: { name: string; email: string; commits: number; aiAssisted: boolean }[]
    commitActivity: { date: string; commits: number }[]
  }
  codebase: {
    rustLinesOfCode: number
    typescriptLinesOfCode: number
    protocolInstructionCount: number
    documentationPageCount: number
    decisionLogEntryCount: number
    liveDevnetVerificationScriptCount: number
  }
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: ProjectStatus; decisions: DecisionEntry[]; engineering: EngineeringTimeline; repoMetrics: RepoMetrics }

function statusTone(overallStatus: string): 'up' | 'warn' | 'down' | 'neutral' {
  const s = overallStatus.toLowerCase()
  if (s.includes('on track')) return 'up'
  if (s.includes('at risk')) return 'warn'
  if (s.includes('off track') || s.includes('blocked')) return 'down'
  return 'neutral'
}

function areaTone(status: string): 'up' | 'accent' | 'warn' | 'muted' {
  if (status === 'done') return 'up'
  if (status === 'in_progress') return 'accent'
  if (status === 'not_started') return 'muted'
  return 'warn'
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

const CATEGORY_ICON: Record<string, typeof Sparkles> = {
  product: Sparkles,
  protocol: Blocks,
  frontend: Layers,
  infra: Cloud,
  workflow: Bot,
  testing: FlaskConical,
}

function categoryIcon(category: string) {
  return CATEGORY_ICON[category] ?? CircleDot
}

const INFRA_ICON: Record<string, typeof Sparkles> = {
  Development: Bot,
  'Version Control': FolderGit2,
  Hosting: Cloud,
  Protocol: Blocks,
  'Production Domain': Globe,
  'Simulation Mode': FlaskConical,
  Authentication: Lock,
  Environments: Layers,
}

function infraIcon(label: string) {
  return INFRA_ICON[label] ?? CircleDot
}

function shortHash(hash?: string): string {
  return hash ? hash.slice(0, 7) : ''
}

/** `base` may be either a raw `.git` remote URL or an already-stripped repo URL -- either way, this returns a clickable commit link. */
function commitUrl(base: string, hash?: string): string | null {
  if (!hash) return null
  return `${base.replace(/\.git$/, '')}/commit/${hash}`
}

/** A small radial completion ring -- SVG circle, stroke-dasharray driven by percent. */
function ProgressRing({ percent, tone, size = 64 }: { percent: number; tone: string; size?: number }) {
  const stroke = size >= 100 ? 8 : 5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c - (Math.max(0, Math.min(100, percent)) / 100) * c
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="dash-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={`var(--${tone === 'muted' ? 'text-3' : tone})`}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="dash-ring-fill"
      />
    </svg>
  )
}

function CommitSparkline({ data }: { data: { date: string; commits: number }[] }) {
  if (data.length === 0) return null
  const max = Math.max(...data.map(d => d.commits), 1)
  const w = 100
  const h = 28
  const step = data.length > 1 ? w / (data.length - 1) : 0
  const points = data.map((d, i) => `${i * step},${h - (d.commits / max) * (h - 2)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="dash-sparkline" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diffMs = Date.now() - then
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function Dashboard() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [showFullLog, setShowFullLog] = useState(false)
  const [showOperationalDetail, setShowOperationalDetail] = useState(false)
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
        const data = (await res.json()) as {
          status: ProjectStatus
          decisions: DecisionEntry[]
          engineering: EngineeringTimeline
          repoMetrics: RepoMetrics
        }
        setState({ kind: 'ready', status: data.status, decisions: data.decisions, engineering: data.engineering, repoMetrics: data.repoMetrics })
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

  const { status, decisions, engineering, repoMetrics } = state
  const tone = statusTone(status.overallStatus)
  const visibleDecisions = showFullLog ? decisions : decisions.slice(0, 3)
  const remotePrefix = repoMetrics.repository.remoteUrl.replace(/\.git$/, '')

  return (
    <div className="dash-shell">
      <DashboardBody
        status={status}
        decisions={decisions}
        engineering={engineering}
        repoMetrics={repoMetrics}
        tone={tone}
        visibleDecisions={visibleDecisions}
        showFullLog={showFullLog}
        setShowFullLog={setShowFullLog}
        showOperationalDetail={showOperationalDetail}
        setShowOperationalDetail={setShowOperationalDetail}
        loggingOut={loggingOut}
        logout={logout}
        remotePrefix={remotePrefix}
      />
    </div>
  )
}

function DashboardBody(props: {
  status: ProjectStatus
  decisions: DecisionEntry[]
  engineering: EngineeringTimeline
  repoMetrics: RepoMetrics
  tone: 'up' | 'warn' | 'down' | 'neutral'
  visibleDecisions: DecisionEntry[]
  showFullLog: boolean
  setShowFullLog: (fn: (v: boolean) => boolean) => void
  showOperationalDetail: boolean
  setShowOperationalDetail: (fn: (v: boolean) => boolean) => void
  loggingOut: boolean
  logout: () => void
  remotePrefix: string
}) {
  const {
    status,
    decisions,
    engineering,
    repoMetrics,
    tone,
    visibleDecisions,
    showFullLog,
    setShowFullLog,
    showOperationalDetail,
    setShowOperationalDetail,
    loggingOut,
    logout,
    remotePrefix,
  } = props

  const remainingPercent = useMemo(() => 100 - status.overallCompletionPercent, [status.overallCompletionPercent])
  const recentActivity = engineering.timeline.slice(-4).reverse()

  return (
    <>
      <header className="dash-header dash-fade-in">
        <div className="dash-header-left">
          <div className="dash-hero-ring">
            <ProgressRing percent={status.overallCompletionPercent} tone={tone === 'down' ? 'down' : tone === 'warn' ? 'warn' : 'up'} size={72} />
            <div className="dash-hero-ring-label">{status.overallCompletionPercent}%</div>
          </div>
          <div className="dash-header-meta">
            <div className="dash-header-text">
              <span className={`dash-pill dash-pill-${tone}`}>{status.overallStatus}</span>
              <div className="dash-phase">{status.currentPhase}</div>
              <div className="dash-muted dash-small">Updated {status.lastUpdated}</div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a className="dash-link dash-small" href="/internal/feedback">DevNet Feedback →</a>
          <button type="button" className="dash-btn dash-btn-ghost" onClick={logout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      </header>

      {/* Protocol Roadmap (detail) */}
      <section className="dash-card dash-card-wide dash-fade-in">
        <h2>Protocol Roadmap Detail</h2>
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

      {/* Current Mission */}
      <section className="dash-mission dash-fade-in" style={{ animationDelay: '0.05s' }}>
        <div className="dash-mission-main">
          <div className="dash-mission-kicker">
            <Rocket size={14} /> Current Mission
          </div>
          <p className="dash-mission-objective">{status.currentObjective}</p>
          <div className="dash-mission-facts">
            <div className="dash-mission-fact">
              <span className="dash-muted dash-small">Remaining scope</span>
              <span className="dash-mission-fact-val">~{remainingPercent}%</span>
            </div>
            <div className="dash-mission-fact">
              <span className="dash-muted dash-small">Branch</span>
              <span className="dash-mission-fact-val dash-mono">{repoMetrics.repository.currentBranch}</span>
            </div>
            <div className="dash-mission-fact">
              <span className="dash-muted dash-small">Latest commit</span>
              <a
                className="dash-mission-fact-val dash-mono dash-link"
                href={commitUrl(repoMetrics.repository.remoteUrl, repoMetrics.repository.latestCommit.hash) ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                {shortHash(repoMetrics.repository.latestCommit.hash)}
              </a>
            </div>
            <div className="dash-mission-fact">
              <span className="dash-muted dash-small">Commit landed</span>
              <span className="dash-mission-fact-val">{relativeTime(repoMetrics.repository.latestCommit.date)}</span>
            </div>
          </div>
        </div>
        <div className="dash-mission-side">
          <div className="dash-mission-side-block">
            <div className="dash-mission-side-title">Current blockers</div>
            <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.blockersHtml || '<p>None active.</p>' }} />
          </div>
          <div className="dash-mission-side-block">
            <div className="dash-mission-side-title">Recent activity</div>
            <ul className="dash-activity-list">
              {recentActivity.map((entry, i) => (
                <li key={i}>
                  <span className="dash-activity-date dash-mono dash-small dash-muted">{entry.date.split(' ')[0]}</span>
                  <span className="dash-activity-title">{entry.title}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Engineering Areas */}
      <section className="dash-section dash-fade-in" style={{ animationDelay: '0.1s' }}>
        <h2 className="dash-section-title">Engineering Areas</h2>
        <div className="dash-areas-grid">
          {status.engineeringAreas.map(area => (
            <EngineeringAreaCard key={area.area} area={area} />
          ))}
        </div>
      </section>

      {/* Milestones */}
      <section className="dash-section dash-fade-in" style={{ animationDelay: '0.15s' }}>
        <h2 className="dash-section-title">Milestones</h2>
        <div className="dash-milestones-grid">
          {engineering.milestones.map(m => (
            <MilestoneCard key={m.id} milestone={m} remotePrefix={remotePrefix} />
          ))}
        </div>
      </section>

      {/* Engineering Metrics + Infra */}
      <div className="dash-two-col">
        <section className="dash-section">
          <h2 className="dash-section-title">Engineering Overview</h2>
          <MetricsPanel repoMetrics={repoMetrics} decisionCount={decisions.length} />
        </section>
        <section className="dash-section">
          <h2 className="dash-section-title">Infrastructure</h2>
          <div className="dash-infra-grid">
            {engineering.infra.map(item => (
              <InfraTile key={item.label} item={item} />
            ))}
          </div>
        </section>
      </div>

      {/* Engineering Timeline */}
      <section className="dash-section">
        <h2 className="dash-section-title">Engineering Timeline</h2>
        <EngineeringTimelineView entries={engineering.timeline} remotePrefix={remotePrefix} />
      </section>

      {/* Decision Log */}
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

      {/* Operational detail (collapsed by default) */}
      <section className="dash-card dash-card-wide">
        <div className="dash-card-head">
          <h2>Operational Detail</h2>
          <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setShowOperationalDetail(v => !v)}>
            {showOperationalDetail ? 'Hide' : 'Show'}
          </button>
        </div>
        {showOperationalDetail && (
          <div className="dash-grid">
            <section className="dash-card">
              <h2>Executive Summary</h2>
              <div className="dash-prose dash-small" dangerouslySetInnerHTML={{ __html: status.executiveSummaryHtml }} />
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
          </div>
        )}
      </section>
    </>
  )
}

function EngineeringAreaCard({ area }: { area: EngineeringArea }) {
  const pct = Math.round(area.completion * 100)
  const t = areaTone(area.status)
  return (
    <div className="dash-area-card">
      <div className="dash-area-card-top">
        <ProgressRing percent={pct} tone={t} size={52} />
        <div className="dash-area-card-pct">{pct}%</div>
      </div>
      <div className="dash-area-card-name">{area.area}</div>
      <span className={`dash-pill dash-pill-sm dash-pill-${t}`}>{area.status.replace('_', ' ')}</span>
      <p className="dash-area-card-detail dash-muted dash-small">{area.detail}</p>
    </div>
  )
}

function MilestoneCard({ milestone, remotePrefix }: { milestone: Milestone; remotePrefix: string }) {
  const Icon = categoryIcon(milestone.category)
  const url = milestone.source === 'git' ? commitUrl(remotePrefix, milestone.commit) : null
  return (
    <div className="dash-milestone-card">
      <div className="dash-milestone-icon">
        <Icon size={18} />
      </div>
      <div className="dash-milestone-body">
        <div className="dash-milestone-head">
          <span className="dash-milestone-title">{milestone.title}</span>
          <span className={`dash-tag dash-tag-${milestone.source}`}>{milestone.source === 'git' ? 'verified' : 'manual'}</span>
        </div>
        <p className="dash-milestone-desc dash-muted dash-small">{milestone.description}</p>
        <div className="dash-milestone-foot">
          <span className="dash-muted dash-small">{milestone.date}</span>
          {url && (
            <a className="dash-mono dash-small dash-link" href={url} target="_blank" rel="noreferrer">
              {shortHash(milestone.commit)}
            </a>
          )}
        </div>
        {milestone.note && <p className="dash-milestone-note dash-muted dash-small">{milestone.note}</p>}
      </div>
    </div>
  )
}

function InfraTile({ item }: { item: InfraItem }) {
  const Icon = infraIcon(item.label)
  return (
    <div className="dash-infra-tile">
      <div className="dash-infra-icon">
        <Icon size={16} />
      </div>
      <div className="dash-infra-text">
        <div className="dash-infra-label">{item.label}</div>
        <div className="dash-infra-value">{item.value}</div>
        <div className="dash-infra-detail dash-muted dash-small">{item.detail}</div>
      </div>
    </div>
  )
}

function MetricsPanel({ repoMetrics, decisionCount }: { repoMetrics: RepoMetrics; decisionCount: number }) {
  const { repository, codebase } = repoMetrics
  const tiles: { icon: typeof Sparkles; label: string; value: string }[] = [
    { icon: GitCommit, label: 'Total commits', value: String(repository.totalCommitsAllBranches) },
    { icon: Users, label: 'Contributors', value: String(repository.contributors.length) },
    { icon: GitBranch, label: 'Branches', value: String(repository.branches.length) },
    { icon: ScrollText, label: 'Decision records', value: String(decisionCount) },
    { icon: Layers, label: 'Documentation pages', value: String(codebase.documentationPageCount) },
    { icon: Blocks, label: 'Protocol instructions', value: String(codebase.protocolInstructionCount) },
    { icon: FlaskConical, label: 'Live DevNet verification scripts', value: String(codebase.liveDevnetVerificationScriptCount) },
    { icon: Sparkles, label: 'Rust lines of code', value: codebase.rustLinesOfCode.toLocaleString('en-US') },
    { icon: Sparkles, label: 'TypeScript lines of code', value: codebase.typescriptLinesOfCode.toLocaleString('en-US') },
  ]
  return (
    <div className="dash-card dash-metrics-card">
      <div className="dash-metrics-grid">
        {tiles.map(t => (
          <div key={t.label} className="dash-metric-tile">
            <t.icon size={14} className="dash-muted" />
            <div className="dash-metric-value dash-mono">{t.value}</div>
            <div className="dash-metric-label dash-muted dash-small">{t.label}</div>
          </div>
        ))}
      </div>
      <div className="dash-sparkline-row">
        <div>
          <div className="dash-muted dash-small">Commit activity, project lifetime</div>
          <div className="dash-muted dash-small dash-mono">
            {repository.firstCommit.date.slice(0, 10)} → {repository.latestCommit.date.slice(0, 10)}
          </div>
        </div>
        <CommitSparkline data={repository.commitActivity} />
      </div>
      <div className="dash-contributors">
        {repository.contributors.map(c => (
          <div key={c.email + c.name} className="dash-contributor">
            <span>{c.name}</span>
            {c.aiAssisted && (
              <span className="dash-tag dash-tag-git" title="Commits carry a Claude Co-Authored-By trailer">
                AI-assisted
              </span>
            )}
            <span className="dash-muted dash-small dash-mono">{c.commits}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function EngineeringTimelineView({ entries, remotePrefix }: { entries: TimelineEntry[]; remotePrefix: string }) {
  return (
    <div className="dash-card dash-card-wide dash-timeline-card">
      <div className="dash-timeline">
        {entries.map((entry, i) => {
          const Icon = categoryIcon(entry.category)
          const url = entry.source === 'git' ? commitUrl(remotePrefix, entry.commit) : null
          return (
            <div key={i} className="dash-timeline-row">
              <div className="dash-timeline-rail">
                <div className="dash-timeline-dot">
                  <Icon size={12} />
                </div>
                {i < entries.length - 1 && <div className="dash-timeline-line" />}
              </div>
              <div className="dash-timeline-content">
                <div className="dash-timeline-head">
                  <span className="dash-timeline-title">{entry.title}</span>
                  <span className="dash-muted dash-small dash-mono">{entry.date}</span>
                </div>
                <p className="dash-muted dash-small dash-timeline-desc">{entry.description}</p>
                <div className="dash-timeline-foot">
                  {entry.author && <span className="dash-muted dash-small">{entry.author}</span>}
                  {url && (
                    <a className="dash-mono dash-small dash-link" href={url} target="_blank" rel="noreferrer">
                      {shortHash(entry.commit)}
                    </a>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
