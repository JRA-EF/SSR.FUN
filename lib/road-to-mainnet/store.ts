// Shared persistence logic for the Road to Mainnet collaborative checklist.
// Used by api/road-to-mainnet/state.ts and history.ts. Every write goes
// through optimistic concurrency (UPDATE ... WHERE version = $expected) and
// is logged to rtm_revisions so no edit is silently lost or overwritten.

import { getSql } from './db.js'

export const STATUSES = ['Passed', 'Failed', 'Partial', 'Blocked', 'Not tested', 'Not applicable'] as const
export const GATE_DECISIONS = ['Not reviewed', 'Approved', 'Rejected', 'Conditional'] as const
export const GAP_ROW_COUNT = 12 // must match gapRows.length in public/road-to-mainnet.html
export const GATE_COUNT = 7 // must match gates.length in public/road-to-mainnet.html
export const META_KEYS = ['owner', 'release'] as const

export type EntityType = 'control' | 'gap_row' | 'gate' | 'meta'

export interface ControlValues {
  status: string
  evidence: string
  environment: string
  tester: string
  notes: string
}
export interface GapRowValues {
  cells: string[]
}
export interface GateValues {
  decision: string
  approver: string
  notes: string
}
export interface MetaValues {
  value: string
}

const CONTROL_ID_RE = /^[A-Z]{2,3}-\d{2}$/

function cap(s: unknown, max: number): string {
  const str = typeof s === 'string' ? s : ''
  return str.length > max ? str.slice(0, max) : str
}

export function validateEditor(editor: unknown): string {
  const str = typeof editor === 'string' ? editor.trim() : ''
  return cap(str, 80) || 'Unknown'
}

export function validateEntityId(entityType: EntityType, entityId: unknown): string | null {
  if (typeof entityId !== 'string') return null
  if (entityType === 'control') return CONTROL_ID_RE.test(entityId) ? entityId : null
  if (entityType === 'gap_row') {
    const n = Number(entityId)
    return Number.isInteger(n) && n >= 0 && n < GAP_ROW_COUNT ? entityId : null
  }
  if (entityType === 'gate') {
    const n = Number(entityId)
    return Number.isInteger(n) && n >= 0 && n < GATE_COUNT ? entityId : null
  }
  if (entityType === 'meta') {
    return (META_KEYS as readonly string[]).includes(entityId) ? entityId : null
  }
  return null
}

export function validateValues(entityType: EntityType, values: unknown): ControlValues | GapRowValues | GateValues | MetaValues | null {
  if (!values || typeof values !== 'object') return null
  const v = values as Record<string, unknown>
  if (entityType === 'control') {
    const status = typeof v.status === 'string' && (STATUSES as readonly string[]).includes(v.status) ? v.status : null
    if (!status) return null
    return {
      status,
      evidence: cap(v.evidence, 20000),
      environment: cap(v.environment, 500),
      tester: cap(v.tester, 300),
      notes: cap(v.notes, 20000),
    }
  }
  if (entityType === 'gap_row') {
    if (!Array.isArray(v.cells) || v.cells.length !== 6) return null
    return { cells: v.cells.map(c => cap(c, 2000)) }
  }
  if (entityType === 'gate') {
    const decision = typeof v.decision === 'string' && (GATE_DECISIONS as readonly string[]).includes(v.decision) ? v.decision : null
    if (!decision) return null
    return { decision, approver: cap(v.approver, 200), notes: cap(v.notes, 5000) }
  }
  if (entityType === 'meta') {
    return { value: cap(v.value, 200) }
  }
  return null
}

interface EntityRow {
  version: number
  updatedAt: string
  updatedBy: string | null
  values: Record<string, unknown>
}

