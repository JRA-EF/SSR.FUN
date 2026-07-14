---
name: Vite scaffold CSS import order
description: Google Fonts / external @import url() in index.css must precede all other statements including @import "tailwindcss", or PostCSS fails silently.
---

In the react-vite scaffold used by this project's artifacts, `src/index.css` typically starts with `@import 'tailwindcss'` and `@import 'tw-animate-css'`. If a design subagent (or you) adds a Google Fonts `@import url(...)` line, it must be placed *before* those tailwind imports — as the very first line of the file.

**Why:** PostCSS/Vite requires all `@import` statements to precede other CSS rules (besides `@charset`/empty `@layer`). Putting the font import after `@import 'tailwindcss'` doesn't throw a build error users notice immediately — it's a Vite CSS warning (`@import must precede all other statements`) that silently drops the font import, so custom fonts just don't apply and it's easy to miss.

**How to apply:** When reviewing a freshly generated/edited `index.css`, check that any `@import url(...)` for fonts is the first line, above `@import 'tailwindcss'`. If restarting the workflow after a design pass shows this warning in logs, move the font import to the top.
