// Team feedback board: every submission from the public /feedback form, in
// columns by status and sorted by priority. People move items, set priority,
// and start or stop the fixer agent here; the agent moves items with
// `feedback-daemon.py --board`. Everything is kept in each item's history.
// Data + auth: api/feedback/board.ts (same SSR_DASHBOARD_PASSWORD login as
// /internal/status, enforced by middleware before this page loads).
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BOARD_STATUSES,
  BOARD_STATUS_LABELS,
  DEFAULT_VISIBLE_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  agentSummary,
  compareForColumn,
  isBoardStatus,
  isPriority,
  latestNote,
  type AgentAction,
  type BoardPriority,
  type BoardStatus,
} from '../../lib/agent-feedback/boardPure'

interface HistoryEntry {
  at: string
  actor: string | null
  kind: string
  from: string | null
  to: string | null
  note: string | null
}

interface AgentRequest {
  id: number
  action: AgentAction
  state: 'new' | 'claimed' | 'done' | 'failed'
  requestedBy: string | null
  requestedAt: string
  doneAt: string | null
  result: string | null
}

interface BoardItem {
  id: string
  createdAt: string
  category: string
  message: string
  contact: string | null
  pageUrl: string | null
  status: string
  handledBy: string | null
  resolution: string | null
  boardStatus: BoardStatus
  priority: BoardPriority
  boardUpdatedAt: string | null
  boardUpdatedBy: string | null
  history: HistoryEntry[]
  agentRequest: AgentRequest | null
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' }
type Change = { status?: BoardStatus; priority?: BoardPriority; note?: string } | { action: AgentAction; note?: string }

const VISIBLE_KEY = 'ssr.feedbackBoard.visible'
const ACTOR_KEY = 'ssr.feedbackBoard.actor'
const REFRESH_MS = 30_000
// While a start/stop is waiting for the Mac daemon, poll faster so the card updates promptly.
const FAST_REFRESH_MS = 5_000

function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (parse(raw) ?? fallback)
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage blocked (private mode): the choice just isn't remembered.
  }
}

function ago(iso: string | null): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function statusLabel(s: string | null): string {
  return isBoardStatus(s) ? BOARD_STATUS_LABELS[s] : (s ?? '')
}

function priorityLabel(p: string | null): string {
  return isPriority(p) ? PRIORITY_LABELS[p] : (p ?? '')
}

function historyLine(h: HistoryEntry): string {
  switch (h.kind) {
    case 'status':
      return h.from && h.from !== h.to ? `${statusLabel(h.from)} → ${statusLabel(h.to)}` : statusLabel(h.to)
    case 'priority':
      return `Priority ${priorityLabel(h.from)} → ${priorityLabel(h.to)}`
    case 'agent_start':
      return 'Asked the fixer agent to start'
    case 'agent_stop':
      return 'Asked the fixer agent to stop'
    case 'agent_result':
      return 'Fixer agent'
    default:
      return 'Note'
  }
}

function isPending(r: AgentRequest | null): boolean {
  return !!r && (r.state === 'new' || r.state === 'claimed')
}

/** Only http(s) links from user-submitted page URLs become clickable. */
function safeHref(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

function shortPage(url: string): string {
  try {
    const u = new URL(url)
    return u.host + u.pathname
  } catch {
    return url
  }
}

function StatusSelect({ value, disabled, onChange, label }: { value: BoardStatus; disabled?: boolean; onChange: (s: BoardStatus) => void; label: string }) {
  return (
    <select
      aria-label={label}
      className="fbb-input fbb-input-sm"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (isBoardStatus(e.target.value)) onChange(e.target.value)
      }}
    >
      {BOARD_STATUSES.map((s) => (
        <option key={s} value={s}>
          {BOARD_STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  )
}

function PrioritySelect({ value, disabled, onChange, label }: { value: BoardPriority; disabled?: boolean; onChange: (p: BoardPriority) => void; label: string }) {
  return (
    <select
      aria-label={label}
      className={`fbb-input fbb-input-sm fbb-prio-select-${value}`}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (isPriority(e.target.value)) onChange(e.target.value)
      }}
    >
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {PRIORITY_LABELS[p]}
        </option>
      ))}
    </select>
  )
}

