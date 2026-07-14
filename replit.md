# BYOR — Build Your Own Reserve

A frontend-only simulation of BYOR, a fictional Solana DTR (Decentralized Token Reserve) trading platform, letting visitors connect a fake wallet and practice buying/selling DTR Tokens with fictional balances.

## Run & Operate

- `pnpm --filter @workspace/byor run dev` — run the BYOR frontend (artifact at `/`)
- `pnpm --filter @workspace/byor run typecheck` — typecheck the BYOR app
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000, unused by BYOR)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- BYOR frontend: React + Vite, wouter routing, Zustand (persisted to localStorage), Recharts, shadcn/radix UI, Tailwind
- No backend/DB for BYOR — it is a closed, client-only simulation with fictional seed data

## Where things live

- `artifacts/byor/src/lib/types.ts` — domain types (DTR, Holding, WalletState, etc.)
- `artifacts/byor/src/lib/seed-data.ts` — 6 fictional DTRs with deterministic composition + price history (`DTRS`, `getDtrById`, `searchDtrs`)
- `artifacts/byor/src/lib/calculations.ts` — trading fee, tokens/USDC received, avg purchase price, unrealized P&L, portfolio value, formatters
- `artifacts/byor/src/store/useAppStore.ts` — Zustand store: fictional wallet connect/disconnect, balances, holdings, buy/sell/reset actions
- `artifacts/byor/src/pages` — Home (`/`), DTR detail (`/dtr/:dtrId`), Portfolio (`/portfolio`)

## Architecture decisions

- Original brief specified Next.js; adapted to this monorepo's react-vite artifact convention with wouter client-side routing instead.
- Frontend-only by design: no API, no database, no OpenAPI codegen — everything (wallet, prices, balances) is fictional and lives in a persisted Zustand store.
- Domain logic (types, seed data, calculations, store) was hand-written; all visual/page/component work was delegated to a design subagent against that fixed data contract.

## Product

- Homepage: hero, aggregate stats, featured/trending DTRs, searchable grid of all 6 DTRs.
- DTR detail page: stats, 24H/7D/30D/All performance chart, composition donut + table, Buy/Sell trading panel with 0.10% fee and 25/50/75/Max quick-fill.
- Portfolio page: wallet balances, DTR Token holdings with avg purchase price and unrealized P&L, empty state before any wallet connect or purchase.
- Persistent "BYOR Simulation Mode" badge; fictional Phantom/Solflare/Backpack wallet connect (same fake wallet regardless of choice), starting balances 25,000 USDC / 50,000 SSR / 20 SOL.

## User preferences

- Strict terminology: use DTR / DTR Token / DTR Asset / DTR Manager / BYOR / NAV / SSR. Never use BYR, SSR.FUN, NAF, NAFT, Fund, ETF, or "share token".

## Gotchas

- In this scaffold, any `@import url(...)` (e.g. Google Fonts) in `index.css` must be the very first line, before `@import "tailwindcss"` — otherwise PostCSS fails silently and styling doesn't apply.
- Packages added via `pnpm add <pkg>` land in `dependencies` by default; for this client-only Vite artifact, move them into `devDependencies` to match the scaffold convention.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
