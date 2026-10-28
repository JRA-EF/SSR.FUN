// Command center (/internal/commandcenter, DEC-0264): the shape the page
// renders and the pure rules that turn raw probe results into a status per
// integration. No I/O here; lib/command-center/probes.ts gathers the inputs.
//
// Every value describes PRODUCTION (ssr.fun). Secret VALUES never appear in
// this model: a key is reported by name, age and whether its service answers.

export type Tone = 'ok' | 'warn' | 'down' | 'unknown'

export interface Metric { label: string; value: string; tone?: Tone }

/** A titled list in the drawer (open feedback, unreviewed alerts, unpushed commits, wallet tokens). */
export interface ListItem { primary: string; secondary?: string; tone?: Tone; url?: string }
export interface DrawerList { title: string; items: ListItem[]; empty?: string; note?: string }
export interface Link { label: string; url: string }

export interface SecretInfo {
  name: string
  /** Days since the value was last set on the ssr-fun project; null when Vercel is not connected. */
  ageDays: number | null
  rotateAfterDays: number
  tone: Tone
}

export interface Renewal {
  nodeId: string
  label: string
  /** ISO date (YYYY-MM-DD). */
  date: string
  source: 'live' | 'manual'
  amount?: string | null
}

/** Facts no API exposes (plan, renewal date, which login owns it), edited on the page and kept in Neon. Never secrets. */
export interface ManualFacts {
  plan?: string
  cost?: string
  renewsOn?: string
  account?: string
  notes?: string
  updatedAt?: string
}

export type NodeKind = 'hub' | 'service' | 'chain' | 'wallet' | 'domain'

export interface CcNode {
  id: string
  label: string
  kind: NodeKind
  status: Tone
  /** One short line under the label, e.g. "142 ms" or "0.84 SOL". */
  headline: string
  /** What breaks for users if this fails. */
  impact: string
  problems: string[]
  metrics: Metric[]
  keys: SecretInfo[]
  links: Link[]
  manual: ManualFacts
  /** Whether the page offers the plan/renewal editor for this node. */
  editable: boolean
  lists: DrawerList[]
  /** USDC value of a wallet (SOL and tokens at live prices); null for non-wallets or when unpriced. */
  usd: number | null
}

export interface CcEdge { from: string; to: string; label: string }

/** Something to keep an eye on: a live problem, an open decision-log item, or a note the team added. */
export interface WatchItem {
  id: string
  text: string
  tone: Tone
  source: 'live' | 'decision' | 'team'
  nodeId?: string
  detail?: string
}

export interface CommandCenterState {
  generatedAt: string
  source: 'ssr.fun'
  nodes: CcNode[]
  watch: WatchItem[]
  walletsUsd: number | null
  edges: CcEdge[]
  renewals: Renewal[]
  burn: BurnRate
  summary: { ok: number; warn: number; down: number; unknown: number }
  alerts: { last24h: Record<string, number>; recent: { at: string; source: string; step: string; message: string }[] } | null
}

const RANK: Record<Tone, number> = { ok: 0, unknown: 1, warn: 2, down: 3 }

export function worst(...tones: Tone[]): Tone {
  return tones.reduce<Tone>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok')
}

export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / 86_400_000)
}

/** Days until an ISO date (negative once it has passed). */
export function daysUntil(isoDate: string, nowMs: number): number {
  return Math.ceil((Date.parse(isoDate) - nowMs) / 86_400_000)
}

/** A renewal or expiry: overdue is down, within `warnDays` is warn. */
export function renewalTone(days: number, warnDays: number): Tone {
  if (days < 0) return 'down'
  return days <= warnDays ? 'warn' : 'ok'
}

export function solTone(sol: number | null, downBelow: number, warnBelow: number): Tone {
  if (sol === null) return 'unknown'
  if (sol < downBelow) return 'down'
  return sol < warnBelow ? 'warn' : 'ok'
}

export function latencyTone(ms: number | null, warnAbove: number): Tone {
  if (ms === null) return 'down'
  return ms > warnAbove ? 'warn' : 'ok'
}

export function secretTone(ageDays: number | null, rotateAfterDays: number): Tone {
  if (ageDays === null) return 'unknown'
  return ageDays > rotateAfterDays ? 'warn' : 'ok'
}

export function formatSol(lamports: number | null): string {
  return lamports === null ? 'unknown' : `${(lamports / 1e9).toFixed(lamports < 1e8 ? 4 : 3)} SOL`
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

export function formatAge(days: number | null): string {
  if (days === null) return 'age unknown'
  if (days < 1) return 'set today'
  return days === 1 ? '1 day old' : `${days} days old`
}

const FACT_FIELDS = ['plan', 'cost', 'renewsOn', 'account', 'notes'] as const
const FACT_MAX = 200

/** Validates a facts edit from the page. Dates are YYYY-MM-DD; empty strings clear a field. */
export function parseFactsEdit(body: unknown, nodeIds: readonly string[]):
  | { ok: true; node: string; facts: ManualFacts }
  | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const node = typeof b.node === 'string' ? b.node : ''
  if (!nodeIds.includes(node)) return { ok: false, error: 'Unknown integration.' }
  const raw = (b.facts && typeof b.facts === 'object' ? b.facts : {}) as Record<string, unknown>
  const facts: ManualFacts = {}
  for (const k of FACT_FIELDS) {
    const v = raw[k]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return { ok: false, error: `${k} must be text.` }
    const t = v.trim()
    if (t.length > FACT_MAX) return { ok: false, error: `${k} is longer than ${FACT_MAX} characters.` }
    if (!t) continue
    if (k === 'renewsOn' && !/^\d{4}-\d{2}-\d{2}$/.test(t)) return { ok: false, error: 'Renewal date must be YYYY-MM-DD.' }
    facts[k] = t
  }
  return { ok: true, node, facts }
}

