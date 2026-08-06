// GET  /api/road-to-mainnet/state -- returns the full collaborative checklist
//      state (controls, gap rows, gates, meta), each entity carrying its own
//      version/updatedAt/updatedBy for optimistic-concurrency editing.
// POST /api/road-to-mainnet/state -- writes one entity. Body:
//      { entityType: 'control'|'gap_row'|'gate'|'meta', entityId: string,
//        values: {...}, expectedVersion: number, editor: string }
//      Returns 200 with the new version, 409 with the current server value
//      on a version conflict (never silently overwrites), 400 on invalid
//      input, 401 if unauthenticated.
//
// Independently re-verifies the session cookie (middleware.ts already blocks
// unauthenticated requests to this exact path -- see api/dashboard/content.ts
// for the same defense-in-depth rationale this repo already follows).

import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { isAuthenticated, isSameOriginRequest, unauthorized } from '../../lib/road-to-mainnet/auth.js'
import { getFullState, upsertEntity, validateEditor, validateEntityId, validateValues, type EntityType, type UpsertResult } from '../../lib/road-to-mainnet/store.js'

const ENTITY_TYPES: EntityType[] = ['control', 'gap_row', 'gate', 'meta']

function parseBody(req: DashboardRequest): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return {}
    }
  }
  return {}
}

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  if (!(await isAuthenticated(req))) {
    unauthorized(res)
    return
  }

  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    const state = await getFullState()
    res.status(200).json(state)
    return
  }

  if (req.method === 'POST') {
    if (!isSameOriginRequest(req)) {
      res.status(403).json({ error: 'Cross-site request rejected.' })
      return
    }

    const body = parseBody(req)
    const entityType = body.entityType as EntityType
    if (!ENTITY_TYPES.includes(entityType)) {
      res.status(400).json({ error: 'Invalid entityType.' })
      return
    }
    const entityId = validateEntityId(entityType, body.entityId)
    if (entityId === null) {
      res.status(400).json({ error: 'Invalid entityId.' })
      return
    }
    const values = validateValues(entityType, body.values)
    if (values === null) {
      res.status(400).json({ error: 'Invalid values.' })
      return
    }
    const expectedVersion = Number(body.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      res.status(400).json({ error: 'Invalid expectedVersion.' })
      return
    }
    const editor = validateEditor(body.editor)

    const result: UpsertResult = await upsertEntity(entityType, entityId, values, expectedVersion, editor)
    if (result.ok) {
      res.status(200).json({ version: result.version, updatedAt: result.updatedAt, updatedBy: result.updatedBy })
      return
    }
    if (result.kind === 'conflict') {
      res.status(409).json({ error: 'This item was updated by someone else since you loaded it.', current: result.current })
      return
    }
    res.status(404).json({ error: 'Unknown entity.' })
    return
  }

  res.status(405).json({ error: 'Method not allowed' })
}
