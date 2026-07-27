<!--
  Source of truth for the internal project-status dashboard at /internal/status.
  This file is parsed server-side (api/dashboard/content.ts) and rendered after
  authentication. Keep section headings ("## ...") stable -- the parser splits
  on them. The fenced ```json block under "Roadmap" is the only piece treated
  as structured data (weight + completion per phase); the overall completion
  percentage is computed from it, not hand-entered.

  Update this file whenever meaningful progress, roadmap status, blockers,
  dependencies, risks, validation results, or environment status change. See
  CLAUDE.md > "Project Status and Decision Logging".
-->

## Overall Status
On Track

## Current Phase
Phase 2: Protocol Research and Gap Analysis (not yet started)

## Current Objective
Stand up the internal project-status dashboard and its access control at `/internal/status` before beginning Reserve Protocol research, so progress on the protocol/on-chain work has a durable, non-technical-friendly place to be tracked from day one.

## Executive Summary
The SSR.fun frontend is a complete, deployed simulation of the product: homepage, Discover/Create/Portfolio/Manage flows, and Reserve-detail pages, all running on mock data with no wallet or on-chain connection ("Simulation Mode"). It is hosted on Vercel, reachable at its production domain, and currently kept unlisted (not indexed, not linked publicly) while it's still a testing build. No Solana program work, protocol research, or on-chain architecture has begun yet -- that is the next phase. Today's work is the internal dashboard itself: a password-protected `/internal/status` page so progress, decisions, risks, and blockers are visible at a glance without needing to read commit history.

## Last 5 Working Days
- **2026-07-27 (Mon):** Migrated hosting to Vercel (manual-deploy only), connected the `strategic-super-reserve.fun` custom domain, renamed the hero secondary CTA to "Browse Reserves," hardened the testing deployment as unlisted (noindex, robots.txt, visible "Testing Environment" badge), and built this project-status dashboard with password-protected access.
- **2026-07-24 (Fri):** Unified Reserve card components across the homepage and Discover page, added a real (simulated) wallet-connect modal, expanded the Portfolio page, and completed a terminology pass to align all copy on "Reserve" / "Launch Reserve."
- **2026-07-23 (Thu):** Rebuilt the homepage to match the approved reference design, ported the Discover / Create / Portfolio / Manage / Reserve-detail flows from the SSR.FUN-MERGE prototype, added the eagle seal logo and favicon, and fixed layout issues in the Create-a-Reserve stepper.
- **2026-07-22 (Wed):** No recorded repository activity.
- **2026-07-21 (Tue):** No recorded repository activity.

## Recently Completed
- Vercel hosting migration with manual-only production deploys (no auto-deploy on `git push`).
- Custom domain `strategic-super-reserve.fun` connected and serving the production build.
- Hero secondary CTA renamed "Discover Reserves" → "Browse Reserves."
- Testing deployment hardened as unlisted: `noindex, nofollow`, `robots.txt`, and a visible "Testing Environment" badge.
- This dashboard: password-gated `/internal/status` route with session-cookie auth, logout, and basic login rate limiting.

## In Progress
- Internal project-status dashboard rollout (this feature) -- pending final validation and production deploy.

## Next Actions
- Begin Phase 2: Protocol Research and Gap Analysis (survey comparable Solana launchpad/reserve designs, identify open protocol questions).
- Decide whether the unlisted (no-auth) approach for the general testing site should be upgraded before it's shared more widely.
- Consider a code-splitting pass on the frontend bundle (see Technical Health) before Phase 2 adds more surface area.

## Roadmap

```json
[
  { "phase": 1, "name": "Frontend Foundation", "weight": 10, "completion": 1.0, "status": "done" },
  { "phase": 2, "name": "Protocol Research and Gap Analysis", "weight": 10, "completion": 0.0, "status": "not_started" },
  { "phase": 3, "name": "Solana Reserve Architecture", "weight": 15, "completion": 0.0, "status": "not_started" },
  { "phase": 4, "name": "Core Solana Program", "weight": 20, "completion": 0.0, "status": "not_started" },
  { "phase": 5, "name": "Client and Frontend Integration", "weight": 15, "completion": 0.0, "status": "not_started" },
  { "phase": 6, "name": "DevNet Testing and Security Validation", "weight": 15, "completion": 0.0, "status": "not_started" },
  { "phase": 7, "name": "Restricted Beta", "weight": 10, "completion": 0.0, "status": "not_started" },
  { "phase": 8, "name": "Production Readiness", "weight": 5, "completion": 0.0, "status": "not_started" }
]
```

## Blockers
No blockers currently affecting the in-progress phase.

## Dependencies
- Vercel (hosting, deployment, custom domain, and the environment variable used by this dashboard).
- Name.com (domain registrar and DNS for `strategic-super-reserve.fun`).
- Solana DevNet access -- not yet required, will become a dependency starting Phase 4.

## Risks
- **No automated test suite exists.** Typecheck and build are the only automated verification today; regressions rely on manual review.
- **Main JS bundle exceeds 500 kB** (pre-minification chunk-size warning from Vite). Not urgent at current scope, but will compound as Phase 5 adds real client/on-chain integration code.
- **The general testing site relies on obscurity, not authentication**, for its "unlisted" status (see Decision Log DEC-0004). Acceptable for now; revisit before any wider or public testing round.
- **Reserve Protocol scope is not yet defined.** Phase 2 has no start date locked in yet.

## Decisions Required
- Should Phase 2 (Protocol Research) start immediately, or should frontend/tooling cleanup (bundle size, test coverage) come first?
- Should the general testing site move from "unlisted" to real authentication before it's shared with anyone outside the immediate team?

## Technical Health
- **Typecheck:** passing (`tsc -b`).
- **Build:** passing (`vite build`), with a non-blocking chunk-size warning on the main JS bundle.
- **Tests:** none exist yet -- no test script or test files in the repository.
- **Lint:** `oxlint` configured and available (`npm run lint`).
- **CI:** none configured; deploys are manual and intentional (see Decision Log DEC-0001).

## Environment Status
- **Local:** `npm run dev` (Vite dev server) -- always available to any developer with the repo, unauthenticated by design.
- **Development:** Vercel Preview deployments, created manually via `vercel` (no `--prod`); not linked from any production page.
- **DevNet:** Not yet provisioned -- no Solana program exists to deploy. Expected to become active in Phase 4.
- **Production:** `https://strategic-super-reserve.fun` (aliased from `ssr-fun.vercel.app`) -- live, frontend-only simulation, kept unlisted.

## Last Updated
2026-07-27 17:50 UTC
