# Command center: feedback board bubble removed, Jupiter plan tracked

- **Date:** 2026-10-28
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** none yet (production deploy pending a peer check, see below)
- **Decision log:** none (internal page only)

## What shipped
- **The "Feedback board" bubble is gone from /internal/commandcenter.** The Creator found it a duplicate of the "Feedback sheet" bubble. The feedback sheet bubble is unchanged. The board page itself (/internal/feedback-board) and its data are untouched; only the command center stops showing it.
- **The Jupiter bubble now shows its plan.** Developer plan, $25/month, 25.0M credits, renews 2026-11-28, org `ssr-193d79` on developers.jup.ag. It was saved in Neon `command_center_facts` (row `jupiter`), not in code. The renewal date is manual: bump it each month.
- **Ops alert review:** the one queued alert (keeper settlement, Helius "account index service overloaded" at 00:20Z on two reserves) was marked false_positive. It did not repeat in the next ~11 runs.

## Code touched
- `lib/command-center/probes.ts`: drops the `feedback-board` node, its `agent_feedback` query and its edge. `FEEDBACK_DAEMON_SECRET` key-age tracking moves to the Vercel bubble.
- `public/internal-commandcenter.html`: drops the board's icon, map position and phone-order slot.

## Effect on others: READ THIS
- The board's unresolved count no longer appears anywhere on the command center. Watch /internal/feedback-board directly if you use it.
- `boardStatusOf` in `lib/command-center/model.ts` is now unused by the command center; left in place.

## Verification
- `tests/phase_command_center.ts` 6 passing; oxlint clean on `lib/command-center`; `tsc -p tsconfig.node.json` shows only the pre-existing `botid/server` error.
