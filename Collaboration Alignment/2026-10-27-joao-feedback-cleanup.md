# Feedback board and Sheet cleared of test entries

- **Date:** 2026-10-27
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/command-center`, merged into `main`
- **Deployed to:** Apps Script feedback webhook version 5 (same deployment id and URL). No Vercel deploy.

## What shipped
- **The 6 open items on /internal/feedback-board were moved to Rejected, each with a note.** All 6 were test or setup submissions ("test", "Bot is live", "everything is broken omg" sent 90 s after a "test" from the same page). They are logged in `agent_feedback_board_events` as actor `Claude`.
- **The feedback Sheet's 5 rows now have Status = Test.** All 5 were setup rows or the Creator's own test. The Sheet shows 0 open.
- **New `set-status` action in `tools/feedback-sheet/Code.gs`.** It is secret-protected and writes a row only if that row's timestamp matches. The README says how to call it.

## Effect on others: READ THIS
- **The command center shows 0 open on both the board and the Sheet.** A new number there now means a real submission.
