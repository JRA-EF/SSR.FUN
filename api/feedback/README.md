# Vercel routes for the agent-feedback pipeline

These deploy the feedback queue + form. Two options:

**A. Standalone Vercel project (recommended — decoupled from SSR):**
Deploy this `vercel/` dir as its own project. Set env: `DATABASE_URL` (a Neon
Postgres), `FEEDBACK_DAEMON_SECRET`. The `agent_feedback` table auto-creates.
Point the daemon's `VERCEL_BASE_URL` at this project's URL.

**B. Fold into the SSR repo:** copy `api/feedback/*` -> `SSR.FUN/api/feedback/`
and `lib/agent-feedback/db.ts` -> `SSR.FUN/lib/agent-feedback/`, COMMIT on a
branch, and verify `npm run build` passes (as untracked files they broke the
SSR monorepo's `tsc -b`; commit + a build check before relying on it).

Routes: form.ts (public form), submit.ts (public POST), pending.ts +
ack.ts (Bearer FEEDBACK_DAEMON_SECRET). See ../README.md for the full flow.
