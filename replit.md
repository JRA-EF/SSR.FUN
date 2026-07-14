# SSR.FUN

A frontend-only simulation of SSR.FUN, a Solana protocol for creating, managing, and trading Decentralized Token Reserves (DTRs). Visitors connect a fake wallet, browse/trade DTRs, deploy their own DTR, and manage it (delegate permissions, manual rebalancing) — all with fictional balances and data, no real blockchain calls.

## Run & Operate

- `pnpm --filter @workspace/byor run dev` — run the SSR.FUN frontend (artifact at `/`)
- `pnpm --filter @workspace/byor run typecheck` — typecheck the app
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000, unused by this app)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, wouter routing, Zustand (persisted to localStorage), Recharts, shadcn/radix UI, Tailwind
- No backend/DB — closed, client-only simulation with fictional seed data

## Where things live

- `artifacts/byor/src/lib/types.ts` — domain types (DTR, Delegate, ManagerPermissions, FeeConfig, Holding, WalletState, CreateDTRInput, etc.)
- `artifacts/byor/src/lib/seed-data.ts` — fictional seed DTRs with deterministic composition + price history (`DTRS`, `getDtrById`, `searchDtrs`)
- `artifacts/byor/src/lib/calculations.ts` — trading fee, tokens/USDC received, avg purchase price, unrealized P&L, portfolio value, Mint Fee, `applyRebalance`, formatters
- `artifacts/byor/src/store/useAppStore.ts` — Zustand store: wallet connect/disconnect, balances, holdings, buy/sell/reset, `dtrs` as live mutable state, `createDTR`, delegate management (`addDelegate`/`updateDelegatePermissions`/`removeDelegate`), `rebalanceDTR`; also exports `isManagerOrDelegate`/`canManageDelegates`/`canRebalance` permission guards
- `artifacts/byor/src/pages` — Home (`/`), DTR detail (`/dtr/:dtrId`), Portfolio (`/portfolio`), Create DTR (`/create`), Manager Dashboard (`/dtr/:dtrId/manage`)

## Architecture decisions

- Original brief specified Next.js; adapted to this monorepo's react-vite artifact convention with wouter client-side routing instead.
- Frontend-only by design: no API, no database, no OpenAPI codegen — everything (wallet, prices, balances, DTR catalog) is fictional and lives in a persisted Zustand store.
- Domain/state logic (types, seed data, calculations, store with permission guards) was hand-written for correctness; visual/page/component work was delegated to a design subagent against that fixed data contract.
- `dtrs` lives in the store (not a static import) so DTR creation and rebalancing can mutate it live and persist across reloads.

## Product

- Homepage: hero, aggregate stats, featured/trending DTRs, searchable grid of all DTRs.
- DTR detail page: stats, 24H/7D/30D/All performance chart, composition donut + table (shows Unallocated USDC Reserve when present), Buy/Sell trading panel with 0.10% fee, "Manage Reserve" entry point for the manager/delegates.
- Create DTR flow (`/create`): multi-step — identity, basket composition/weights, fee configuration (Mint Fee, Annualized TVL Fee, Manager Tax, fee destination), review & deploy. Deploying makes the connected wallet the root DTR Manager.
- Manager Dashboard (`/dtr/:dtrId/manage`): gated by root-Manager/delegate status and per-permission checks (`manageDelegates`, `rebalance`, `feeAdmin`, `pause`, `metadata`). Sections: Overview, Delegates (add/edit/remove with a permission checklist), Rebalance (editable target weights + required "Adjust Remaining Assets" checkbox — checked proportionally rescales the rest of the basket to 100%, unchecked leaves the shortfall as Unallocated USDC Reserve).
- Portfolio page: wallet balances, DTR Token holdings with avg purchase price and unrealized P&L, empty state before any wallet connect or purchase.
- Persistent "Simulation Mode" badge; fictional Phantom/Solflare/Backpack wallet connect (same fake wallet regardless of choice), starting balances 25,000 USDC / 50,000 SSR / 20 SOL.
- Visual identity: light-first theme, purple/violet primary with purple-pink gradient accents, styled after strategic-super-reserve.com. Fonts: Work Sans (primary UI/body), Lexend Giga (hero/display), Space Grotesk (secondary/numeric accent). No logo yet — user will provide one later; wordmark is plain text "SSR.FUN".

## User preferences

- Product must be branded **SSR.FUN** (not BYOR) — this supersedes any earlier note banning that name.
- Logo: user will provide it later — do not design or generate a mascot/icon in the meantime.

## Gotchas

- In this scaffold, any `@import url(...)` (e.g. Google Fonts) in `index.css` must be the very first line, before `@import "tailwindcss"` — otherwise PostCSS fails silently and styling doesn't apply.
- Packages added via `pnpm add <pkg>` land in `dependencies` by default; for this client-only Vite artifact, move them into `devDependencies` to match the scaffold convention.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
