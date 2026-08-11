// GET  /api/road-to-mainnet/comments?entityType=&entityId=
//      Returns every comment for one entity, grouped into passes
//      (locked=track record, open=still discussable) -- see
//      lib/road-to-mainnet/schema.sql's rtm_comments comment for the model.
// POST /api/road-to-mainnet/comments
//      Body: { entityType, entityId, author, body }
//      Appends one comment to the current open pass (starting a new pass
//      automatically if the previous one was locked). Never edits or
//      deletes an existing comment -- this thread is append-only.
//
// Separate from state.ts's status/evidence/notes fields on purpose: those
// remain the mutable "current answer" for a control; this is the running
// discussion underneath it, and locking a pass here never touches those
// fields at all.
import type { DashboardRequest, DashboardResponse } from '../../lib/dashboard/http.js'
import { isAuthenticated, isSameOriginRequest, unauthorized } from '../../lib/road-to-mainnet/auth.js'
import { getComments, addComment, validateCommentBody, validateEditor, validateEntityId, type EntityType } from '../../lib/road-to-mainnet/store.js'

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

  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
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
    const comments = await getComments(entityType, entityId)
    res.status(200).json({ comments })
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
    const commentBody = validateCommentBody(body.body)
    if (commentBody === null) {
      res.status(400).json({ error: 'Comment body must not be empty.' })
      return
    }
    const author = validateEditor(body.author)
    const comment = await addComment(entityType, entityId, author, commentBody)
    res.status(200).json({ comment })
    return
  }

  res.status(405).json({ error: 'Method not allowed' })
}
