# Memory Index

- [Vite scaffold CSS import order](vite-scaffold-css-import-order.md) — Google Fonts `@import url()` in index.css must be the very first line or PostCSS fails silently.
- [Frontend-only artifact package placement](frontend-only-package-placement.md) — `pnpm add` defaults to `dependencies`; client-only Vite artifacts conventionally put everything in `devDependencies`.
- [Design-subagent handoff for stateful sims](design-subagent-domain-first.md) — build domain/store layer yourself first, then delegate full UI/rebrand to a design subagent against that fixed contract.
- [Byor floating-card drag/collision physics](byor-floating-card-physics.md) — infinite-mass dragged body + restitution >1 impulse collisions for arcade-y "throw and clash" card physics.
