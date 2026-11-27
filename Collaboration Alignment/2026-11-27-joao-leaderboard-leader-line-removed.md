# Leaderboard: "Leading the Volume track" line removed

- **Date:** 2026-11-27
- **Author:** Joao via Claude Code (Claude Opus 5.5)
- **Branch / commits:** `main`
- **Deployed to:** production; rollback target dpl_8a5vV7oJ
- **Decision log:** none (copy removal)

## What shipped
At the Creator's request, ssr.fun/leaderboard no longer prints the "Leading the Volume track: trader @handle with $X" banner above the Highest Volume table. The page shows only the track tables and their ranks.

## Code touched
- `leaderboard.html`: the `#volume-leader` div is removed
- `src/leaderboard/main.ts`: the code that rendered it is removed

## Repositories / environments adjusted
- SSR.FUN: main, design, production deploy. The API is unchanged: `/api` still returns `volumeLeader`, and the page just doesn't render it.

## Effect on others — READ THIS
- Don't re-add a named leader callout to the leaderboard without the Creator's go.

## Verification
The live leaderboard bundle no longer contains "Leading the Volume track".