function controlRowToEntity(r: any): EntityRow {
  return {
    version: r.version,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    values: { status: r.status, evidence: r.evidence, environment: r.environment, tester: r.tester, notes: r.notes },
  }
}
function gapRowToEntity(r: any): EntityRow {
  return { version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by, values: { cells: r.cells } }
}
function gateRowToEntity(r: any): EntityRow {
  return { version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by, values: { decision: r.decision, approver: r.approver, notes: r.notes } }
}
function metaRowToEntity(r: any): EntityRow {
  return { version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by, values: { value: r.value } }
}

export async function getFullState() {
  const sql = getSql()
  const [controls, gaps, gates, meta] = await Promise.all([
    sql`select control_id, status, evidence, environment, tester, notes, version, updated_at, updated_by from rtm_controls order by control_id`,
    sql`select row_index, cells, version, updated_at, updated_by from rtm_gap_rows order by row_index`,
    sql`select gate_index, decision, approver, notes, version, updated_at, updated_by from rtm_gates order by gate_index`,
    sql`select key, value, version, updated_at, updated_by from rtm_meta order by key`,
  ])

  const controlsOut: Record<string, EntityRow> = {}
  for (const r of controls as any[]) controlsOut[r.control_id] = controlRowToEntity(r)

  const gapsOut: Record<string, EntityRow> = {}
  for (const r of gaps as any[]) gapsOut[String(r.row_index)] = gapRowToEntity(r)

  const gatesOut: Record<string, EntityRow> = {}
  for (const r of gates as any[]) gatesOut[String(r.gate_index)] = gateRowToEntity(r)

  const metaOut: Record<string, EntityRow> = {}
  for (const r of meta as any[]) metaOut[r.key] = metaRowToEntity(r)

  return { controls: controlsOut, gaps: gapsOut, gates: gatesOut, meta: metaOut, serverTime: new Date().toISOString() }
}

export type UpsertResult =
  | { ok: true; version: number; updatedAt: string; updatedBy: string | null }
  | { ok: false; kind: 'conflict'; current: EntityRow }
  | { ok: false; kind: 'not_found' }

