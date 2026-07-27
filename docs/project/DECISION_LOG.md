<!--
  Append-only decision log for the internal project-status dashboard.
  Parsed server-side (api/dashboard/content.ts): each decision is an
  "## DEC-XXXX" heading followed by a fenced ```json block with its fields.

  Rules:
  - Never edit the substantive fields (decision/context/rationale/alternatives
    considered/impact/affectedAreas/evidence) of an existing confirmed entry.
  - A changed or reversed decision gets a NEW entry; only the `supersedes` /
    `supersededBy` links may be added to older entries to connect the chain.
  - Always append new entries at the end of the file.

  See CLAUDE.md > "Project Status and Decision Logging" for when to add one.
-->

## DEC-0001

```json
{
  "id": "DEC-0001",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Host the SSR.fun frontend on Vercel, with Git-triggered deployments disabled (git.deploymentEnabled: false) so only explicit manual deploys (vercel --prod) publish changes.",
  "context": "The project previously ran only on Replit. A Vercel project (ssr-fun) was created and linked to the same GitHub repository to give more control over build/output configuration and custom-domain handling.",
  "rationale": "Manual-only deploys prevent every push to main from immediately going live, which matters while the site is still a frequently-iterated testing build and while access-control work (like this dashboard) is landing incrementally.",
  "alternativesConsidered": [
    "Leave Git-triggered auto-deploy enabled (rejected: too easy to accidentally ship an in-progress change)",
    "Use Vercel's default per-branch preview deploys only, no production alias (rejected: still need one stable production URL)"
  ],
  "impact": "All future production releases require an explicit `vercel --prod` run; there is no passive auto-deploy path.",
  "affectedAreas": ["deployment", "vercel.json", "CI/CD process"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["vercel.json: git.deploymentEnabled = false", "Vercel project ssr14/ssr-fun"]
}
```

## DEC-0002

```json
{
  "id": "DEC-0002",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Keep the existing Replit deployment running, untouched, during and after the migration to Vercel.",
  "context": "Before Vercel hosting was set up, the site was already live on Replit with its own custom-domain DNS record. Migrating hosting did not require decommissioning that deployment.",
  "rationale": "Avoids downtime or accidental loss of the working Replit setup while Vercel hosting was still being configured and validated; removing Replit is a separate, deliberate decision to make later if it's no longer needed.",
  "alternativesConsidered": [
    "Immediately disable/delete the Replit deployment (rejected: unnecessary risk with no upside during migration)"
  ],
  "impact": "Two hosting platforms exist in parallel for now. DNS for the apex domain has since moved to Vercel (DEC-0003), so Replit is no longer the live target for the custom domain, but the Replit deployment itself has not been touched.",
  "affectedAreas": ["hosting", "DNS"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["Replit deployment left running throughout the Vercel migration and domain cutover"]
}
```

## DEC-0003

```json
{
  "id": "DEC-0003",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Connect strategic-super-reserve.fun to the Vercel project via A-records at the existing Name.com DNS provider, rather than migrating nameservers to Vercel.",
  "context": "The domain's DNS was already hosted at Name.com. Vercel offered two options to point the domain at it: change nameservers to ns1/ns2.vercel-dns.com, or add A-records at the current DNS provider.",
  "rationale": "A-records are the less disruptive of the two options -- they don't move the whole DNS zone to a new provider, keeping any other existing DNS records at Name.com unaffected.",
  "alternativesConsidered": [
    "Migrate nameservers to Vercel's (rejected: unnecessarily broad change for what was needed)"
  ],
  "impact": "strategic-super-reserve.fun and www.strategic-super-reserve.fun both resolve to Vercel's edge (76.76.21.21); DNS remains managed at Name.com.",
  "affectedAreas": ["DNS", "custom domain"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["A records for strategic-super-reserve.fun and www resolve to 76.76.21.21 via Name.com nameservers"]
}
```

## DEC-0004

```json
{
  "id": "DEC-0004",
  "date": "2026-07-27",
  "status": "superseded",
  "decision": "Protect the entire testing deployment with server-side email-allowlist authentication (Vercel Routing Middleware enforcing HTTP Basic Auth, checked against an approved-email environment variable).",
  "context": "Initial request was to make the whole testing site private, accessible only to explicitly approved people.",
  "rationale": "A platform-level middleware check in front of every route was judged the simplest way to gate the whole site server-side without a database or auth framework.",
  "alternativesConsidered": [
    "Vercel's native deployment protection / password protection (would need dashboard/plan-level changes)",
    "A frontend-only password screen (rejected outright: not real access control)"
  ],
  "impact": "Implementation (middleware.ts, an @vercel/functions dependency, and a tsconfig include) was built but reverted the same day before being committed, once the requirement changed to an unlisted (no-auth) approach. See DEC-0005.",
  "affectedAreas": ["access control", "middleware", "whole-site auth"],
  "supersedes": null,
  "supersededBy": "DEC-0005",
  "evidence": ["middleware.ts and related changes were written, then fully reverted (git checkout / file removal) before commit"]
}
```

## DEC-0005

```json
{
  "id": "DEC-0005",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Run the general testing site as unlisted rather than authenticated: no login of any kind, `noindex, nofollow` plus robots.txt to discourage indexing, no public links to the domain, and a visible 'Testing Environment' badge.",
  "context": "The requirement for the general testing site changed from 'require approved-person authentication' to 'anyone with the exact URL can access it, but it should not be discoverable or indexed.'",
  "rationale": "Matches the actual need (keep it out of search results and off any public nav, not restrict who can view it) with far less implementation surface than real authentication, and avoids the auth complexity captured in DEC-0004.",
  "alternativesConsidered": [
    "Keep the DEC-0004 email-allowlist approach (superseded -- more than what was actually asked for)",
    "Do nothing (rejected: site would remain fully public and indexable)"
  ],
  "impact": "The general site has no access control at all; anyone with the URL has full, unauthenticated access. This is a deliberate, documented limitation (see docs/project/UNLISTED_TESTING_ACCESS.md).",
  "affectedAreas": ["index.html", "public/robots.txt", "src/components/Shell.tsx", "src/index.css", "documentation"],
  "supersedes": "DEC-0004",
  "supersededBy": null,
  "evidence": ["docs/project/UNLISTED_TESTING_ACCESS.md"]
}
```

## DEC-0006

```json
{
  "id": "DEC-0006",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Password-protect only the new /internal/status project dashboard, using a server-verified session cookie -- not the general testing site (which stays unlisted per DEC-0005).",
  "context": "A new internal-only project-status dashboard was requested at /internal/status, needing real access control (a password check anyone could rely on), distinct from the general testing site's unlisted-but-open approach.",
  "rationale": "The dashboard exposes internal planning content (status, risks, decisions) that genuinely warrants a real access check, unlike the public-facing product simulation, which was deliberately left open per DEC-0005. Scoping auth to just this one route keeps the rest of the site's behavior, design, and navigation completely unchanged.",
  "alternativesConsidered": [
    "Extend real authentication to the whole site again (rejected: reopens DEC-0004, more than the dashboard needs, and contradicts DEC-0005)",
    "Frontend-only password comparison (rejected outright per requirements: not real access control)"
  ],
  "impact": "Only /internal/status and its data endpoint require a password; every other route/page is unaffected.",
  "affectedAreas": ["middleware.ts", "api/dashboard/*", "lib/dashboard/session.ts", "internal-status.html", "src/internal-status/*"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["middleware.ts matcher scoped to /internal/status and /api/dashboard/content only"]
}
```

## DEC-0007

```json
{
  "id": "DEC-0007",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Sequence work so the project-status dashboard and its access control are built before any Reserve Protocol research or Solana program implementation begins.",
  "context": "Explicit instruction: do not begin Reserve Protocol research or Solana implementation until the dashboard exists.",
  "rationale": "Having a durable, non-technical-friendly status view in place first means Phase 2 (Protocol Research) progress is tracked from its very first day, rather than being reconstructed retroactively.",
  "alternativesConsidered": [
    "Start Phase 2 research in parallel with the dashboard build (rejected: explicitly out of scope for this work)"
  ],
  "impact": "Phase 2 has not started as of this entry; Current Objective in PROJECT_STATUS.md reflects the dashboard build itself.",
  "affectedAreas": ["roadmap sequencing", "PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["PROJECT_STATUS.md: Current Phase = Phase 2 (not yet started); Current Objective = dashboard build"]
}
```
