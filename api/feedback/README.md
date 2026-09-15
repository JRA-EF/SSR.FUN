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
| `GET  /api/feedback/board[?format=csv&statuses=]` | dashboard session or Bearer | team board items with history; CSV export |
| `POST /api/feedback/board` | dashboard session or Bearer | change status/priority, add a note, or (people only) start/stop the fixer agent |
| `GET  /api/feedback/agent-requests` | Bearer | daemon claims start/stop requests made on the board |
| `POST /api/feedback/agent-requests` | Bearer | daemon reports a request's outcome |

`_auth.ts` holds the shared Bearer check. Store: `lib/agent-feedback/db.ts`
(Neon `agent_feedback`; schema created and migrated on first request, no
manual migration). Rows are never deleted.

## Team board (`/internal/feedback-board`)
Behind the same `SSR_DASHBOARD_PASSWORD` login as `/internal/status`.
Columns: Reported, In progress, Blocked, Testing, Live, and Rejected (hidden
by default). Priority is Urgent, High, Normal, or Low and sorts each column.

- Every change is appended to `agent_feedback_board_events` with who, when,
  from, to, and the note. Nothing is edited or deleted.
- Telegram decisions place unplaced items: dismissed goes to Rejected,
  approved goes to In progress. A placement someone already made is kept.
- Start and Stop queue a row in `agent_feedback_agent_requests`. The Mac
  daemon claims it, pastes it into the fixer session (refusing if no agent is
  running), and reports done or failed, which shows on the card.
- Only a person can mark an item Live or start/stop the agent. The fixer agent
  moves items with `feedback-daemon.py --board <id> <status> "<note>"`.
- Export CSV downloads the current status filter. User-written cells that
  start with `= + - @` are prefixed with `'` so spreadsheets do not run them.
