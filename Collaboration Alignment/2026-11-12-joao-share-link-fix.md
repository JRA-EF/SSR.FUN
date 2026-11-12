# Share links (/r/<address>) open the Reserve page again

- **Date:** 2026-11-12
- **Author:** Joao via Claude Code (Claude Opus 5.5)
- **Branch / commits:** `fix/share-link-dtr-id` @ `c6518b3`, merged to `main` (and `design` fast-forwarded)
- **Deployed to:** production (dpl id in PROJECT_STATUS.md); rollback target dpl_9uzQzq3X
- **Decision log:** DEC-0288

## What shipped
Every Reserve link on ssr.fun/leaderboard, and every shared ssr.fun/r/<address> link, ended on "Reserve Not Found" since DEC-0200, because the share page forwarded to `#/dtr/<id>` while the app keys Reserves as `mainnet-beta-<id>`. The share page now links the full id, and the router accepts a bare numeric id.

## Code touched
- `lib/share/resolveReserve.ts` — appUrl is `#/dtr/mainnet-beta-<id>`
- `src/App.tsx` — `withClusterPrefix` maps `/dtr/<digits>` and `/dtr/<digits>/manage` to `<SOLANA_CLUSTER>-<digits>`
- `tests/phase_share_page.ts` — expectations corrected (they pinned the broken form)

## Repositories / environments adjusted
- SSR.FUN: main, design, production deploy. No env, program or API change.

## Effect on others — READ THIS
- New in-app links should still use the full `<cluster>-<id>` form; the bare form is only tolerated.

## Verification
`tests/phase_share_page.ts` 13 passing, `tsc -b` clean, `vite build` clean, live click-through of /r/FFPx… after deploy.
