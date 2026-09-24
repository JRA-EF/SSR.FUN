// Pure, dependency-free pieces of the team feedback board
// (/internal/feedback-board). Shared by the API (api/feedback/board.ts), the
// page (src/internal-feedback-board) and the DB layer, and unit-tested
// directly by tests/phase_feedback_board.mjs under Node's native type
// stripping -- so this file must stay import-free.

export const BOARD_STATUSES = ['reported', 'in_progress', 'blocked', 'testing', 'live', 'rejected'] as const
export type BoardStatus = (typeof BOARD_STATUSES)[number]

export const BOARD_STATUS_LABELS: Record<BoardStatus, string> = {
  reported: 'Reported',
  in_progress: 'In progress',
  blocked: 'Blocked',
  testing: 'Testing',
  live: 'Live',
  rejected: 'Rejected',
}

/** What the board shows before anyone touches the filters: everything but rejected. */
export const DEFAULT_VISIBLE_STATUSES: BoardStatus[] = BOARD_STATUSES.filter((s) => s !== 'rejected')

export function isBoardStatus(value: unknown): value is BoardStatus {
  return typeof value === 'string' && (BOARD_STATUSES as readonly string[]).includes(value)
}

/**
 * The column an item sits in. An explicit board placement always wins. An item
 * nobody has placed yet follows the Telegram pipeline: dismissed there means
 * rejected here, approved (or already concluded by the fixer) means in
 * progress, and anything else is still just reported.
 */
export function deriveBoardStatus(pipelineStatus: string | null | undefined, boardStatus: string | null | undefined): BoardStatus {
  if (isBoardStatus(boardStatus)) return boardStatus
  if (pipelineStatus === 'dismissed') return 'rejected'
  if (pipelineStatus === 'dispatched' || pipelineStatus === 'resolved') return 'in_progress'
  return 'reported'
}

/** "reported,testing" -> ['reported', 'testing'] in board order. Unknown names are dropped; nothing valid -> the default view. */
export function parseStatusList(raw: string | null | undefined): BoardStatus[] {
  const picked = (raw ?? '').split(',').map((s) => s.trim()).filter(isBoardStatus)
  return picked.length ? BOARD_STATUSES.filter((s) => picked.includes(s)) : [...DEFAULT_VISIBLE_STATUSES]
}

/** The fixer agent works on branches and never deploys, so only a person can mark an item live. */
export function canSetStatus(caller: 'human' | 'agent', status: BoardStatus): boolean {
  return caller === 'human' || status !== 'live'
}

// ---- priority ----------------------------------------------------------------

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export type BoardPriority = (typeof PRIORITIES)[number]

export const PRIORITY_LABELS: Record<BoardPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

export function isPriority(value: unknown): value is BoardPriority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
}

/** Order inside a column: most urgent first, then newest first. Unknown priority counts as normal. */
export function compareForColumn(
  a: { priority?: string | null; createdAt: string | Date },
  b: { priority?: string | null; createdAt: string | Date },
): number {
  const rank = (p: string | null | undefined) => PRIORITIES.indexOf(isPriority(p) ? p : 'normal')
  return rank(a.priority) - rank(b.priority) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

// ---- fixer-agent requests (start / stop from the board) ------------------------

export const AGENT_ACTIONS = ['start', 'stop'] as const
export type AgentAction = (typeof AGENT_ACTIONS)[number]

export function isAgentAction(value: unknown): value is AgentAction {
  return typeof value === 'string' && (AGENT_ACTIONS as readonly string[]).includes(value)
}

/** One-word state of the latest start/stop request, for cards and the CSV. */
export function agentSummary(request: { action: string; state: string } | null | undefined): string {
  if (!request) return ''
  const verb = request.action === 'stop' ? 'Stop' : 'Start'
  if (request.state === 'new' || request.state === 'claimed') return `${verb} queued`
  if (request.state === 'failed') return `${verb} failed`
  return request.action === 'stop' ? 'Stopped' : 'Started'
}

/** The most recent non-empty note in an item's history. */
export function latestNote(history: readonly { note: string | null }[] | null | undefined): string | null {
  if (!history) return null
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].note) return history[i].note
  }
  return null
}

// ---- CSV -----------------------------------------------------------------------

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value)
  // Feedback text is written by the public. A cell starting with = + - @ runs
  // as a formula when the CSV is opened in Sheets or Excel, so neutralise it.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export interface BoardCsvRow {
  id: string
  createdAt: string | Date
  boardStatus: string
  priority?: string | null
  category: string
  message: string
  contact: string | null
  pageUrl: string | null
  latestNote: string | null
  agent: string
  boardUpdatedBy?: string | null
  boardUpdatedAt?: string | Date | null
  handledBy?: string | null
  resolution?: string | null
}

const CSV_COLUMNS: [keyof BoardCsvRow, string][] = [
  ['createdAt', 'submitted_at'],
  ['boardStatus', 'status'],
  ['priority', 'priority'],
  ['category', 'category'],
  ['message', 'message'],
  ['contact', 'contact'],
  ['pageUrl', 'page'],
  ['latestNote', 'latest_note'],
  ['agent', 'fixer_agent'],
  ['boardUpdatedBy', 'last_changed_by'],
  ['boardUpdatedAt', 'last_changed_at'],
  ['handledBy', 'telegram_decision_by'],
  ['resolution', 'fixer_conclusion'],
  ['id', 'id'],
]

export function toCsv(rows: readonly BoardCsvRow[]): string {
  const lines = [CSV_COLUMNS.map(([, header]) => csvCell(header)).join(',')]
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(([key]) => {
      const v = row[key]
      if (key === 'boardStatus' && isBoardStatus(v)) return csvCell(BOARD_STATUS_LABELS[v])
      if (key === 'priority') return csvCell(PRIORITY_LABELS[isPriority(v) ? v : 'normal'])
      return csvCell(v)
    }).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