function AgentPanel({ item, saving, onChange }: { item: BoardItem; saving: boolean; onChange: (item: BoardItem, change: Change) => Promise<boolean> }) {
  const [note, setNote] = useState('')
  const req = item.agentRequest
  const pending = isPending(req)
  const startWaiting = pending && req?.action === 'start'
  const stopWaiting = pending && req?.action === 'stop'
  const canStop = !!req && req.action === 'start' && req.state !== 'failed'

  const send = (action: AgentAction) =>
    void onChange(item, { action, note: note.trim() || undefined }).then((ok) => {
      if (ok) setNote('')
    })

  let status = 'Not started from the board yet.'
  if (req) {
    const who = req.requestedBy ?? 'someone'
    if (pending) status = `${agentSummary(req)} by ${who} ${ago(req.requestedAt)}. Waiting for the Mac daemon to deliver it.`
    else if (req.state === 'failed') status = `${agentSummary(req)} ${ago(req.doneAt)}: ${req.result ?? 'no reason given'}`
    else status = `${agentSummary(req)} by ${who} ${ago(req.doneAt)}.`
  }

  return (
    <div className="fbb-block fbb-agent">
      <div className="fbb-label">Fixer agent</div>
      <p className={`fbb-small fbb-prose${req?.state === 'failed' ? ' fbb-error' : ''}`} role="status">
        {status}
      </p>
      <input
        className="fbb-input fbb-input-sm"
        aria-label="Instruction for the fixer agent"
        placeholder="Instruction for the agent (optional)"
        maxLength={2000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="fbb-move-row">
        <button type="button" className="fbb-btn fbb-btn-primary" disabled={saving || startWaiting} onClick={() => send('start')}>
          {startWaiting ? 'Start queued' : req?.action === 'start' && req.state === 'done' ? 'Start again' : 'Start agent'}
        </button>
        <button type="button" className="fbb-btn fbb-btn-danger" disabled={saving || !canStop || stopWaiting} onClick={() => send('stop')}>
          {stopWaiting ? 'Stop queued' : 'Stop agent'}
        </button>
      </div>
    </div>
  )
}

function Card({
  item,
  open,
  saving,
  onToggle,
  onChange,
}: {
  item: BoardItem
  open: boolean
  saving: boolean
  onToggle: () => void
  onChange: (item: BoardItem, change: Change) => Promise<boolean>
}) {
  const [note, setNote] = useState('')
  const [target, setTarget] = useState<BoardStatus | null>(null)
  const chosen = target ?? item.boardStatus
  const lastNote = latestNote(item.history)
  const href = safeHref(item.pageUrl)
  const agent = agentSummary(item.agentRequest)

  return (
    <article className={`fbb-card fbb-card-prio-${item.priority}${open ? ' fbb-card-open' : ''}`}>
      <button type="button" className="fbb-card-head" onClick={onToggle} aria-expanded={open}>
        <span className="fbb-card-meta">
          <span className="fbb-tags">
            {item.priority !== 'normal' && <span className={`fbb-tag fbb-prio-${item.priority}`}>{PRIORITY_LABELS[item.priority]}</span>}
            <span className="fbb-tag">{item.category}</span>
            {agent && <span className={`fbb-tag fbb-agent-tag${isPending(item.agentRequest) ? ' fbb-agent-pending' : ''}`}>{agent}</span>}
          </span>
          <span className="fbb-muted fbb-small" title={new Date(item.createdAt).toLocaleString()}>
            {ago(item.createdAt)}
          </span>
        </span>
        <span className={`fbb-card-msg${open ? '' : ' fbb-clamp'}`}>{item.message}</span>
        {!open && lastNote && <span className="fbb-card-note fbb-clamp-1">Note: {lastNote}</span>}
      </button>

      <div className="fbb-card-foot">
        <span className="fbb-muted fbb-small fbb-ellipsis">{item.contact || 'anonymous'}</span>
        <span className="fbb-foot-controls">
          <PrioritySelect label="Priority" value={item.priority} disabled={saving} onChange={(p) => void onChange(item, { priority: p })} />
          {!open && <StatusSelect label="Move to" value={item.boardStatus} disabled={saving} onChange={(s) => void onChange(item, { status: s })} />}
        </span>
      </div>

      {open && (
        <div className="fbb-card-body">
          <dl className="fbb-facts">
            <dt>Page</dt>
            <dd>
              {href ? (
                <a className="fbb-link" href={href} target="_blank" rel="noreferrer">
                  {shortPage(href)}
                </a>
              ) : (
                item.pageUrl || '—'
              )}
            </dd>
            <dt>Submitted</dt>
            <dd>{new Date(item.createdAt).toLocaleString()}</dd>
            <dt>Telegram</dt>
            <dd>
              {item.status}
              {item.handledBy ? ` by ${item.handledBy}` : ''}
            </dd>
            <dt>Id</dt>
            <dd className="fbb-mono">{item.id}</dd>
          </dl>

          <AgentPanel item={item} saving={saving} onChange={onChange} />

          {item.resolution && (
            <div className="fbb-block">
              <div className="fbb-label">Fixer agent's conclusion</div>
              <p className="fbb-prose fbb-small">{item.resolution}</p>
            </div>
          )}

          <form
            className="fbb-move"
            onSubmit={(e) => {
              e.preventDefault()
              const change = chosen !== item.boardStatus ? { status: chosen, note: note.trim() || undefined } : { note: note.trim() }
              void onChange(item, change).then((ok) => {
                if (ok) {
                  setNote('')
                  setTarget(null)
                }
              })
            }}
          >
            <label className="fbb-label" htmlFor={`note-${item.id}`}>
              Move or add a note
            </label>
            <textarea
              id={`note-${item.id}`}
              className="fbb-input"
              rows={2}
              maxLength={2000}
              placeholder="What changed, or what it is blocked on"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="fbb-move-row">
              <StatusSelect label="New status" value={chosen} disabled={saving} onChange={setTarget} />
              <button type="submit" className="fbb-btn fbb-btn-ghost" disabled={saving || (chosen === item.boardStatus && !note.trim())}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>

          <div className="fbb-block">
            <div className="fbb-label">History</div>
            {item.history.length === 0 ? (
              <p className="fbb-muted fbb-small">Nothing yet.</p>
            ) : (
              <ol className="fbb-history">
                {[...item.history].reverse().map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <div className="fbb-small">
                      {historyLine(h)}
                      <span className="fbb-muted"> · {h.actor ?? 'unknown'} · {ago(h.at)}</span>
                    </div>
                    {h.note && <p className="fbb-small fbb-prose">{h.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </article>
  )
}

export function Board() {
  const [items, setItems] = useState<BoardItem[]>([])
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [visible, setVisible] = useState<BoardStatus[]>(() =>
    readStored(VISIBLE_KEY, DEFAULT_VISIBLE_STATUSES, (raw) => {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? BOARD_STATUSES.filter((s) => parsed.includes(s)) : null
    }),
  )
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | BoardPriority>('all')
  const [actor, setActor] = useState(() => readStored(ACTOR_KEY, '', (raw) => raw))
  const [openId, setOpenId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/feedback/board', { credentials: 'same-origin' })
      if (res.status === 401) {
        setLoad({ kind: 'error', message: 'Your session has expired. Reload the page to sign in again.' })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { items: BoardItem[] }
      setItems(body.items)
      setLoad({ kind: 'ready' })
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'network error'
      setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', message: `Could not load the board (${reason}).` }))
      setNotice(`Refresh failed (${reason}). Showing the last loaded data.`)
    }
  }, [])

  const anyPending = items.some((it) => isPending(it.agentRequest))
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), anyPending ? FAST_REFRESH_MS : REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refresh, anyPending])

  const setVisibleAndStore = (next: BoardStatus[]) => {
    setVisible(next)
    writeStored(VISIBLE_KEY, JSON.stringify(next))
  }
  const toggleStatus = (s: BoardStatus) =>
    setVisibleAndStore(visible.includes(s) ? visible.filter((x) => x !== s) : BOARD_STATUSES.filter((x) => x === s || visible.includes(x)))

  const categories = useMemo(() => [...new Set(items.map((it) => it.category))].sort(), [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items
      .filter((it) => {
        if (category !== 'all' && it.category !== category) return false
        if (priorityFilter !== 'all' && it.priority !== priorityFilter) return false
        if (!q) return true
        return [it.message, it.contact, it.pageUrl, it.id, it.resolution, latestNote(it.history)].some(
          (field) => field && field.toLowerCase().includes(q),
        )
      })
      .sort(compareForColumn)
  }, [items, query, category, priorityFilter])

  const counts = useMemo(() => {
    const c = Object.fromEntries(BOARD_STATUSES.map((s) => [s, 0])) as Record<BoardStatus, number>
    for (const it of filtered) c[it.boardStatus] += 1
    return c
  }, [filtered])

  const isDefaultView =
    !query &&
    category === 'all' &&
    priorityFilter === 'all' &&
    visible.length === DEFAULT_VISIBLE_STATUSES.length &&
    DEFAULT_VISIBLE_STATUSES.every((s) => visible.includes(s))
  const shownCount = filtered.filter((it) => visible.includes(it.boardStatus)).length
  const csvHref = `/api/feedback/board?format=csv&statuses=${encodeURIComponent(visible.join(','))}`

  const change = async (item: BoardItem, c: Change): Promise<boolean> => {
    setSavingId(item.id)
    setNotice(null)
    if (!('action' in c)) {
      setItems((cur) =>
        cur.map((it) => (it.id === item.id ? { ...it, boardStatus: c.status ?? it.boardStatus, priority: c.priority ?? it.priority } : it)),
      )
    }
    try {
      const res = await fetch('/api/feedback/board', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, ...c, actor: actor.trim() || undefined }),
      })
      const body = (await res.json().catch(() => ({}))) as { item?: BoardItem; error?: string; queued?: boolean }
      if (!res.ok || !body.item) throw new Error(body.error ?? `HTTP ${res.status}`)
      const updated = body.item
      setItems((cur) => cur.map((it) => (it.id === updated.id ? updated : it)))
      if ('action' in c && body.queued === false) setNotice(`A ${c.action} request for this item is already waiting for the daemon.`)
      else if ('status' in c && c.status && !visible.includes(c.status)) setNotice(`Moved to ${BOARD_STATUS_LABELS[c.status]}, which your filters are hiding.`)
      return true
    } catch (e) {
      setItems((cur) => cur.map((it) => (it.id === item.id ? item : it)))
      setNotice(`Could not save: ${e instanceof Error ? e.message : 'network error'}.`)
      return false
    } finally {
      setSavingId(null)
    }
  }

  if (load.kind === 'loading') {
    return (
      <div className="fbb-shell fbb-center">
        <p className="fbb-muted">Loading…</p>
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <div className="fbb-shell fbb-center">
        <p className="fbb-error">{load.message}</p>
      </div>
    )
  }

  return (
    <div className="fbb-shell">
      <header className="fbb-header">
        <div className="fbb-header-text">
          <h1>Feedback board</h1>
          <p className="fbb-muted fbb-small">
            Every submission from the feedback form. Set priority, move items, and start or stop the fixer agent. Changes are saved with your name
            in each item's history.
          </p>
        </div>
        <div className="fbb-header-actions">
          <a className="fbb-btn fbb-btn-ghost" href={csvHref}>
            Export CSV
          </a>
          <button type="button" className="fbb-btn fbb-btn-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      <section className="fbb-toolbar" aria-label="Filters">
        <input
          type="search"
          className="fbb-input fbb-search"
          placeholder="Search message, contact, page, note, id"
          aria-label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="fbb-input" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="fbb-input"
          aria-label="Priority"
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(isPriority(e.target.value) ? e.target.value : 'all')}
        >
          <option value="all">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <input
          className="fbb-input fbb-actor"
          aria-label="Your name, shown in history"
          placeholder="Your name (shown in history)"
          maxLength={60}
          value={actor}
          onChange={(e) => {
            setActor(e.target.value)
            writeStored(ACTOR_KEY, e.target.value)
          }}
        />
      </section>

      <div className="fbb-chips" role="group" aria-label="Statuses to show">
        {BOARD_STATUSES.map((s) => (
          <button key={s} type="button" className="fbb-chip" aria-pressed={visible.includes(s)} onClick={() => toggleStatus(s)}>
            <span className={`fbb-dot fbb-dot-${s}`} aria-hidden="true" />
            {BOARD_STATUS_LABELS[s]}
            <span className="fbb-chip-count">{counts[s]}</span>
          </button>
        ))}
        <span className="fbb-muted fbb-small fbb-shown">
          Showing {shownCount} of {items.length}
        </span>
        {!isDefaultView && (
          <button
            type="button"
            className="fbb-link-btn fbb-small"
            onClick={() => {
              setVisibleAndStore([...DEFAULT_VISIBLE_STATUSES])
              setQuery('')
              setCategory('all')
              setPriorityFilter('all')
            }}
          >
            Reset filters
          </button>
        )}
      </div>

      {notice && (
        <p className="fbb-notice" role="status">
          {notice}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="fbb-muted">No statuses selected. Pick one above.</p>
      ) : (
        <div className="fbb-columns">
          {visible.map((s) => {
            const column = filtered.filter((it) => it.boardStatus === s)
            return (
              <section key={s} className="fbb-column" aria-label={BOARD_STATUS_LABELS[s]}>
                <h2 className="fbb-column-title">
                  <span className={`fbb-dot fbb-dot-${s}`} aria-hidden="true" />
                  {BOARD_STATUS_LABELS[s]}
                  <span className="fbb-muted">{column.length}</span>
                </h2>
                {column.length === 0 ? (
                  <p className="fbb-empty">Nothing here.</p>
                ) : (
                  column.map((it) => (
                    <Card
                      key={it.id}
                      item={it}
                      open={openId === it.id}
                      saving={savingId === it.id}
                      onToggle={() => setOpenId(openId === it.id ? null : it.id)}
                      onChange={change}
                    />
                  ))
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
