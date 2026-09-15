// Team feedback board (/internal/feedback-board): the pure status, priority,
// agent-request and CSV rules in lib/agent-feedback/boardPure.ts. Plain mocha
// ESM (like phase_feedback_rate_limit.mjs) because lib/agent-feedback is an ESM scope.
import assert from 'node:assert/strict'
import {
  BOARD_STATUSES, DEFAULT_VISIBLE_STATUSES, PRIORITIES, agentSummary, canSetStatus, compareForColumn, csvCell,
  deriveBoardStatus, isAgentAction, isBoardStatus, isPriority, latestNote, parseStatusList, toCsv,
} from '../lib/agent-feedback/boardPure.ts'

describe('feedback board -- statuses', () => {
  it('has the five working columns plus rejected, and hides rejected by default', () => {
    assert.deepEqual([...BOARD_STATUSES], ['reported', 'in_progress', 'blocked', 'testing', 'live', 'rejected'])
    assert.deepEqual(DEFAULT_VISIBLE_STATUSES, ['reported', 'in_progress', 'blocked', 'testing', 'live'])
    assert.equal(isBoardStatus('testing'), true)
    assert.equal(isBoardStatus('solved'), false)
    assert.equal(isBoardStatus(undefined), false)
  })
  it('an explicit placement wins; otherwise the Telegram pipeline decides', () => {
    assert.equal(deriveBoardStatus('dismissed', 'testing'), 'testing')
    assert.equal(deriveBoardStatus('dismissed', null), 'rejected')
    assert.equal(deriveBoardStatus('dispatched', null), 'in_progress')
    assert.equal(deriveBoardStatus('resolved', null), 'in_progress')
    assert.equal(deriveBoardStatus('raised', null), 'reported')
    assert.equal(deriveBoardStatus('new', 'bogus'), 'reported')
  })
  it('parses a status filter in board order, dropping unknowns, defaulting when empty', () => {
    assert.deepEqual(parseStatusList('testing,reported,nope'), ['reported', 'testing'])
    assert.deepEqual(parseStatusList('rejected'), ['rejected'])
    assert.deepEqual(parseStatusList(''), DEFAULT_VISIBLE_STATUSES)
    assert.deepEqual(parseStatusList(null), DEFAULT_VISIBLE_STATUSES)
  })
  it('only a person can mark an item live', () => {
    assert.equal(canSetStatus('human', 'live'), true)
    assert.equal(canSetStatus('agent', 'live'), false)
    assert.equal(canSetStatus('agent', 'testing'), true)
  })
  it('latest note skips entries without a note', () => {
    assert.equal(latestNote([{ note: 'first' }, { note: null }, { note: 'second' }, { note: '' }]), 'second')
    assert.equal(latestNote([]), null)
    assert.equal(latestNote(undefined), null)
  })
})

describe('feedback board -- priority', () => {
  it('knows four levels', () => {
    assert.deepEqual([...PRIORITIES], ['urgent', 'high', 'normal', 'low'])
    assert.equal(isPriority('high'), true)
    assert.equal(isPriority('p0'), false)
  })
  it('sorts most urgent first, then newest first, treating unknown as normal', () => {
    const rows = [
      { id: 'low-new', priority: 'low', createdAt: '2026-09-15T10:00:00Z' },
      { id: 'normal-old', priority: null, createdAt: '2026-09-10T10:00:00Z' },
      { id: 'urgent-old', priority: 'urgent', createdAt: '2026-09-01T10:00:00Z' },
      { id: 'normal-new', priority: 'bogus', createdAt: '2026-09-14T10:00:00Z' },
    ]
    assert.deepEqual(rows.sort(compareForColumn).map((r) => r.id), ['urgent-old', 'normal-new', 'normal-old', 'low-new'])
  })
})

describe('feedback board -- fixer agent requests', () => {
  it('accepts only start and stop', () => {
    assert.equal(isAgentAction('start'), true)
    assert.equal(isAgentAction('stop'), true)
    assert.equal(isAgentAction('deploy'), false)
  })
  it('summarises the latest request', () => {
    assert.equal(agentSummary(null), '')
    assert.equal(agentSummary({ action: 'start', state: 'new' }), 'Start queued')
    assert.equal(agentSummary({ action: 'start', state: 'claimed' }), 'Start queued')
    assert.equal(agentSummary({ action: 'start', state: 'done' }), 'Started')
    assert.equal(agentSummary({ action: 'start', state: 'failed' }), 'Start failed')
    assert.equal(agentSummary({ action: 'stop', state: 'done' }), 'Stopped')
    assert.equal(agentSummary({ action: 'stop', state: 'claimed' }), 'Stop queued')
  })
})

describe('feedback board -- CSV export', () => {
  it('quotes commas, quotes and newlines', () => {
    assert.equal(csvCell('plain'), 'plain')
    assert.equal(csvCell('a, b'), '"a, b"')
    assert.equal(csvCell('say "hi"'), '"say ""hi"""')
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"')
    assert.equal(csvCell(null), '')
  })
  it('neutralises spreadsheet formulas in user-written text', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`)
    assert.equal(csvCell('+1'), "'+1")
    assert.equal(csvCell('-2'), "'-2")
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
  })
  it('writes a header row with human status and priority labels', () => {
    const csv = toCsv([{
      id: 'x', createdAt: new Date('2026-09-15T10:42:36Z'), boardStatus: 'in_progress', priority: null, category: 'bug',
      message: 'Swap, then crash', contact: null, pageUrl: 'https://ssr.fun/r/abc', latestNote: 'on it', agent: 'Started',
    }])
    const [header, row, end] = csv.split('\r\n')
    assert.ok(header.startsWith('submitted_at,status,priority,category,message,contact,page,latest_note,fixer_agent,'))
    assert.ok(row.startsWith('2026-09-15T10:42:36.000Z,In progress,Normal,bug,"Swap, then crash",,https://ssr.fun/r/abc,on it,Started,'))
    assert.equal(end, '')
  })
})
