# SSR.fun (FABLE)

A prototype/simulation frontend for SSR.fun, a launchpad for decentralized tokenized reserves on Solana. Everything is mocked — no wallet, network, or on-chain program is connected ("Simulation Mode").

Vite + React 19 + TypeScript. Two design systems coexist in this repo:

- **Native** (`src/pages`, `src/components`, `src/state`, `src/domain`, `src/data`): the approved homepage/navbar, hand-written CSS in `src/index.css` using its own `:root` design tokens (`--accent`, `--surface`, `--text-2`, etc.).
- **Ported "merge" pages** (`src/merge/**`): Discover, Create, Portfolio, Manage, and Reserve-detail, ported from the SSR.FUN-MERGE prototype. Styled with Tailwind + shadcn components, scoped under the `.merge-scope` class (`src/merge/merge.css`) so its own color tokens never collide with the native ones — see the comment at the top of `merge.css` for the token-renaming convention (`--font-display` → `--font-merge-display`, `--accent` → `--merge-accent`, etc.) used whenever a merge-side token would otherwise shadow a native `:root` token of the same name.
- Components from either system can be reused inside the other's pages (e.g. `src/components/ReserveCard.tsx` is native-styled but also rendered inside the merge-scoped Discover page) — when doing this, check for token-name collisions first.

## Mandatory terminology

**Final, as of 2026-07-29 (see `docs/project/DECISION_LOG.md` and `docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md` round 3) — this supersedes the prior wording of this section, which used "Reserve" for the whole basket entity:**

- **Decentralized Token Reserve** = the complete basket/product.
- **Reserve** = each underlying asset held *inside* a Decentralized Token Reserve (e.g. a specific DevNet test mint backing the basket). Do not use "Reserve" alone to mean the whole product in new copy.
- **Reserve Token** = the fungible token representing ownership of the complete Decentralized Token Reserve.

SSR.fun exclusively uses **"Launch a Decentralized Token Reserve"** (not "Launch a Reserve") as the user-facing call to action for creating/deploying the whole basket product, everywhere — headings, buttons, nav items, empty states, everything.

**"Create Your Reserve," "Create Reserve," "Deploy Your Reserve," "Deploy Reserve," "Launch Your Reserve," "Launch Reserve" (unqualified), "BYOR," "BOR," "DTR Asset," and "Reserve asset" must never appear in user-facing product copy** — navigation, buttons, headings, empty states, onboarding, forms, tooltips, success messages, mobile UI, accessibility labels, mock content, or copy constants. Use "Reserve" only when referring to an underlying holding, never the whole basket.

**This does not apply to internal technical identifiers** (e.g. the `createDTR` store action, `DTRAsset`/`CreateDTRAssetInput` TypeScript types, Anchor instruction names, database fields, or types) — those stay as-is unless there's a separate reason to rename them. **In particular, do not rename the deployed on-chain Anchor account structs `Reserve`, `ReserveAsset`, `Delegate`, or `ProtocolConfig`** (`programs/ssr_protocol/src/state/*.rs`) regardless of this terminology change: Anchor derives each account's on-chain discriminator from its struct name at compile time, so renaming any of them would change the discriminator new builds expect and break deserialization of every already-initialized account on live DevNet. These are documented as legacy technical identifiers, not approved product terminology — the product-facing meaning of "Reserve" above does not apply to the Rust/Anchor `Reserve`/`ReserveAsset` struct names, which keep their pre-existing sense (the account model's "Reserve" = the whole basket account, matching the *old* product terminology) purely for on-chain compatibility.

## Approved hero copy

The homepage hero description is approved, exact copy — do not paraphrase it:

> SSR.fun is where anyone can create, launch, and trade decentralized tokenized reserves. Build a basket of Solana assets, set your fees, and issue a Reserve Token backed by transparent, on-chain holdings.

(Lives in `src/pages/Home.tsx`, the `.lede` paragraph in the hero section.)

## Project Status and Decision Logging

This repo has an internal, password-protected project dashboard at `/internal/status`, rendered server-side from two source-of-truth files:

- `docs/project/PROJECT_STATUS.md` -- overall status, weighted roadmap, blockers, risks, environments, etc.
- `docs/project/DECISION_LOG.md` -- append-only log of material decisions.

**Update `PROJECT_STATUS.md` in the same session, without being asked, whenever you:** make meaningful progress, change roadmap/phase status or completion, add or resolve a blocker or risk, change a dependency, get new validation/test results, or change what's running in Local/Development/DevNet/Production. Recompute the overall completion percentage from the weighted roadmap block -- never hand-edit that number independently of the phase weights/completions.

**Append to `DECISION_LOG.md` in the same session, without being asked, whenever a material product, technical, architecture, security, or operational decision is confirmed, rejected, changed, or superseded.** Each entry needs: decision ID, date, status, decision, context, rationale, alternatives considered, impact, affected areas, superseded/superseding links, and evidence. Never edit the substantive fields of an existing entry -- a changed decision gets a new entry, linked via `supersedes`/`supersededBy`.