export function summarize(nodes: CcNode[]): CommandCenterState['summary'] {
  const s = { ok: 0, warn: 0, down: 0, unknown: 0 }
  for (const n of nodes) s[n.status]++
  return s
}

/** POST bodies: a facts edit (default), or a watch-list add / dismiss. */
export type CcAction =
  | { kind: 'facts'; node: string; facts: ManualFacts }
  | { kind: 'watch-add'; text: string }
  /** key = a WatchItem id: 'team:<n>' or 'dec:<DEC>:<hash>'. Live problems cannot be dismissed; they clear when fixed. */
  | { kind: 'watch-dismiss'; key: string }

export function parseAction(body: unknown, nodeIds: readonly string[]): { ok: true; action: CcAction } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (b.action === 'watch-add') {
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (!text) return { ok: false, error: 'Write what to watch.' }
    if (text.length > 280) return { ok: false, error: 'Keep it under 280 characters.' }
    return { ok: true, action: { kind: 'watch-add', text } }
  }
  if (b.action === 'watch-dismiss') {
    const key = typeof b.key === 'string' ? b.key : ''
    if (!/^(team:\d+|dec:DEC-\d{4}:[0-9a-f]{10})$/.test(key)) return { ok: false, error: 'This item clears by itself once it is fixed.' }
    return { ok: true, action: { kind: 'watch-dismiss', key } }
  }
  const parsed = parseFactsEdit(body, nodeIds)
  return parsed.ok ? { ok: true, action: { kind: 'facts', node: parsed.node, facts: parsed.facts } } : parsed
}

/** Values a person types in the feedback Sheet's Status column that close a row; anything else, or empty, is open. */
export const CLOSED_FEEDBACK = ['resolved', 'done', 'fixed', 'closed', "won't fix", 'wont fix', 'duplicate', 'test']

/** The feedback board's rule (lib/agent-feedback/boardPure.ts deriveBoardStatus), restated so this module stays dependency-free. */
export function boardStatusOf(pipelineStatus: string | null, boardStatus: string | null): string {
  if (boardStatus) return boardStatus
  if (pipelineStatus === 'dismissed') return 'rejected'
  if (pipelineStatus === 'dispatched' || pipelineStatus === 'resolved') return 'in_progress'
  return 'reported'
}

/** What running ssr.fun costs per month, in USDC: subscriptions, Vercel usage and on-chain gas. */
export interface BurnLine { label: string; usd: number; detail: string; source: 'live' | 'entered' | 'measured'; nodeId?: string }
export interface BurnGroup { title: string; usd: number; lines: BurnLine[] }
export interface BurnRate {
  monthlyUsd: number
  groups: BurnGroup[]
  /** Costs that exist but are not in the total yet, and why. */
  notCounted: { label: string; why: string; nodeId?: string }[]
}

export const DAYS_PER_MONTH = 30.44

/** A cost typed on a card ("$25/month", "$300/yr", "free") as USD per month; null when there is no amount to read. */
export function parseMonthlyCost(text: string | undefined): number | null {
  if (!text) return null
  const t = text.toLowerCase()
  if (/\bfree\b/.test(t)) return 0
  const n = t.match(/(\d[\d,]*(?:\.\d+)?)/)
  if (!n) return null
  const amount = Number(n[1].replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  if (/\b(year|yr|annual|annually|yearly)\b|\/\s*y\b/.test(t)) return amount / 12
  if (/\b(week|wk|weekly)\b/.test(t)) return (amount * 52) / 12
  if (/\b(day|daily)\b/.test(t)) return amount * DAYS_PER_MONTH
  return amount
}

/** A billing cycle's spend so far, scaled to the whole cycle. Null in the cycle's first hours, when one day would dominate. */
export function projectToMonth(spend: number, periodStartMs: number, periodEndMs: number, nowMs: number): number | null {
  const elapsed = nowMs - periodStartMs
  const length = periodEndMs - periodStartMs
  if (length <= 0 || elapsed < 12 * 3_600_000) return null
  return (spend * length) / Math.min(elapsed, length)
}

/**
 * SOL a wallet spends per day, from balance samples. Only drops count, so a top-up is not
 * read as negative spend (a top-up between two samples hides that interval's spending).
 * Null until the samples span six hours.
 */
export function solBurnPerDay(samples: { at: number; sol: number }[]): { solPerDay: number; spanDays: number } | null {
  const s = [...samples].sort((a, b) => a.at - b.at)
  if (s.length < 2) return null
  const spanDays = (s[s.length - 1].at - s[0].at) / 86_400_000
  if (spanDays < 0.25) return null
  let spent = 0
  for (let i = 1; i < s.length; i++) spent += Math.max(0, s[i - 1].sol - s[i].sol)
  return { solPerDay: spent / spanDays, spanDays }
}

export function formatUsdc(n: number | null): string {
  if (n === null) return 'unpriced'
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`
}
