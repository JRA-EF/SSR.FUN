# SSR.fun Journey Map

Internal, version-controlled product documentation. **This is not part of the
SSR.fun application** — it is not imported, routed, built, or deployed by the
frontend, it lives only under `docs/journey-map/`, and it is never linked
from the production site.

## What this is

`index.html` is a single, self-contained, offline-first HTML file containing
12 Nielsen Norman Group–style **combined customer journey maps + service
blueprints** for SSR.fun (SSR Protocol) — one grid per journey, covering:

- **Doing / Thinking / Feeling / Pain points / Opportunities / Evidence**
  (the customer-journey half), and
- **Frontstage / Backstage / Support processes** (the service-blueprint half),

separated by the three canonical NN/g divider lines (line of interaction,
line of visibility, line of internal interaction).

It covers discovery/browsing, wallet connection, real on-chain Reserve
creation (success and failure paths), minting (Buy) and redeeming (Sell)
Reserve Tokens (success, insufficient-balance, RPC/infrastructure-failure,
and paused-Reserve paths), Portfolio/Reserve monitoring, delegate
management and permission scoping, pausing/unpausing, protocol/manager fee
collection, and DevNet engineering/verification workflows.

## How to open it

No server, build step, or dependency installation required:

```
open docs/journey-map/index.html
```

(or double-click the file, or drag it into a browser window). Every
journey, the emotion-curve chart, the help modal, and all editable fields
work entirely client-side.

- **Navigate**: click any journey in the left rail, grouped by category.
- **Edit**: Thinking, Feeling (emoji picker), Pain points, Opportunities,
  Evidence, and the Scenario/Goal/Notes fields are all editable. Edits
  autosave to *your browser's own* `localStorage` (key
  `journey-map-annotations`) — nothing is sent anywhere.
- **Emotion curve**: appears automatically under the grid once 2+ moments
  in a journey have a Feeling set.
- **Export / Import**: the toolbar in the rail exports your local
  annotations as a timestamped JSON file, or imports a colleague's (with a
  replace-or-merge prompt).
- **Help**: click the `?` button in the rail, or press `?` anywhere on the
  page, for the full in-app usage guide.

## Generated from the SSR codebase — not invented

This map was produced by inspecting the real SSR.FUN repository — the
Anchor program (`programs/ssr_protocol/`), the Vite/React frontend
(`src/`), the DevNet integration layer (`api/devnet/`,
`packages/sdk/src/`), and the project's own documentation
(`docs/protocol/`, `docs/project/`) — not from a generic template or
assumed functionality.

Every **Doing**, **Frontstage**, **Backstage**, and **Support** field names
a real route, component, store action, API endpoint, Anchor instruction, or
error message actually present in the codebase at the commit below. These
fields are factual and intentionally carry no `[Assumption]` tag.

Every **Thinking**, **Pain point**, and **Opportunity** field is inferred —
a service-design judgment call about what a user might think or feel, or
how the experience could improve — and is **always prefixed with
`[Assumption]`**, per the Journey Mapper schema. None of these were
validated against real user research for this pass.

Every **Evidence** field is intentionally left blank (`""`). Fill it in
from real user research — session recordings, support tickets, interviews
— as it becomes available; it is not something this generation process can
supply.

**Deliberately excluded / marked planned, not fabricated:** two real,
already-implemented, DevNet-tested protocol capabilities —
`pause_reserve`/`unpause_reserve` and `collect_fees` (permissionless fee
collection) — currently have **no frontend UI at all**. Rather than
inventing a UI for them, their journeys ("Pause and unpause a Reserve",
"Collect protocol and manager fees") describe the real on-chain behavior
and explicitly note that today they're only reachable via direct
Anchor/RPC calls (as demonstrated in `scripts/devnet_fixtures.ts`), not
through any button in the product.

## Source commit and generation date

- **Generated:** 2026-07-28
- **SSR.FUN commit:** `c5d71f4bea825b19c056b4b343a6dc2d8a0e0fc2` (`main`)

If SSR.fun's routes, instructions, permission model, or error states change
materially after this commit, the map should be regenerated (see below) —
otherwise its Frontstage/Backstage/Support content will drift from the real
implementation.

## How to regenerate

This file was hand-assembled from the [Journey Mapper](https://github.com/joeyvansommeren/journey-mapper)
skill's `TEMPLATE.html`, following its own `SKILL.md` workflow exactly:

1. Re-inspect the current SSR.FUN codebase (routes in `src/App.tsx`, pages
   under `src/pages/` and `src/merge/pages/`, the Anchor program under
   `programs/ssr_protocol/src/`, the DevNet API layer under `api/devnet/`,
   and `docs/protocol/`/`docs/project/` for anything not obvious from code
   alone — e.g. which capabilities are DevNet-only, which are
   frontend-wired vs. simulated).
2. Re-derive the actors, categories, and journeys per
   [Journey Mapper's `REFERENCE.md`](https://github.com/joeyvansommeren/journey-mapper/blob/main/skills/journey-mapper/REFERENCE.md)
   JSON schema and NN/g structural guidance (2–5 actors, 3–6 categories,
   4–12 journeys, 2–5 stages/journey, 2–4 moments/stage).
3. Take a fresh copy of `TEMPLATE.html` from the upstream repository and
   replace **only**: the `<title>`, the `.rail h1` text, and the
   `<script type="application/json" id="journeys-data">` block — nothing
   else in the template. This file's `index.html` still matches upstream
   `TEMPLATE.html` byte-for-byte outside those three edits.
4. Keep every inferred field `[Assumption]`-prefixed and every `evidence`
   field blank, per the schema rule.
5. Update the commit hash and generation date in this README.
6. Validate: the embedded JSON must `JSON.parse()` cleanly, moment `id`
   values must stay unique and stable (they key user annotations already
   saved in teammates' `localStorage` — **never rename an existing moment
   id**), and the page should be opened in a browser to confirm navigation,
   editing, the emotion curve, autosave, and export/import still work.

## Upstream project and license

Built from the [Journey Mapper](https://github.com/joeyvansommeren/journey-mapper)
project by Joey van Sommeren, licensed under **Apache License 2.0**
(Copyright 2026 Joey van Sommeren). This file is a modified copy of that
project's `skills/journey-mapper/TEMPLATE.html`, as permitted and required
by the Apache-2.0 license:

- The original copyright notice is preserved above.
- This file's changes relative to the upstream template are noted here (per
  License §4(b)): the `<title>`, `.rail h1` text, and the embedded
  `journeys-data` JSON block have been replaced with SSR.fun-specific
  content; no other line of the template was modified (see "How to
  regenerate," step 3, for how this is verified).
- A full copy of the Apache License 2.0 text applying to the upstream
  Journey Mapper project is available at the upstream repository:
  <https://github.com/joeyvansommeren/journey-mapper/blob/main/LICENSE>.
- No other files from the upstream repository (its skill instructions,
  reference docs, or any other assets) are copied into this repository —
  only this one derived HTML file.
