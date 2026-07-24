# SSR.fun (FABLE)

A prototype/simulation frontend for SSR.fun, a launchpad for decentralized tokenized reserves on Solana. Everything is mocked — no wallet, network, or on-chain program is connected ("Simulation Mode").

Vite + React 19 + TypeScript. Two design systems coexist in this repo:

- **Native** (`src/pages`, `src/components`, `src/state`, `src/domain`, `src/data`): the approved homepage/navbar, hand-written CSS in `src/index.css` using its own `:root` design tokens (`--accent`, `--surface`, `--text-2`, etc.).
- **Ported "merge" pages** (`src/merge/**`): Discover, Create, Portfolio, Manage, and Reserve-detail, ported from the SSR.FUN-MERGE prototype. Styled with Tailwind + shadcn components, scoped under the `.merge-scope` class (`src/merge/merge.css`) so its own color tokens never collide with the native ones — see the comment at the top of `merge.css` for the token-renaming convention (`--font-display` → `--font-merge-display`, `--accent` → `--merge-accent`, etc.) used whenever a merge-side token would otherwise shadow a native `:root` token of the same name.
- Components from either system can be reused inside the other's pages (e.g. `src/components/ReserveCard.tsx` is native-styled but also rendered inside the merge-scoped Discover page) — when doing this, check for token-name collisions first.

## Mandatory terminology

SSR.fun exclusively uses **"Launch Reserve"** as the user-facing call to action for creating/deploying a Reserve, everywhere — headings, buttons, nav items, empty states, everything.

**"Create Your Reserve," "Create Reserve," "Deploy Your Reserve," "Deploy Reserve," and "Launch Your Reserve" must never appear in user-facing product copy** — navigation, buttons, headings, empty states, onboarding, forms, tooltips, success messages, mobile UI, accessibility labels, mock content, or copy constants. This does not apply to internal technical identifiers (e.g. the `createDTR` store action, Anchor instruction names, database fields, or types) — those stay as-is unless there's a separate reason to rename them.

## Approved hero copy

The homepage hero description is approved, exact copy — do not paraphrase it:

> SSR.fun is where anyone can create, launch, and trade decentralized tokenized reserves. Build a basket of Solana assets, set your fees, and issue a Reserve Token backed by transparent, on-chain holdings.

(Lives in `src/pages/Home.tsx`, the `.lede` paragraph in the hero section.)
