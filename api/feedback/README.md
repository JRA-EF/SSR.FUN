# Vercel routes for the agent-feedback pipeline

Full design, the permanent-record table, and daemon setup live in
`tools/agent-feedback-daemon/README.md`. Routes here:

| route | auth | purpose |
|---|---|---|
| `POST /api/feedback/submit` | public (BotID + rate limits) | store one submission, status `new` |
| `GET  /api/feedback/form` | public | legacy URL, 302 → `/feedback` |
| `GET  /api/feedback/pending` | Bearer `FEEDBACK_DAEMON_SECRET` | daemon claims `new` items → `raised` |
| `POST /api/feedback/ack` | Bearer | `dispatched` / `dismissed` + `handledBy` |
| `GET  /api/feedback/item?id=` | Bearer | one row (daemon restart recovery) |
| `GET  /api/feedback/list?status=&limit=` | Bearer | newest-first listing |
| `POST /api/feedback/resolve` | Bearer | fixer's conclusion → `resolved` |

`_auth.ts` holds the shared Bearer check. Store: `lib/agent-feedback/db.ts`
(Neon `agent_feedback`; schema created and migrated on first request, no
manual migration). Rows are never deleted.
