// GET /api/feedback/item?id=<uuid> -- one feedback row, any status. The daemon
// uses it on Approve when its in-memory copy is gone (restart), so a restart
// can never lose a submission: the database is the record. Bearer-secret auth.
import { getFeedback } from '../../lib/agent-feedback/db.js'
import { requireDaemonSecret, queryParam, type Req, type Res } from './_auth.js'

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed.' }); return }
  if (!requireDaemonSecret(req, res)) return
  const id = queryParam(req, 'id')
  if (!id) { res.status(400).json({ error: 'id required.' }); return }
  try {
    const item = await getFeedback(id)
    if (!item) { res.status(404).json({ error: 'Not found.' }); return }
    res.status(200).json({ item })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to read item.' })
  }
}
