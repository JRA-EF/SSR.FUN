---
name: Frontend-only artifact package placement
description: pnpm add defaults new packages to dependencies, but client-only Vite artifacts in this monorepo conventionally keep everything in devDependencies.
---

Running `pnpm add <pkg>` (or `pnpm add <pkg>@catalog:`) inside a react-vite artifact package adds the entry under `dependencies` in that package's `package.json`. But the scaffold's existing `package.json` puts essentially everything — React, Radix, Tailwind, Zod, wouter, etc. — under `devDependencies`, since these are static/client-only artifacts with no server-side runtime dependency distinction.

**Why:** Consistency with the existing scaffold convention for purely client-side (Vite-built, statically served) artifacts — there's no meaningful prod/dev split when the whole app is bundled and shipped as static assets.

**How to apply:** After `pnpm add`-ing a new package into a client-only Vite artifact, manually move the new entry from `dependencies` into the (alphabetized) `devDependencies` block and delete the now-empty `dependencies` key.
