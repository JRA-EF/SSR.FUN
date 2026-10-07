# Portfolio Reserve Holdings: one-click column sort; GitHub secrets audit

- **Date:** 2026-10-07
- **Author:** Joao via Claude Code (Claude Opus 5.5)
- **Branch / commits:** `main` @ `69636f8` (.gitignore hardening), `00d059d` (holdings sort); merged into `design` here
- **Deployed to:** none yet. Production deploy of `main` is pending (also still pending: DEC-0228 @ `5bc1bf5`)
- **Decision log:** none

## What shipped
- Portfolio > Reserve Holdings: every data column header is a sort button. First click sorts highest-first (Asset: A-Z), the next click on the same column inverts. Legacy rows with no price stay at the bottom. Action is not sortable.
- Secrets audit of the public repo (all branches, full history): no live secret found. `.gitignore` now also blocks CLI wallets (`id.json`), `*deployer*.json`, `*signer*.json`, `*wallet*.json`, PEM/P12 keys and service-account JSON.

## Code touched
- `src/merge/lib/holdingsSort.ts` (new) — pure sort state + ordering.
- `src/merge/pages/Portfolio.tsx` — `SortableHead` header buttons (aria-sort), rows rendered through `sortHoldingsRows`.
- `tests/phase_portfolio_holdings_sort.ts` (new, 7 tests). `.gitignore`.

## Effect on others — READ THIS
- If you add a column to the holdings table, add a `HoldingsSortKey` and a case in `holdingsSortValue`.
- Naming a file `*wallet*.json` / `*signer*.json` now hides it from git on purpose.
- Open security items for the owners: the "SSR.fun — Simple Feedback" Google Sheet linked from `src/internal-feedback/Feedback.tsx` is set to "anyone with the link can edit" (owner must restrict it); confirm the rotated Helius key 12f1afb9… is deleted in Helius (it is still in history and on 36 stale branches); enable GitHub secret scanning + push protection.

## Verification
Offline phase suite 1311 passing, 5 failing (known pre-existing set); `npx tsc -b` exit 0; `vite build` OK.
