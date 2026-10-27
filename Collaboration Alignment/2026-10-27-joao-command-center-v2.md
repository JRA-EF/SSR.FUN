# Command center v2: wallets in USDC, feedback, error reviews, unpushed work, watch list

- **Date:** 2026-10-27
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/command-center`, merged into `main`
- **Deployed to:** production and staging (deploy ids in the commit that follows)
- **Decision log:** DEC-0266 (builds on DEC-0264)

## What shipped
- **Protocol wallets as bubbles, valued in USDC.**
  - Treasury and both admins are read live from ProtocolConfig.
  - Also shown: the Squads vault and signers, the fee keeper and the pool payer.
  - Reserve Tokens with no market price are valued at NAV.
  - The header total excludes the second admin, which is the Boss's own wallet.
- **Feedback numbers.**
  - The Sheet gets a new Status column; an empty Status counts as open.
  - The board shows unresolved items by status.
- **Error watcher:** lists alert kinds Claude has not reviewed since they last happened.
- **GitHub:** commits that exist only on the dev PC, worktrees with uncommitted changes, and branches not merged into main.
- **Watch list:** live problems, open items from the decision log, and team notes.
- **Observability Plus is off on ssr-fun-staging.**

## Code touched
- `lib/command-center/*`, `api/dashboard/commandcenter.ts`, `public/internal-commandcenter.html`.
- `scripts/command_center_git_snapshot.mjs`: run hourly on the dev PC.
- `scripts/review_ops_alerts.mjs`: list, show and mark alert kinds as reviewed, with a note.
- `tools/feedback-sheet/Code.gs`: Status column and a stats action. **Not pushed to Google yet:** the clasp login expired.

## Repositories / environments adjusted
- **Neon:** new tables `command_center_watch`, `command_center_dismissed`, `command_center_snapshots` and `ops_alert_reviews`. The ops-alerts tables are untouched.
- **Vercel:** Observability Plus disabled on ssr-fun-staging.
- **Dev PC:** scheduled task "SSR.FUN command center git snapshot", running hourly from `~/.ssr-fun/command_center_git_snapshot.mjs`.

## Effect on others: READ THIS
- **After investigating an alert,** mark it: `node scripts/review_ops_alerts.mjs --ack <n> --note "..."`. Otherwise it stays on the watch list.
- **Commits that only exist locally show up on the page.** Push them, or delete them if they are throwaway staging merges.
- **In the feedback Sheet,** set Status to Resolved, Won't fix, Duplicate or Test to close a row.
