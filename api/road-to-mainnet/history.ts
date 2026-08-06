// GET /api/road-to-mainnet/history?entityType=control&entityId=CP-01
// Returns the last 50 revisions for one entity (most recent first) --
// recoverable edit history independent of the live rtm_* row. Read-only.

import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { isAuthenticated, unauthorized } from '../../lib/road-to-mainnet/auth.js'
import { getHistory, validateEntityId, type EntityType } from '../../lib/road-to-mainnet/store.js'

const ENTITY_TYPES: EntityType[] = ['control', 'gap_row', 'gate', 'meta']

function queryParam(req: DashboardRequest, name: string): string | undefined {
  const anyReq = req as unknown as { query?: Record<string, unknown> }
  const fromQuery = anyReq.query?.[name]
  if (typeof fromQuery === 'string') return fromQuery
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string') return fromQuery[0]
  return undefined
}

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  if (!(await isAuthenticated(req))) {
    unauthorized(res)
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  res.setHeader('Cache-Control', 'no-store')

  const entityType = queryParam(req, 'entityType') as EntityType
  if (!ENTITY_TYPES.includes(entityType)) {
    res.status(400).json({ error: 'Invalid entityType.' })
    return
  }
  const entityId = validateEntityId(entityType, queryParam(req, 'entityId'))
  if (entityId === null) {
    res.status(400).json({ error: 'Invalid entityId.' })
    return
  }

  const entries = await getHistory(entityType, entityId, 50)
  res.status(200).json({ entries })
}