export async function upsertEntity(
  entityType: EntityType,
  entityId: string,
  values: ControlValues | GapRowValues | GateValues | MetaValues,
  expectedVersion: number,
  editor: string,
): Promise<UpsertResult> {
  const sql = getSql()

  if (entityType === 'control') {
    const vals = values as ControlValues
    const before = await sql`select control_id, status, evidence, environment, tester, notes, version, updated_at, updated_by from rtm_controls where control_id = ${entityId}`
    if (before.length === 0) return { ok: false, kind: 'not_found' }
    const beforeRow = before[0] as any
    const updated = await sql`
      update rtm_controls
      set status = ${vals.status}, evidence = ${vals.evidence}, environment = ${vals.environment},
          tester = ${vals.tester}, notes = ${vals.notes}, version = version + 1, updated_at = now(), updated_by = ${editor}
      where control_id = ${entityId} and version = ${expectedVersion}
      returning version, updated_at, updated_by
    `
    if (updated.length === 0) {
      const current = await sql`select control_id, status, evidence, environment, tester, notes, version, updated_at, updated_by from rtm_controls where control_id = ${entityId}`
      return { ok: false, kind: 'conflict', current: controlRowToEntity(current[0]) }
    }
    const u = updated[0] as any
    await sql`insert into rtm_revisions (entity_type, entity_id, before_value, after_value, changed_by) values ('control', ${entityId}, ${JSON.stringify(controlRowToEntity(beforeRow).values)}, ${JSON.stringify(vals)}, ${editor})`
    return { ok: true, version: u.version, updatedAt: u.updated_at, updatedBy: u.updated_by }
  }

  if (entityType === 'gap_row') {
    const vals = values as GapRowValues
    const rowIndex = Number(entityId)
    const before = await sql`select row_index, cells, version, updated_at, updated_by from rtm_gap_rows where row_index = ${rowIndex}`
    if (before.length === 0) return { ok: false, kind: 'not_found' }
    const beforeRow = before[0] as any
    const updated = await sql`
      update rtm_gap_rows set cells = ${JSON.stringify(vals.cells)}, version = version + 1, updated_at = now(), updated_by = ${editor}
      where row_index = ${rowIndex} and version = ${expectedVersion}
      returning version, updated_at, updated_by
    `
    if (updated.length === 0) {
      const current = await sql`select row_index, cells, version, updated_at, updated_by from rtm_gap_rows where row_index = ${rowIndex}`
      return { ok: false, kind: 'conflict', current: gapRowToEntity(current[0]) }
    }
    const u = updated[0] as any
    await sql`insert into rtm_revisions (entity_type, entity_id, before_value, after_value, changed_by) values ('gap_row', ${entityId}, ${JSON.stringify(gapRowToEntity(beforeRow).values)}, ${JSON.stringify(vals)}, ${editor})`
    return { ok: true, version: u.version, updatedAt: u.updated_at, updatedBy: u.updated_by }
  }

  if (entityType === 'gate') {
    const vals = values as GateValues
    const gateIndex = Number(entityId)
    const before = await sql`select gate_index, decision, approver, notes, version, updated_at, updated_by from rtm_gates where gate_index = ${gateIndex}`
    if (before.length === 0) return { ok: false, kind: 'not_found' }
    const beforeRow = before[0] as any
    const updated = await sql`
      update rtm_gates set decision = ${vals.decision}, approver = ${vals.approver}, notes = ${vals.notes},
        version = version + 1, updated_at = now(), updated_by = ${editor}
      where gate_index = ${gateIndex} and version = ${expectedVersion}
      returning version, updated_at, updated_by
    `
    if (updated.length === 0) {
      const current = await sql`select gate_index, decision, approver, notes, version, updated_at, updated_by from rtm_gates where gate_index = ${gateIndex}`
      return { ok: false, kind: 'conflict', current: gateRowToEntity(current[0]) }
    }
    const u = updated[0] as any
    await sql`insert into rtm_revisions (entity_type, entity_id, before_value, after_value, changed_by) values ('gate', ${entityId}, ${JSON.stringify(gateRowToEntity(beforeRow).values)}, ${JSON.stringify(vals)}, ${editor})`
    return { ok: true, version: u.version, updatedAt: u.updated_at, updatedBy: u.updated_by }
  }

  // meta
  const vals = values as MetaValues
  const before = await sql`select key, value, version, updated_at, updated_by from rtm_meta where key = ${entityId}`
  if (before.length === 0) return { ok: false, kind: 'not_found' }
  const beforeRow = before[0] as any
  const updated = await sql`
    update rtm_meta set value = ${vals.value}, version = version + 1, updated_at = now(), updated_by = ${editor}
    where key = ${entityId} and version = ${expectedVersion}
    returning version, updated_at, updated_by
  `
  if (updated.length === 0) {
    const current = await sql`select key, value, version, updated_at, updated_by from rtm_meta where key = ${entityId}`
    return { ok: false, kind: 'conflict', current: metaRowToEntity(current[0]) }
  }
  const u = updated[0] as any
  await sql`insert into rtm_revisions (entity_type, entity_id, before_value, after_value, changed_by) values ('meta', ${entityId}, ${JSON.stringify(metaRowToEntity(beforeRow).values)}, ${JSON.stringify(vals)}, ${editor})`
  return { ok: true, version: u.version, updatedAt: u.updated_at, updatedBy: u.updated_by }
}

export async function getHistory(entityType: EntityType, entityId: string, limit = 50) {
  const sql = getSql()
  const rows = await sql`
    select before_value, after_value, changed_by, changed_at
    from rtm_revisions
    where entity_type = ${entityType} and entity_id = ${entityId}
    order by changed_at desc
    limit ${limit}
  `
  return (rows as any[]).map(r => ({
    beforeValue: r.before_value,
    afterValue: r.after_value,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  }))
}
