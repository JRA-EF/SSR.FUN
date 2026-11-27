# BETA wave 4: 40 more self-serve keys (cap 131)

- **Date:** 2026-11-27
- **Author:** Joao via Claude Code (Claude Opus 5.5)
- **Branch / commits:** `main` (decision log + this note only)
- **Deployed to:** env-only redeploy of `dpl_FZvD9Gg9` as production `dpl_8a5vV7oJ` (2026-11-27 ~15:30 UTC). Since then production is `dpl_D6tyK4rx` (leaderboard callout removal, peer), which carries the same env. Rollback for the cap only: `dpl_FZvD9Gg9` (cap 91, but without the leaderboard change).
- **Decision log:** DEC-0297. Next free id: DEC-0298.

## What shipped
1. Wave 3 (cap 91) filled on 2026-11-26 23:28 UTC. `ssr.fun/beta` is open again for exactly 40 more people.

## Code touched
- None. `docs/project/DECISION_LOG.md` (DEC-0297) only.

## Repositories / environments adjusted
- Vercel `ssr-fun` Production: `SSR_BETA_CLAIM_CAP` = 131 (was 91). `SSR_BETA_CLAIM_ENABLED` unchanged (true). Nothing on staging.
- Neon: read only. `beta_key_claims` had 91 rows before. No test claim was made.

## Effect on others — READ THIS
- The cap counts TOTAL rows. For wave 5 set `SSR_BETA_CLAIM_CAP` to the current count plus the wave size and redeploy.
- Verified after both deploys: `GET https://ssr.fun/api/site/claim` -> `{"open":true,"full":false}`.
