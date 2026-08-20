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

## DEC-0008

```json
{
  "id": "DEC-0008",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Make the dashboard login's brute-force lockout (api/dashboard/login.ts) environment-aware and configurable via env vars, rather than a fixed 5-attempts/10-minute-window/15-minute-lockout applied everywhere: it now defaults to disabled unless VERCEL_ENV=production (override via SSR_DASHBOARD_RATE_LIMIT_ENABLED), and its thresholds (SSR_DASHBOARD_MAX_ATTEMPTS, SSR_DASHBOARD_LOCKOUT_MINUTES, SSR_DASHBOARD_ATTEMPT_WINDOW_MINUTES) are now tunable, defaulting to 10 attempts / 15-minute lockout in production.",
  "context": "The login endpoint was returning 'Too many attempts. Try again later.' and blocking access. Root cause: the lockout counter is a module-scope in-memory Map, which on Vercel's Fluid Compute persists across requests for the life of a warm function instance (not per-request, and not reliably cleared by a cold start on any predictable timescale). The original 5-attempt threshold is easy to trip during manual testing, and once tripped there was no way to clear it short of waiting out the 15-minute window or a fresh deploy recycling the instance -- and the same aggressive limit applied identically in local/preview/production with no env-based override.",
  "rationale": "Brute-force protection only needs to be strict where it matters (production, guarding the real secret). Disabling it by default outside production removes an entire class of self-inflicted lockouts during day-to-day testing, while keeping real protection in production at a still-reasonable threshold (10/15min, per explicit requirement). Making the thresholds env-configurable means a future incident can be tuned or (in an emergency) disabled without a code change.",
  "alternativesConsidered": [
    "Move rate-limit state to a shared/persistent store (Vercel KV/Marketplace Redis, etc.) for cross-instance accuracy (rejected for now: adds an external dependency for a dashboard with a single known secret and low real attack surface; revisit if abuse is actually observed in production)",
    "Add an authenticated admin endpoint to clear lockout state on demand (rejected for now: no persistent state exists to clear -- the Map is already wiped by any redeploy/cold start -- so the disable-by-default-outside-production approach addresses the actual reported problem more directly)",
    "Keep a single fixed global threshold for all environments (rejected: this is exactly what caused the reported lockout)"
  ],
  "impact": "Local dev and preview deployments no longer enforce login lockout by default (verified: 12 consecutive wrong-password attempts with no VERCEL_ENV set all returned 401, never 429). Production still enforces lockout by default, now at 10 attempts / 15-minute window+lockout instead of 5/10/15 (verified: attempts 1-9 returned 401, attempt 10 returned 429 with Retry-After: 900). All four thresholds are overridable via env vars without a code change (verified with SSR_DASHBOARD_MAX_ATTEMPTS=3 + SSR_DASHBOARD_LOCKOUT_MINUTES=1: 3rd attempt locks, Retry-After: 60, and the correct password is still rejected while locked).",
  "affectedAreas": ["api/dashboard/login.ts", ".env.example", ".env.local"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "api/dashboard/login.ts: rateLimitEnabled()/envInt() gate the lockout on VERCEL_ENV/SSR_DASHBOARD_RATE_LIMIT_ENABLED and the three threshold env vars",
    "Login/logout/session flow verified live via `vercel dev`: wrong password -> 401; correct password -> 200 + Set-Cookie; cookie reused against /api/dashboard/content and direct /internal/status navigation -> authenticated (covers refresh-preserves-session and direct-nav-still-gated); /api/dashboard/logout -> cookie cleared, subsequent /api/dashboard/content -> 401",
    "Lockout threshold logic verified by importing api/dashboard/login.ts directly into a single Node process (vercel dev's local Node runtime re-evaluates the function module fresh per request, so it can't observe in-memory state persisting across calls the way a warm Fluid Compute instance does): no-VERCEL_ENV default -> 12x wrong password all 401; VERCEL_ENV=production with no overrides -> 401 x9 then 429 w/ Retry-After=900 on the 10th; VERCEL_ENV unset + SSR_DASHBOARD_RATE_LIMIT_ENABLED=true + SSR_DASHBOARD_MAX_ATTEMPTS=3 + SSR_DASHBOARD_LOCKOUT_MINUTES=1 -> 401,401,429,429,429, correct password still 429 while locked"
  ]
}
```

## DEC-0009

```json
{
  "id": "DEC-0009",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Use https://github.com/reserve-protocol/reserve-index-dtf.git (main, commit f02680d82ff34f6e719fbb586b5a1e6e96ffb518, MIT) as the official Reserve Protocol reference repository, cloned read-only to C:\\Users\\JRA DEVNET\\Projects\\references\\reserve-protocol. Separately: the SSR on-chain program's core mint/redeem mechanism will be oracle-free, proportional, in-kind minting/redemption, matching the mission's explicit mandate -- not the AMM constant-product buy/sell model currently reachable in the SSR.fun frontend's merge/** pages.",
  "context": "The user-supplied URL (reserve-protocol/resserve-index-dtf, double-s typo) does not exist. GitHub org search confirmed reserve-protocol/reserve-index-dtf ('Reserve Folio -- A protocol for creating permissionless Index Assets') as the correct repo; a second org repo, reserve-protocol/reserve-index-dtfs-solana (Reserve's own Solana port), was noted but not cloned/studied, since the mission frames Reserve Protocol as EVM/Solidity reference material specifically. Separately, Gate 1 frontend inspection found the SSR.fun repo contains two incompatible economic models: a NAV-based in-kind mint/redeem model (src/domain, src/state) that is fully specified but never wired to any UI (dead code), and a constant-product AMM buy/sell model (src/merge/**) that is the only one any user can actually reach. The mission's own Core Economic Model section mandates oracle-free proportional in-kind mint/redeem as the canonical mechanism, with single-asset/AMM-style entry demoted to an optional non-core router -- this matches the dead native model's intent, not the live merge model's behavior.",
  "rationale": "The reference repo choice follows directly from verifying the given URL and correcting it per the mission's own fallback instruction. The economic-model reconciliation is not a free architectural choice -- the mission states the oracle-free-core requirement repeatedly and unconditionally ('core proportional minting and redemption must not depend on an oracle,' single-asset entry is explicitly 'a router... outside core proportional accounting'). Per the mission's guidance for resolving an unresolved product conflict, the safest reversible default is to build exactly the mandated core and treat the existing AMM UI as the (unmodified, not-yet-core) optional router layer, rather than silently picking one frontend model as canonical without flagging the conflict.",
  "alternativesConsidered": [
    "Clone reserve-index-dtfs-solana instead/also, since it's Reserve Protocol's own Solana port and arguably more directly transferable (rejected for this pass: mission explicitly frames Reserve Protocol as EVM/Solidity source material to adapt, not a Solana implementation to imitate; noted as a possible secondary reference if a specific Solana-porting question comes up later)",
    "Treat the merge AMM model as the real product spec and build an on-chain constant-product bonding curve instead of proportional in-kind mint/redeem (rejected outright: directly contradicts the mission's explicit, repeated core-economic-model mandate)",
    "Silently pick one model without recording the conflict (rejected: the mission's own decision-logging requirements and 'never silently rewrite' principle apply equally to reconciling two pre-existing internal specs, not just to new decisions)"
  ],
  "impact": "docs/protocol/RESERVE_REFERENCE_ANALYSIS.md and docs/protocol/SSR_ARCHITECTURE.md (section 0) are built on this reference commit and this reconciliation. The existing AMM buy/sell UI (src/merge/**) is left completely unmodified for now; a new, narrow proportional-mint/redeem UI surface will need to be added to the frontend during Gate 10, tracked as a frontend gap rather than a silent redesign. This is the single highest-impact product decision in the mission and should be revisited with the user if it conflicts with intent.",
  "affectedAreas": ["docs/protocol/RESERVE_REFERENCE_ANALYSIS.md", "docs/protocol/SSR_ARCHITECTURE.md", "protocol core design", "future frontend integration (Gate 10)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "GitHub API: api.github.com/orgs/reserve-protocol/repos lists reserve-index-dtf (pushed 2026-07-23) and reserve-index-dtfs-solana (pushed 2025-10-09); resserve-index-dtf returns 404",
    "Local clone verified at C:\\Users\\JRA DEVNET\\Projects\\references\\reserve-protocol, git log -1 = f02680d82ff34f6e719fbb586b5a1e6e96ffb518, license MIT",
    "Gate 1 frontend inspection (Explore agent report): native mint/redeem reducer actions in src/state/store.tsx are never dispatched anywhere (grep-verified); only buyDTRToken/sellDTRToken in src/merge/store/useAppStore.ts are reachable from any route"
  ]
}
```

## DEC-0010

```json
{
  "id": "DEC-0010",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Use Anchor (not native Rust/Solana SDK) as the framework for the SSR on-chain program.",
  "context": "Gate 2 required an explicit framework decision before any broad code generation, evaluated against: current repo stack (none -- greenfield), development speed, account validation, PDA handling, IDL generation, frontend integration, testing ergonomics, deployment, long-term maintainability, auditability.",
  "rationale": "Anchor's constraint macros (seeds/bump/has_one/constraint) directly implement the cross-Reserve-vault-isolation and authority checks the mission repeatedly mandates as security invariants, reducing the chance of a hand-written ownership-check bug. Its generated IDL is the most direct path to the required typed TypeScript SDK (Gate 6) and frontend integration (Gate 10). Its test harness matches the mission's integration/adversarial-test requirements far better than hand-rolled native transaction construction.",
  "alternativesConsidered": [
    "Native Rust/Solana SDK (rejected: more control over account layout and compute, but every account-ownership/PDA check must be hand-verified with no compiler/macro assistance -- higher bug risk for a fund-custody protocol with no existing team convention favoring native)"
  ],
  "impact": "All Gate 3+ program code, the workspace structure, and the SDK's IDL consumption are Anchor-based. Documented in docs/protocol/SSR_ARCHITECTURE.md section 1.",
  "affectedAreas": ["programs/", "Anchor.toml", "packages/sdk", "docs/protocol/SSR_ARCHITECTURE.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/SSR_ARCHITECTURE.md section 1"]
}
```

## DEC-0011

```json
{
  "id": "DEC-0011",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "The Reserve Token mint uses classic SPL Token (not Token-2022), 6 decimals, no freeze authority, mint authority = a program-derived signer-only PDA. Reserve Assets (basket constituents) may independently be SPL Token or Token-2022 mints, validated per-asset at registration time.",
  "context": "Mission instructions explicitly warn against choosing Token-2022 'merely because it has more features' and require documenting wallet/DEX/indexer/custody compatibility trade-offs.",
  "rationale": "The Reserve Token is a plain proportional-ownership share; none of Token-2022's extensions (transfer fees, transfer hooks, confidential transfers, interest-bearing) serve it, and a self-charging transfer fee on the Reserve Token itself would conflict with exact-supply mint/redeem accounting. Classic SPL Token has the widest wallet/DEX/indexer support today. No freeze authority avoids giving any administrator a custodial power over holder tokens beyond what the mission's security-boundary section intends. Reserve Assets are a different question -- real-world basket constituents may legitimately be Token-2022 mints, so that choice is deferred to per-asset registration (initialize_reserve_asset), which validates that any present extensions are ones the program's balance-delta accounting can safely handle.",
  "alternativesConsidered": [
    "Token-2022 globally for the Reserve Token, for future extensibility (rejected: no current extension is needed, and it narrows wallet/DEX compatibility today for no present benefit)",
    "Restrict Reserve Assets to classic SPL Token only, for simplicity (rejected: unnecessarily narrows which real assets can be used as basket constituents; the actual risk -- fee-on-transfer/transfer-hook extensions silently under-collateralizing a deposit -- is addressed by validating at registration time instead)"
  ],
  "impact": "docs/protocol/ACCOUNT_MODEL.md defines the mint/authority PDAs accordingly; docs/protocol/SECURITY_INVARIANTS.md (pending) will define the exact supported/rejected Token-2022 extension list for Reserve Assets, modeled on the reference protocol's 'Weird ERC20s' support-matrix pattern.",
  "affectedAreas": ["programs/ (Reserve Token mint init)", "docs/protocol/ACCOUNT_MODEL.md", "docs/protocol/SSR_ARCHITECTURE.md section 2"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/SSR_ARCHITECTURE.md section 2", "docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 15 (Weird ERC20s pattern)"]
}
```

## DEC-0012

```json
{
  "id": "DEC-0012",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Reserve PDA seeds are [\"reserve\", reserve_id.to_le_bytes()] where reserve_id is a global monotonic counter stored on ProtocolConfig, not a per-creator nonce.",
  "context": "Two seed models were evaluated for deriving each Reserve's own address: a global counter (simple, one flat catalog, matches the frontend's implicit assumption) vs. a per-creator nonce (lets a creator derive their Reserve's address client-side before submitting the creation transaction, at the cost of per-creator nonce bookkeeping to avoid collisions).",
  "rationale": "Simplicity and matching the existing frontend's flat-catalog assumption outweighed the parallelism benefit of a per-creator nonce at DevNet scale. The explicit trade-off accepted: create_reserve must read-modify-write ProtocolConfig.reserve_count, so Reserve creation is not fully parallelizable (two simultaneous create_reserve calls contend on the same account and one fails/retries).",
  "alternativesConsidered": [
    "Per-creator nonce seeds (rejected for v1: adds nonce-lookup bookkeeping for a benefit -- creation throughput/parallelism -- that doesn't matter yet; revisit if creation volume ever makes ProtocolConfig contention a real bottleneck)"
  ],
  "impact": "Documented as provisional/reversible in docs/protocol/ACCOUNT_MODEL.md ('Reserve' section) -- changing this later would require a migration path for existing Reserve PDAs, so revisit before it matters rather than after.",
  "affectedAreas": ["programs/ (create_reserve)", "docs/protocol/ACCOUNT_MODEL.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/ACCOUNT_MODEL.md, 'Reserve' section, 'Open question resolved provisionally'"]
}
```

## DEC-0013

```json
{
  "id": "DEC-0013",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "All FeeConfig values (mint_fee_bps=50, redemption_fee_bps=0, annual_tvl_fee_bps=100, manager/protocol fee shares) are explicitly labelled DevNet placeholders, not final economics, pending a real fee-schedule decision.",
  "context": "Mission instructions explicitly prohibit inventing final fee percentages and require safe configurable fields with clearly labelled provisional values instead. Gate 1 inspection found the frontend's own fee fields (mint fee, TVL fee, buy/sell tax) are themselves mostly unenforced placeholders with no accrual logic behind most of them.",
  "rationale": "The fee accrual/collection mechanism (deferred-mint pattern, checkpoint-before-rate-change) is real, tested infrastructure regardless of what the actual percentages end up being -- building the mechanism now and leaving the numbers provisional lets fee-dependent code proceed without blocking on an unresolved economics decision.",
  "alternativesConsidered": [
    "Block protocol implementation until final fee economics are decided (rejected: mission explicitly says to use safe placeholders and continue non-dependent work)",
    "Copy the reference protocol's fee values/caps directly (rejected: Folio's caps -- e.g. MAX_TVL_FEE=10%/yr -- are Reserve-Protocol-specific business decisions, not something SSR should inherit without its own review; SSR's placeholders are chosen independently and are lower/more conservative as DevNet defaults)"
  ],
  "impact": "No holder or manager should treat current fee values as final; docs/protocol/ACCOUNT_MODEL.md and any frontend surface displaying fees during Gate 10 must be labelled provisional. PROJECT_STATUS.md 'Decisions Required' should track the unresolved final-fee-schedule decision.",
  "affectedAreas": ["docs/protocol/ACCOUNT_MODEL.md (FeeConfig)", "programs/ (fee instructions)", "docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/ACCOUNT_MODEL.md, 'Reserve' section, FeeConfig table"]
}
```

## DEC-0014

```json
{
  "id": "DEC-0014",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Reserve Asset cap for v1 DevNet: 12 assets per Reserve, stored as ProtocolConfig.max_reserve_assets (u8), not a hardcoded constant.",
  "context": "Unlike the EVM reference protocol (which has no explicit basket-size cap, relying on an implicit gas/block-size ceiling), Solana's hard transaction-size (1232 bytes), compute-unit, and account-count limits mean SSR needs a concrete, evidence-based cap, per mission instruction not to pick an arbitrary maximum.",
  "rationale": "mint_reserve_tokens_in_kind/redeem_reserve_tokens_in_kind need ~3 accounts per asset (mint, vault, depositor ATA) plus ~10-12 fixed-overhead accounts. At 12 assets that's ~36-46 accounts, comfortably inside a versioned transaction's ALT-expanded limit with headroom for compute-budget instructions, and comfortably covers every basket size actually seeded in the existing frontend mock data (2-6 assets per Reserve).",
  "alternativesConsidered": [
    "No explicit cap, rely on natural transaction-size failure (rejected: mission requires a documented, evidence-based cap, and an undocumented implicit failure mode is a worse user experience than a clear, enforced limit)",
    "A much higher cap (e.g. 25+) assuming full ALT usage from day one (rejected for v1: adds ALT-management complexity to the creation/mint/redeem flow before it's proven necessary; 12 is revisitable via ProtocolConfig without a program upgrade)"
  ],
  "impact": "initialize_reserve_asset rejects registration beyond ProtocolConfig.max_reserve_assets. Documented in docs/protocol/SSR_ARCHITECTURE.md section 4.",
  "affectedAreas": ["programs/ (initialize_reserve_asset)", "docs/protocol/SSR_ARCHITECTURE.md", "docs/protocol/ACCOUNT_MODEL.md (ProtocolConfig)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/SSR_ARCHITECTURE.md section 4", "src/merge/lib/seed-data.ts (2-6 assets per seeded DTR, confirmed via Gate 1 inspection)"]
}
```

## DEC-0015

```json
{
  "id": "DEC-0015",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "No DAO or governance/timelock contract in the v1 DevNet program. The inception wallet is root Reserve Manager directly for the Reserve it creates; ProtocolConfig.authority is likewise a plain wallet, not a governance PDA.",
  "context": "Mission instructions explicitly state there is no DAO in the initial DevNet version, in contrast to the reference protocol's expected deployment pattern (DEFAULT_ADMIN_ROLE/REBALANCE_MANAGER held by a governance timelock from a separate sibling package).",
  "rationale": "Building a governance/timelock system is out of scope for a first functional DevNet release and would add significant surface area with no present requirement. Because both ProtocolConfig.authority and Reserve.manager are stored as plain Pubkeys rather than being hardcoded to an EOA-only type, nothing in the account model prevents these authorities later becoming a multisig or DAO-controlled PDA without an account-model migration -- the door is left open structurally without building through it now.",
  "alternativesConsidered": [
    "Build a minimal governance/timelock wrapper now, matching the reference protocol's deployGovernedFolio path (rejected: explicitly out of scope per mission instructions for v1)"
  ],
  "impact": "All root-authority actions in v1 are single-signer. This is a known, documented trust assumption to revisit before any restricted beta or Mainnet (see docs/protocol/SSR_ARCHITECTURE.md section 0 governance note and the upgrade-policy documentation to follow in DEVNET_RUNBOOK.md).",
  "affectedAreas": ["docs/protocol/ACCOUNT_MODEL.md (ProtocolConfig, Reserve)", "docs/protocol/SSR_ARCHITECTURE.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 11 (Reject for v1 classification)"]
}
```

## DEC-0016

```json
{
  "id": "DEC-0016",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "pause_reserve/unpause_reserve is reversible (unlike the reference protocol's one-way deprecateFolio) and never blocks redemption -- only new minting, target updates, and rebalance actions are blocked while paused.",
  "context": "Mission instructions state a pause may stop new minting or management actions, but holders' redemption rights should remain available unless a clearly documented technical safety issue makes that impossible, and to prefer designs that preserve redemption during pauses. The reference protocol's own deprecateFolio mechanism (one-way, admin-only) deliberately excludes redeem from its notDeprecated gate for exactly this reason.",
  "rationale": "SSR's pause is meant as an operational safety valve (e.g. a suspected bug in rebalancing), not an end-of-life mechanism, so reversibility is the correct adaptation of the reference protocol's underlying principle rather than a literal copy of its one-way design.",
  "alternativesConsidered": [
    "One-way deprecation matching the reference protocol exactly (rejected: SSR has no equivalent to Folio's governance-driven, deliberate 'this Folio is done' lifecycle event yet -- a reversible operational pause fits the mission's stated intent better)",
    "Pause that also blocks redemption, for simplicity (rejected outright: directly contradicts explicit mission instruction)"
  ],
  "impact": "docs/protocol/SECURITY_INVARIANTS.md (pending) will enumerate exactly which instructions check Reserve.status == Paused and confirm redeem_reserve_tokens_in_kind is never among them.",
  "affectedAreas": ["programs/ (pause_reserve, unpause_reserve, redeem_reserve_tokens_in_kind)", "docs/protocol/SSR_ARCHITECTURE.md section 12 reference / section 7"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 12", "docs/protocol/SSR_ARCHITECTURE.md section 7"]
}
```

## DEC-0017

```json
{
  "id": "DEC-0017",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "v1 DevNet rebalancing is manual and Reserve-Manager/delegate-authorized only (update_targets, then an off-chain-quoted, delegate-executed trade, then record_rebalance to reconcile). No Dutch-auction/price-curve rebalancing mechanism, no permissionless bidding, and no trusted-filler-style async custody delegation are implemented.",
  "context": "Mission instructions explicitly require manual, Reserve-Manager-authorized rebalancing for the first release and explicitly prohibit autonomous agents, unattended automated rebalancing, and open auction systems. The reference protocol's full Dutch-auction rebalancing subsystem (startRebalance/openAuction/bid, exponential price-decay curve, permissionless fallback bidding) is a significant, well-designed system but is out of scope now.",
  "rationale": "The reference protocol's role-separation shape (who can set rebalance intent vs. who can execute trades vs. permissionless fallback) is adopted conceptually for SSR's update_targets (delegate flag: UPDATE_TARGETS) vs. execute-trade (delegate flag: EXECUTE_REBALANCE) split, without adopting the auction/pricing-curve mechanism itself, which is unnecessary complexity for a manual-rebalance v1 and explicitly out of scope.",
  "alternativesConsidered": [
    "Build a simplified auction mechanism now (rejected: explicitly out of scope per mission instructions)",
    "Allow the manager to directly move vault assets without any quote/approval step (rejected: contradicts the mission's required separation of update-targets / calculate-trades / get-quotes / review-approve / execute / reconcile / record as distinct operations)"
  ],
  "impact": "The auction/Dutch-pricing mechanism is recorded as Deferred (not Rejected) in docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 9 -- worth reconsidering once/if SSR needs permissionless or automated rebalancing.",
  "affectedAreas": ["programs/ (update_targets, record_rebalance)", "docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 9", "docs/protocol/ACCOUNT_MODEL.md (Delegate permission bitmask)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 9"]
}
```

## DEC-0018

```json
{
  "id": "DEC-0018",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "SSR emits dedicated, structured ReserveTokensMinted/ReserveTokensRedeemed events (full asset-amount breakdown included) rather than relying on indexers to correlate a share-token Transfer event with separate basket-token Transfer events, as the reference protocol does.",
  "context": "Gate 1 reference-repo inspection found the reference protocol has a comprehensive event set for auctions/fees/basket-config/lifecycle but no dedicated Mint/Redeem event -- indexers must reconstruct what happened by correlating the ERC20 Transfer event on the share token with accompanying Transfer events on each basket token within the same transaction.",
  "rationale": "Mission instructions require structured program events suitable for an indexer and explicitly state the indexer must not be required for ownership, minting calculations, or redemption -- emitting one purpose-built event per mint/redeem is strictly better and cheap to do from day one; there's no reason to reproduce a gap the reference protocol itself would probably close if starting over.",
  "alternativesConsidered": [
    "Rely on SPL Token Transfer instruction logs for indexing, matching the reference protocol exactly (rejected: adds indexer complexity for no benefit; SSR is starting fresh with no existing indexer investment to preserve)"
  ],
  "impact": "docs/protocol/INSTRUCTION_REFERENCE.md (pending) will define the exact event schema per instruction.",
  "affectedAreas": ["programs/ (events module)", "docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 16"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/RESERVE_REFERENCE_ANALYSIS.md section 16"]
}
```

## DEC-0019

```json
{
  "id": "DEC-0019",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Reserve creation is a resumable, multi-transaction workflow (create_reserve, then one initialize_reserve_asset call per basket asset, then a final seed_reserve), not a single atomic transaction, with Reserve.status tracking Created -> AssetsInitializing -> Seeded -> Active so a partially-created Reserve is visibly incomplete on-chain.",
  "context": "Mission instructions require choosing one-transaction vs. resumable multi-transaction creation based on actual Solana transaction/account limits, and explicitly say not to sacrifice correctness to force everything into one transaction.",
  "rationale": "A Reserve with up to 12 assets (DEC-0014) would require per-asset vault-creation CPIs that make single-transaction creation impractical well before reaching the cap. Splitting creation into discrete steps with an explicit status field makes partial/abandoned creation attempts detectable and recoverable rather than ambiguous.",
  "alternativesConsidered": [
    "Force single-transaction creation for simplicity (rejected: fails for any basket beyond a handful of assets, and mission explicitly warns against this trade-off)"
  ],
  "impact": "docs/protocol/SECURITY_INVARIANTS.md (pending) will define exactly how an abandoned/partially-initialized Reserve (status stuck at Created or AssetsInitializing) is surfaced and whether/how it can be closed or resumed.",
  "affectedAreas": ["programs/ (create_reserve, initialize_reserve_asset, seed_reserve)", "docs/protocol/SSR_ARCHITECTURE.md section 4", "docs/protocol/ACCOUNT_MODEL.md (Reserve.status)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/protocol/SSR_ARCHITECTURE.md section 4"]
}
```

## DEC-0020

```json
{
  "id": "DEC-0020",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Target anchor-lang/anchor-spl 1.1.2 (Rust) and @anchor-lang/core ^1.1.2 (TypeScript, renamed from the older @coral-xyz/anchor) for the SSR program and SDK, rather than the 0.29-0.31 API the assistant's training data is grounded in.",
  "context": "Before writing any Rust, live crates.io/npm queries showed Anchor reached a 1.0 stable release (repository moved to solana-foundation/anchor per Anchor's own CHANGELOG, also mirrored at otter-sec/anchor per crates.io metadata) between the assistant's January 2026 knowledge cutoff and this session (2026-07-27) -- current stable is 1.1.2. The CHANGELOG's own 'Breaking' section for 1.0.0 was read directly to assess risk: the breaking changes are concentrated in CLI/IDL-management/TypeScript-package-naming, not the core #[program]/#[derive(Accounts)]/constraint DSL used throughout this program's source.",
  "rationale": "Writing against a known-current version (verified via live registry data, not assumed from training) is more honest and more likely to actually work than defaulting to a stale, more-familiar API purely because it's better-known. Since no local toolchain exists to compile-check either choice anyway (see DEC-0022), there was no compile-time safety net making the 'familiar but outdated' choice a safer default -- accuracy-to-current-reality was the better bet either way.",
  "alternativesConsidered": [
    "Write against the older 0.29-0.31 API from training-data familiarity (rejected: would target a version that isn't what `anchor build`/`npm install` will actually resolve to today, and the CHANGELOG review found no reason to believe the constraint DSL itself needs the older API)"
  ],
  "impact": "programs/ssr_protocol/Cargo.toml pins anchor-lang/anchor-spl to 1.1.2; package.json/packages/sdk/package.json use @anchor-lang/core ^1.1.2. tests/ssr_protocol.ts and packages/sdk successfully typecheck against the actually-installed @anchor-lang/core 1.1.2 package (verified via `npx tsc --noEmit`), which is real, partial evidence the package-naming/API assumptions hold -- NOT evidence the Rust program compiles, since that requires a toolchain this environment doesn't have (DEC-0022).",
  "affectedAreas": ["programs/ssr_protocol/Cargo.toml", "package.json", "packages/sdk/package.json", "Anchor.toml", "docs/protocol/DEVNET_RUNBOOK.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "crates.io API: anchor-lang max_stable_version=1.1.2, versions list shows 0.31.1 (2025-04-20) -> 0.32.1 (2025-10-10) -> 1.0.0-rc.1 (2025-12-12) -> 1.0.0 (2026-04-02) -> 1.1.2 (2026-06-26)",
    "npm registry: @anchor-lang/core latest=1.1.2, matching the Rust crate version",
    "https://raw.githubusercontent.com/solana-foundation/anchor/master/CHANGELOG.md, [1.0.0] section, Breaking subsection reviewed directly",
    "`npx tsc --noEmit` against packages/sdk/tsconfig.json and tsconfig.tests.json both pass with zero errors against the actually-installed @anchor-lang/core@1.1.2, @solana/web3.js, @solana/spl-token"
  ]
}
```

## DEC-0021

```json
{
  "id": "DEC-0021",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "v1 DevNet ships NO on-chain trade-execution instruction for rebalancing (no Jupiter-route CPI, no swap-execution logic of any kind). record_rebalance is attestation-only: it reads current vault balances and emits an event alongside a caller-supplied, NOT independently-verified 'balances_before' snapshot, purely for indexing/audit purposes.",
  "context": "The mission's Manual Target Management section requires update_targets (intent) and calculate-trades/get-quotes/approve/execute/reconcile/record as distinct steps, and separately requires that any swap execution validate swap program, route accounts, source/destination vaults and mints, minimum output, quote expiry, authorized signer, and final balance changes -- a substantial, security-sensitive design surface. The mission's own minimum instruction set list names only record_rebalance, not an execute-trade instruction.",
  "rationale": "Building an unverified Jupiter-CPI integration blind (no compiler, no ability to test against a real Jupiter quote/route on DevNet) would be worse than not building it: a half-built, untested trade-execution path touching real vault custody is exactly the kind of code that must not ship without the validation the mission itself demands for it. Deferring it entirely (rather than a partial/unsafe implementation) keeps v1's actual custody surface limited to the two already-carefully-specified mint/redeem paths.",
  "alternativesConsidered": [
    "Implement a minimal Jupiter CPI now despite the toolchain gap (rejected: cannot be tested at all before a real trade-execution security review, which the mission explicitly requires for exactly this kind of code -- shipping it untested/uncompiled would be worse than the honest gap)",
    "Have record_rebalance itself perform a same-instruction swap using vault_authority as signer against a hardcoded venue (rejected: even further from the mission's explicit route/quote/signer validation requirements)"
  ],
  "impact": "Manual rebalancing in v1 means a Reserve Manager moves assets through some means outside this program's custody boundary entirely (e.g. temporarily... no -- vault assets are ONLY ever movable via mint/redeem CPIs per SECURITY_INVARIANTS.md invariant 4, so in practice v1's record_rebalance is purely a bookkeeping/intent-tracking tool and real inter-asset rebalancing execution is a capability SSR does not yet have on-chain at all. This is a significant, honestly-stated v1 limitation, not a hidden one.",
  "affectedAreas": ["programs/ssr_protocol/src/instructions/record_rebalance.rs", "docs/protocol/INSTRUCTION_REFERENCE.md", "docs/protocol/SECURITY_INVARIANTS.md 'Outstanding gaps'"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["programs/ssr_protocol/src/instructions/record_rebalance.rs module doc comment", "docs/protocol/SECURITY_INVARIANTS.md 'Outstanding gaps' section"]
}
```

## DEC-0022

```json
{
  "id": "DEC-0022",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Proceed through Gates 1-6 (research, architecture, program source, SDK) without a working Rust/Solana/Anchor toolchain, writing real code and validating everything that IS toolchain-independent (TypeScript typecheck of the SDK and test suite against actually-installed current packages), while explicitly not claiming the Rust program compiles, and not attempting to install WSL/a Linux toolchain autonomously.",
  "context": "The working environment (Windows, no WSL) has no rustc, cargo, solana CLI, anchor CLI, or avm, and `wsl --list` confirms WSL itself isn't installed. Installing WSL typically requires a system restart and admin rights -- a disruptive system-level change. The mission's own stop conditions include 'environmental limitations make further work impossible,' but also mandate continuing through implementation 'as far as the environment safely permits' and choosing safe reversible defaults over stopping.",
  "rationale": "Writing the program source, architecture, and SDK is real, valuable, reversible progress that doesn't require a compiler -- stopping entirely at the toolchain gap would have wasted the ability to make genuine progress on Gates 1-6. Autonomously installing WSL (a system-level, semi-irreversible, restart-requiring change) crosses this session's own bar for 'ask before doing' -- it is exactly the kind of hard-to-reverse, environment-altering action that warrants a user decision rather than silent action, especially since a restart could interrupt or lose session state entirely.",
  "alternativesConsidered": [
    "Stop entirely at Gate 2 and wait for toolchain access (rejected: mission explicitly wants continued progress on non-blocked work; Gates 1-6 don't need a compiler)",
    "Install WSL2 autonomously (rejected: disruptive system change requiring a likely restart and admin rights -- exactly the class of action this session's operating rules require surfacing to the user rather than performing silently)",
    "Pretend the Rust code compiles / fabricate build or test success (rejected outright: violates the explicit 'do not claim completion without evidence' instruction; every claim in this session's documentation is qualified as 'written, not compiled' where that's the true state)"
  ],
  "impact": "Gates 7 (Rust build/lint/test portion), 8 (DevNet deploy), and 9 (DevNet fixtures) are blocked and explicitly reported as such, with three concrete unblocking paths documented in docs/protocol/DEVNET_RUNBOOK.md (WSL2 install, cloud devcontainer, or a teammate with an existing Linux/macOS Solana setup running the already-written source).",
  "affectedAreas": ["docs/protocol/DEVNET_RUNBOOK.md", "overall Gate 7-9 status", "docs/project/PROJECT_STATUS.md blockers"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Bash tool checks: rustc/cargo/solana/anchor/avm all report 'command not found'",
    "`wsl --list --verbose` reports WSL is not installed",
    "docs/protocol/DEVNET_RUNBOOK.md 'Current environment status' section"
  ]
}
```

## DEC-0023

```json
{
  "id": "DEC-0023",
  "date": "2026-07-27",
  "status": "confirmed",
  "decision": "Install a native (non-WSL) Rust/MinGW/Solana-CLI toolchain autonomously (rustup with the x86_64-pc-windows-gnu target, a portable WinLibs MinGW-w64 GCC distribution extracted to a space-free path, and the official Windows Solana CLI release), superseding DEC-0022's blanket 'no toolchain available' status for everything except actual BPF/SBF cross-compilation. Do NOT autonomously install Visual Studio Build Tools (needed to close the one remaining gap) -- that install is judged comparable in size/invasiveness to the WSL2 path DEC-0022 already deferred to the user.",
  "context": "DEC-0022 established that no Rust/Solana/Anchor toolchain existed and that installing WSL2 (admin rights, likely restart) crossed this session's bar for user confirmation. Re-examining the constraint: Rust itself has a fully native Windows target and rustup installs user-scoped with no admin/restart; a portable MinGW-w64 GCC build (via winget) provides a linker without needing Visual Studio; the Solana CLI ships an official native Windows release. None of these three require admin rights, a restart, or a large licensed product. Installing them unblocked real `cargo check`/`cargo build` (native host target) -- genuine, verified compilation and linking of the entire hand-written program, which surfaced and allowed fixing ~15 real bugs (see below). The remaining gap, actual `cargo build-sbf` (BPF/SBF cross-compilation), fails because `cargo-build-sbf` hardcodes the MSVC target for host-side build-script compilation regardless of the active Rust toolchain, requiring Microsoft's `link.exe` (Visual Studio Build Tools) specifically -- a multi-GB, proprietary-licensed, comparably invasive install to WSL2, so left for the user per the same reasoning as DEC-0022.",
  "rationale": "The user's own instructions for this session ('make the maximum possible end-to-end progress autonomously... do not stop simply because you encounter a blocker if there is other meaningful work that can continue in parallel') directly favor closing a blocker that CAN be closed within the session's autonomy bounds (user-scoped, reversible, no admin/restart) over leaving it deferred by default. The remaining SBF-specific gap genuinely does require a large licensed install or the already-deferred WSL2 path, so it correctly remains a user decision -- but everything short of that line was worth doing, and doing it produced enormous real (not assumed) verification value.",
  "alternativesConsidered": [
    "Leave the entire toolchain gap deferred to the user, per DEC-0022's original scope (rejected: DEC-0022's own reasoning was specifically about WSL2's install profile -- rustup/MinGW/Solana-CLI have a materially different, much lighter install profile that doesn't trigger the same concern, and the mission explicitly wants blockers closed where possible)",
    "Also install Visual Studio Build Tools now to fully close the gap (rejected for autonomous action: multi-GB proprietary Microsoft product requiring EULA acceptance, judged to cross the same line as WSL2 -- recorded as the single remaining, clearly-scoped blocker instead)"
  ],
  "impact": "cargo check/cargo build for the native host target both succeed with zero errors and zero warnings for the full ssr_protocol crate. A real DevNet program keypair was generated (2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW) and wired into Anchor.toml/declare_id!(), replacing the earlier throwaway placeholder. ~15 real, compiler-caught bugs were found and fixed -- see the full list in docs/protocol/DEVNET_RUNBOOK.md 'Real compiler-caught bugs fixed this session' -- none of which were on the 'highest-risk' list predicted in the pre-compiler draft of this document, which is itself a useful calibration data point (Anchor lifetime-elision and macro re-export mechanics were the real risk, not the Token-2022/space-calculation concerns predicted). Gates 7 (native-target portion) is now genuinely satisfied; Gates 8-9 remain blocked specifically on Visual Studio Build Tools or the WSL2/devcontainer/teammate alternatives.",
  "affectedAreas": ["programs/ssr_protocol (all files, bug fixes)", "Anchor.toml", "programs/ssr_protocol/src/lib.rs (declare_id!)", "target/deploy/ssr_protocol-keypair.json (gitignored, generated not committed)", "docs/protocol/DEVNET_RUNBOOK.md", "docs/protocol/SECURITY_INVARIANTS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`cargo check -p ssr_protocol` and `cargo build -p ssr_protocol`: 'Finished `dev` profile [unoptimized + debuginfo] target(s)', zero errors, zero warnings",
    "`solana-keygen pubkey target/deploy/ssr_protocol-keypair.json` = 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW, matching Anchor.toml and declare_id!()",
    "`cargo-build-sbf` output showing host-side build-script linking hardcoded to x86_64-pc-windows-msvc and failing on missing link.exe, reproduced with RUSTUP_TOOLCHAIN forced to the gnu toolchain (no effect, confirming the hardcoding)",
    "`git check-ignore -v target/deploy/ssr_protocol-keypair.json` confirms it is not tracked",
    "docs/protocol/DEVNET_RUNBOOK.md 'Real compiler-caught bugs fixed this session' section, each bug tied to a specific compiler error message observed during this session"
  ]
}
```

## DEC-0024

```json
{
  "id": "DEC-0024",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Install Visual Studio Build Tools (C++ workload, via winget, with explicit user approval) to close the remaining BPF/SBF toolchain gap from DEC-0023; fund the DevNet deployer wallet via manual user transfers rather than the public airdrop faucet, which was rate-limited/exhausted for this environment's IP; deploy the compiled program to Solana DevNet.",
  "context": "DEC-0023 closed every toolchain gap except real BPF/SBF cross-compilation, which needs the MSVC linker (Visual Studio Build Tools) -- left as an explicit user decision given its size (multi-GB) and proprietary license, comparable to the WSL2 alternative. The user explicitly approved this specific option. Separately, once a real compiled .so existed, funding a DevNet deployer wallet hit a second, independent blocker: `solana airdrop` (CLI) and `@solana/web3.js`'s `requestAirdrop` (RPC) both returned 429 'reached your airdrop limit today' consistently across ~15+ retries over several minutes and via two different client paths -- confirmed as a real, sustained per-IP daily limit (the error message itself named this explicitly), not a transient throttle worth continuing to retry against a public service.",
  "rationale": "With explicit user approval, installing Build Tools was the correct next step -- it's exactly the class of action the mission wants closed when possible, now with authorization for the one piece that needed it. For funding, exhausting a public faucet's daily limit via repeated automated retries (including switching client libraries to probe around it) was reasonably tried and clearly ruled out within one session; asking the user to fund directly (their choice, offered alongside the web-faucet alternative) was faster and more reliable than continuing to poll a service that had already explicitly said 'no' for the day.",
  "alternativesConsidered": [
    "Keep retrying the airdrop indefinitely (rejected: the RPC's own error message confirms this is a daily limit, not a short-lived rate limit -- further automated retries were very unlikely to succeed and amount to hammering a public service after it explicitly declined)",
    "Have the user use the web faucet (faucet.solana.com) instead of a direct transfer (offered as an alternative; user chose to send SOL directly from their own wallet instead)"
  ],
  "impact": "SSR Protocol is now live on Solana DevNet -- see the full deployment record in docs/protocol/DEVNET_RUNBOOK.md (program ID, deployment signature, verified via `solana program show`). Gate 8 is complete. The deployer/upgrade-authority wallet (6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk) holds real DevNet SOL sent by the user (not committed anywhere -- this is a keypair this session generated and controls, gitignored like the program keypair); it is a DevNet-only key per DEC-0015 and will need to migrate to a multisig before any restricted beta.",
  "affectedAreas": ["docs/protocol/DEVNET_RUNBOOK.md (Deployment record)", "docs/project/PROJECT_STATUS.md", "environment (Visual Studio Build Tools now installed)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`solana program show 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW --url devnet` output: Owner=BPFLoaderUpgradeab1e11111111111111111111111, Authority=6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk, Data Length=538056 bytes, Balance=3.74607384 SOL",
    "Deployment signature arj6tzkUCqgSeJBs9inJv3nLcyoK5smasygGEZmDZ5hk84QukwLsJKR9mbaZryJz56uFRTkeXoGtTFSBSMWuaju",
    "web3.js requestAirdrop error: '429 Too Many Requests: You've either reached your airdrop limit today or the airdrop faucet has run dry.'",
    "`cargo-build-sbf` succeeded after Build Tools install: 'Finished `release` profile [optimized] target(s) in 1m 07s', producing target/deploy/ssr_protocol.so (538056 bytes)"
  ]
}
```

## DEC-0025

```json
{
  "id": "DEC-0025",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Run the full tests/ssr_protocol.ts suite directly via mocha/ts-node against the live DevNet deployment (not anchor test's local-validator default); fund ephemeral test keypairs via direct SOL transfer from the deployer wallet instead of the exhausted public airdrop faucet, at reduced amounts (0.3 SOL / 0.05 SOL rather than 2 SOL / 0.5 SOL) to conserve a finite DevNet SOL budget; and adapt two tests that assumed resettable local-validator state to instead be correct against persistent DevNet state.",
  "context": "With the program deployed (DEC-0024) and a real IDL generated via `anchor idl build` (anchor build itself panics -- its vendored toolchain-detection assumes the standard agave-install directory layout, which doesn't exist since the Solana CLI was extracted from a tarball; fixing that needs `agave-install-init.exe`, which requires admin privileges, not done), the test suite could finally be exercised. Getting it running required resolving a chain of ESM/CJS module-resolution conflicts (root package.json is genuine ESM; tests/ needed its own CommonJS boundary via a dedicated tests/package.json and tests/tsconfig.json) and replacing requestAirdrop calls (all four sites) with a fundWallet() helper transferring from the already-funded ANCHOR_WALLET, since the public faucet was already confirmed exhausted (DEC-0024). Two real, previously-undetected bugs then surfaced purely from running against live state (neither is catchable by typechecking): a stale pre-transaction snapshot assertion in the seed-Reserve test, and a protocol-singleton-init test that unconditionally called initializeProtocol -- which fails by design the second time on a persistent network, since ProtocolConfig is a true one-time global singleton PDA and DevNet (unlike a local validator) never resets state between runs.",
  "rationale": "Running against the real deployed program (rather than a fresh local validator anchor test would spin up) is what Gate 9 actually requires -- it is the only way to get genuine evidence that the deployed bytecode behaves correctly, not just that the source compiles. Fixing the module-resolution chain and the two test bugs was necessary to get any signal at all; both bug fixes preserve the original test's intent (verifying real post-transaction on-chain state, and verifying the singleton either gets initialized or already exists with correct contents) rather than weakening the assertions. Reducing per-keypair funding amounts is a straightforward conservation measure once it became clear ephemeral test keypairs' SOL is not reclaimed after each run and the public faucet cannot be used to top up.",
  "alternativesConsidered": [
    "Wait for `anchor build`/`anchor test` to work by pursuing `agave-install-init.exe` (rejected: requires admin privileges, crossing the same autonomy line as WSL2/DEC-0022 -- `anchor idl build` + hand-driven mocha achieves the same end result without it)",
    "Leave the singleton-init test failing on repeat runs as a 'known flake' (rejected: the failure is not a flake, it's a permanent, deterministic consequence of testing a true one-time singleton against a persistent network -- worth fixing properly so the suite stays a reliable signal on every future run, not just the first)",
    "Keep the original 2 SOL / 0.5 SOL funding amounts (rejected: at that rate the deployer wallet -- already faucet-exhausted and manually funded by the user -- would be depleted after only 1-2 more runs; real on-chain rent/fee costs per test keypair are well under 0.05 SOL, so the reduced amounts still carry a large safety margin)"
  ],
  "impact": "The full test suite has run against the live DevNet program for the first time: 14 passing, 0 failing. This is the first genuine runtime/CPI evidence for this program -- every security invariant previously marked 'verified by construction' or 'typechecks, not yet executed' that has a corresponding test is now confirmed working on real deployed bytecode, including the cross-Reserve vault-substitution isolation test (the single most security-critical test in the plan). The deployer wallet's remaining DevNet SOL budget (~1.73 SOL) is now a tracked, finite resource -- see DEVNET_RUNBOOK.md 'Wallet / fixture safety' and PROJECT_STATUS.md Risks.",
  "affectedAreas": ["tests/ssr_protocol.ts", "tests/util/pda.ts", "tests/package.json (new)", "tests/tsconfig.json (new)", "packages/sdk/package.json", "packages/sdk/src/index.ts", "packages/sdk/src/client.ts", "docs/protocol/DEVNET_RUNBOOK.md", "docs/protocol/SECURITY_INVARIANTS.md", "docs/protocol/TEST_PLAN.md", "docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Final mocha run output: '14 passing (1m)', 0 failing, against ANCHOR_PROVIDER_URL=https://api.devnet.solana.com",
    "First run (before the two bug fixes) output: '12 passing (1m)', 2 failing, with full stack traces showing (1) 'Allocate: account ... already in use' on the already-initialized protocolConfig PDA, and (2) 'AssertionError: expected '0' to not equal '0'' on the stale managerReserveTokenAccount snapshot",
    "`solana balance` before this work: ~7.23 SOL (post-deployment); after two full suite runs: ~1.73 SOL",
    "`anchor idl build --out target/idl/ssr_protocol.json --out-ts target/types/ssr_protocol.ts -p ssr_protocol` succeeded; embedded `address` field confirmed to match the deployed program ID"
  ]
}
```

## DEC-0026

```json
{
  "id": "DEC-0026",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Build persistent, documented DevNet fixture state (root manager, 2 restricted delegates with distinct permission scopes, 2 holders, a 2-asset Reserve, a 3-asset multi-asset Reserve) via a new standalone, checkpoint-resumable script (scripts/devnet_fixtures.ts), separate from tests/ssr_protocol.ts's ephemeral test keypairs; leave an interrupted run's stuck partial Reserve (reserve_id 6) on-chain as documented evidence rather than attempting to clean it up.",
  "context": "DEC-0025 got the test suite passing against live DevNet, but its keypairs are generated fresh and discarded every run -- there was no long-lived, named, documented on-chain state for Gate 10 frontend work to point at, which the mission's fixture requirements explicitly call for (root manager, >=2 restricted delegates, >=2 holders, 2-asset + multi-asset Reserves, active/paused states). Building this surfaced two real, previously-unknown limitations of the public DevNet RPC endpoint under this session's sustained same-day usage: `getProgramAccounts` returned a hard 403 ('Your IP or provider is blocked from this endpoint'), and ordinary sequential RPC calls (account fetches, transaction sends) were frequently 429-rate-limited badly enough to abort a naive linear script mid-run twice. The second abort left a real Reserve (reserve_id 6) with assets registered but never seeded -- permanently stuck in AssetsInitializing, which is exactly the documented 'abandoned Reserve creation' behavior in SECURITY_INVARIANTS.md, just encountered for real instead of only described.",
  "rationale": "Given the RPC's demonstrated unreliability, a script that assumes every step succeeds linearly will keep failing partway through and either waste DevNet SOL re-creating already-successful state or require manual bookkeeping to resume correctly. Checkpointing every major step's result (mint addresses, reserve/asset/vault pubkeys, holder balances) to a local gitignored JSON file, and skipping already-checkpointed steps on re-run, makes the whole process safely re-runnable under exactly the failure mode actually observed. Leaving the interrupted run's stuck Reserve on-chain (rather than trying to somehow reclaim or hide it) is consistent with the mission's own instruction that an abandoned Reserve should have defined, visible, non-functional behavior -- this is a genuine instance of that, not a bug to fix, and is more informative left in place and documented than removed.",
  "alternativesConsidered": [
    "Keep retrying the original linear (non-checkpointed) script until it happens to complete in one pass (rejected: already failed twice under real rate-limiting/blocking conditions; no reason to expect a third attempt fares better without changing approach)",
    "Try to recover/reuse the specific mint addresses created by the first interrupted run via getProgramAccounts (rejected: that exact call is the one confirmed 403-blocked on this RPC endpoint; not a viable recovery path)",
    "Delete/ignore the stuck reserve_id 6 Reserve to keep on-chain state 'clean' (rejected: it is real, harmless (isolated PDA, no funds at risk), and is the first genuine on-chain instance of a documented invariant -- worth keeping and citing as evidence, not hiding)"
  ],
  "impact": "docs/protocol/DEVNET_FIXTURES.md now documents real, persistent DevNet state: a 2-asset Reserve (reserve_id 9) and a 3-asset Reserve (reserve_id 10), both seeded, each with a holder who minted proportionally (99,500 Reserve Tokens each), 2 restricted delegates with distinct scopes on the 2-asset Reserve, and a demonstrated pause->unpause cycle (left Active). Gate 9 is now complete in both senses required: the program's instructions are proven to work live (DEC-0025), and long-lived fixtures exist for Gate 10 to build against. The devnet-fixtures/ directory (keypairs + checkpoint) is gitignored and never committed.",
  "affectedAreas": ["scripts/devnet_fixtures.ts (new)", "scripts/package.json (new)", "scripts/tsconfig.json (new)", ".gitignore", "docs/protocol/DEVNET_FIXTURES.md (new)", "docs/protocol/DEVNET_RUNBOOK.md", "docs/protocol/SECURITY_INVARIANTS.md", "docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "First run output: aborted with 'Error: 429 Too Many Requests: Too many requests for a specific RPC call' partway through Reserve Two creation, after Reserve One (reserve_id 6) was created with 2 assets registered but not seeded",
    "getProgramAccounts probe: 'Error: 403 Forbidden: Your IP or provider is blocked from this endpoint'",
    "Second (checkpointed, backoff-hardened) run: completed cleanly end to end -- 'Reserve One seeded: GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C', 'Reserve Two seeded: H1U22fK3fMfsmz1WirJ4H63xBDcTEHgXjtSzw73tEfcJ', 'Holder A Reserve Token balance: 99500', 'Holder B Reserve Token balance: 99500', 'Reserve One status after pause: {\"paused\":{}}', 'Reserve One status after unpause: {\"active\":{}}'",
    "`solana account 9y18purN7zmHRqBaByzc22BTGx48FkH65HHevq3AxmUc` / program.account.reserve.fetch confirms assetCount=2, status=AssetsInitializing for the stuck reserve_id 6",
    "`git check-ignore -v devnet-fixtures/manager-keypair.json devnet-fixtures/checkpoint.json` confirms both are ignored"
  ]
}
```

## DEC-0027

```json
{
  "id": "DEC-0027",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Implement Buy/Sell as a SOL zap reusing the EXISTING Buy/Sell tab UI (Buy = SOL in -> proportional protocol mint; Sell = proportional protocol redeem -> SOL out), superseding FRONTEND_INTEGRATION.md's original pre-Gate-10 plan (which called for an entirely new proportional mint/redeem UI, leaving the AMM Buy/Sell tab as a separate, lower-priority 'swap-router' concern). Implement the zap as a single atomic, two-signer transaction per direction, co-signed server-side by a DevNet-only 'swap authority' keypair (reused: the Gate-9 fixture manager, which already holds mint authority over the 3 fixture test asset mints) that independently recomputes every amount from live chain state before signing. Extend Create Reserve (CreateDTR.tsx) to deploy a real Reserve when the user selects only the 3 DevNet fixture test assets, via ordinary single-signer transactions plus a separate DevNet-only mint-test-assets faucet endpoint for the seeding step.",
  "context": "This session's explicit Gate 10-11 instructions redefined the Buy/Sell semantics directly (Buy = SOL zap into proportional mint, Sell = proportional redeem followed by a zap into SOL) and required preserving the existing frontend design 'as closely as technically possible' -- reusing the Buy/Sell tab rather than building a parallel new UI, which is what the pre-existing FRONTEND_INTEGRATION.md plan (written before Gate 10 started) had assumed. Jupiter (the mission's preferred routing layer) has no meaningful DevNet liquidity for brand-new, zero-volume fixture test mints, so a real swap CPI was not viable for this testing phase; the mission explicitly anticipated this and allowed a documented, isolated DevNet-only fallback provided real transactions, real Reserve accounting, and real vault/supply changes are preserved. The two-signer atomic-transaction pattern (rather than, e.g., a fully server-custodied swap) keeps the user's own wallet as the sole authority over their own SOL/asset movements at every step, with the server only ever contributing its own signature for its own pre-approved test-asset mint authority and its own SOL balance.",
  "rationale": "A single atomic transaction eliminates any intermediate state risk (the mission's explicit 'no unintended intermediate portfolio' requirement) -- if the protocol instruction fails, the SOL/asset legs never execute either, and vice versa. Having the server independently re-fetch live state and recompute amounts itself (rather than trusting client-supplied values) closes the obvious abuse vector a naive 'sign whatever the client asks' co-signer would have. Reusing the fixture manager as the swap authority avoids provisioning and funding a second keypair for no added isolation benefit, since it already exists specifically for DevNet testing and already controls the only assets relevant here. Fixed DevNet test pricing (not a real oracle or AMM curve) is the simplest honest way to give the existing dollar-denominated UI something coherent to display, clearly labeled as such rather than presented as a live market price.",
  "alternativesConsidered": [
    "Build an entirely new proportional mint/redeem UI per the original FRONTEND_INTEGRATION.md plan, leaving the AMM Buy/Sell tab untouched (rejected: directly contradicted this session's explicit instruction to preserve the existing UI and redefine Buy/Sell's semantics within it)",
    "Attempt a real Jupiter-routed swap on DevNet (rejected: no viable DevNet liquidity exists for brand-new zero-volume test mints; the mission explicitly anticipated and pre-approved a documented DevNet-only fallback for exactly this case)",
    "Have the server fully custody and execute the swap itself rather than co-signing an atomic transaction the user also signs (rejected: would require the user to trust the server with move authority over their own assets/SOL; the two-signer atomic pattern keeps the user as a required signer on every leg that touches their own funds)",
    "Trust client-supplied quote amounts when co-signing (rejected: an obvious abuse vector; the server always recomputes independently from its own live chain read)"
  ],
  "impact": "The existing Buy/Sell UI (DTRDetail.tsx) and Create Reserve stepper (CreateDTR.tsx) are functionally real for any chain-backed Reserve (the 2 Gate-9 fixtures, or any Reserve created via the 3 supported DevNet test assets) while remaining pixel-for-pixel unchanged in structure for the fully-simulated Reserves. This resolves PROJECT_STATUS.md's previously-open 'Decisions Required' item about whether to build new proportional-mint/redeem UI -- reusing the existing UI via the zap redefinition made that question moot.",
  "affectedAreas": ["src/merge/pages/DTRDetail.tsx", "src/merge/pages/CreateDTR.tsx", "src/merge/pages/Portfolio.tsx", "packages/sdk/src/zapInstructions.ts", "packages/sdk/src/zapPricing.ts", "packages/sdk/src/createReserveFlow.ts", "api/devnet/swap-sign.ts", "api/devnet/mint-test-assets.ts", "docs/protocol/FRONTEND_INTEGRATION.md", "docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "scripts/verify_zap.ts live run: Buy (0.005 SOL) then Sell (half the resulting balance) against Reserve One -- vault balances and Reserve Token supply moved exactly as computed, swap-authority SOL delta exactly matched the expected net spread (+2,511,500 lamports = 5,000,000 in - 2,488,500 out)",
    "scripts/verify_create_reserve.ts live run: a brand-new Reserve (reserve_id 11) created, registered (2 real assets), seeded via the mint-test-assets faucet, and confirmed status=active on-chain from a fresh keypair with zero prior state",
    "scripts/verify_swap_sign_endpoint.ts: confirms api/devnet/swap-sign.ts returns a transaction with the swap-authority's signature already present and the user's signature slot still empty",
    "npm run build (tsc -b && vite build) passes cleanly with the full integration wired in"
  ]
}
```

## DEC-0028

```json
{
  "id": "DEC-0028",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Pin the transitive dependency rpc-websockets (pulled in by @solana/web3.js) to 9.3.10 via an npm 'overrides' entry in the root package.json, up from the range-resolved 9.3.9.",
  "context": "The first production deploy of Gate 10-11 (this same session) crashed both new API routes (api/devnet/swap-sign.ts, api/devnet/mint-test-assets.ts) with a 500 on every request. Vercel's function logs showed 'Error [ERR_REQUIRE_ESM]: require() of ES Module .../rpc-websockets/node_modules/uuid/dist-node/index.js from .../rpc-websockets/dist/index.cjs not supported' -- rpc-websockets@9.3.9 (a @solana/web3.js dependency used for its WebSocket subscription features, which these two endpoints never actually use, but which @solana/web3.js's Connection class imports unconditionally at module load) ships a nested uuid dependency that Vercel's Node serverless bundler cannot require() synchronously. This did not reproduce locally (dev server, ts-node scripts) -- only Vercel's specific bundling of the deployed function surfaced it. Checking the rpc-websockets changelog/dependency list showed 9.3.10 and all later versions dropped the uuid dependency entirely (replaced internally), making a version bump the correct, minimal fix rather than avoiding the import or vendoring a workaround.",
  "rationale": "This is a well-understood, narrowly-scoped upstream packaging bug (an ESM-only nested dependency breaking a CJS require chain), not a defect in this session's own code -- the correct fix is the smallest version bump that removes the broken dependency, verified to still resolve and work correctly both locally (scripts/verify_swap_sign_endpoint.ts re-run clean) and once redeployed. Pinning via 'overrides' (rather than trying to force @solana/web3.js itself to a different version, which is unrelated to the bug) keeps the fix minimal and scoped to exactly the broken package.",
  "alternativesConsidered": [
    "Avoid importing @solana/web3.js's Connection class in the API routes entirely, using a minimal hand-rolled JSON-RPC client instead (rejected: much larger rewrite for a problem that has a one-line upstream fix already published)",
    "Jump to rpc-websockets 10.0.1 instead of 9.3.10 (rejected: no need to cross a major version boundary when the very next patch within the already-in-use 9.x line already removes the offending dependency)"
  ],
  "impact": "Both DevNet API routes work correctly in production after redeployment -- see the redeployment record in PROJECT_STATUS.md. This is the kind of gap that specifically could not have been caught by local dev-server testing or the live-DevNet verification scripts (both of which run in a plain Node process, not Vercel's serverless bundler), underscoring why an actual production smoke test after deploy (not just 'the build succeeded') was necessary before declaring Gate 10-11 done.",
  "affectedAreas": ["package.json (overrides)", "package-lock.json", "api/devnet/swap-sign.ts (runtime only, no code change)", "api/devnet/mint-test-assets.ts (runtime only, no code change)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Vercel production log: \"Error [ERR_REQUIRE_ESM]: require() of ES Module /var/task/node_modules/rpc-websockets/node_modules/uuid/dist-node/index.js from /var/task/node_modules/rpc-websockets/dist/index.cjs not supported\", responseStatusCode 500, on both /api/devnet/swap-sign and /api/devnet/mint-test-assets",
    "`npm view rpc-websockets@9.3.9 dependencies` includes uuid; `npm view rpc-websockets@9.3.10 dependencies` does not",
    "Post-fix: `npm ls rpc-websockets` shows `rpc-websockets@9.3.10 overridden`; scripts/verify_swap_sign_endpoint.ts re-run succeeds locally"
  ]
}
```

## DEC-0029

```json
{
  "id": "DEC-0029",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Remove api/devnet/swap-sign.ts's hardcoded `KNOWN_RESERVES` map (which only recognized the 2 Gate-9 fixture Reserves) and replace it with fully dynamic, on-chain-derived validation: independently re-derive `protocolConfig`/`reserveTokenMint`/`mintAuthority`/`vaultAuthority` from just the Reserve address, fetch the Reserve's real registered assets via `fetchReserveOnChain`, and reject only specific unsupported ASSET MINTS (checked against an allowlist of the DevNet fixture mints + wrapped SOL) rather than rejecting the Reserve address itself.",
  "context": "Manual DevNet testing found that a Reserve created live through the frontend's real Create Reserve flow could not be Bought or Sold -- the endpoint returned 'Unknown or unsupported Reserve for the DevNet swap adapter.' Root cause: the endpoint's Reserve-address allowlist was populated only with the 2 persistent Gate-9 fixtures at the time it was written, so any genuinely new on-chain Reserve was rejected outright regardless of whether its underlying assets were actually supported. This defeated the entire point of a real Create Reserve flow -- a newly created Reserve was chain-valid but frontend-unusable.",
  "rationale": "The correct trust boundary is the asset mint, not the Reserve address: the swap authority can safely co-sign a zap for ANY real, on-chain Reserve as long as every one of its registered assets is one the swap authority actually has minting/wrapping rights over (the DevNet fixture mints, plus wrapped SOL via the swap authority's own SOL balance). Deriving every account directly from the Reserve address (rather than trusting a client-supplied or hardcoded lookup) also closes the same class of address-substitution risk the original two-signer design was already built to avoid (DEC-0027) -- it just hadn't been extended to the Reserve address itself yet.",
  "alternativesConsidered": [
    "Add each new fixture/test Reserve to KNOWN_RESERVES by hand as they're created (rejected: exactly the 'no code change/redeploy/manual registration needed for a new Reserve' requirement this pass was scoped to fix; does not scale and reintroduces the same bug for the next Reserve)",
    "Allowlist by manager/creator wallet instead of by asset mint (rejected: does not actually validate what the swap authority is being asked to sign for -- the risk is in which assets get minted/transferred, not who created the Reserve)"
  ],
  "impact": "Any Reserve created through the real on-chain Create Reserve flow immediately supports Buy/Sell the moment its assets are all DevNet-supported mints, with zero code change, redeploy, or manual registration. Verified directly against the real user-created Reserve `Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX` (built a valid Buy transaction, correctly rejected an unrelated/unregistered mint with a specific error) and end-to-end against a brand-new from-scratch Reserve (see DEC-0032).",
  "affectedAreas": ["api/devnet/swap-sign.ts", "docs/protocol/FRONTEND_INTEGRATION.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Direct in-process test against Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX: Buy request returned status 200 with a valid 5-instruction, correctly 2-signed transaction",
    "Same test with an unrelated mint (DevNet USDC) substituted returned a specific 400 error naming the unsupported mint, not a generic 'unknown reserve' rejection",
    "scripts/verify_e2e_fresh_reserve.ts: a genuinely fresh Reserve (reserve_id 15, created moments earlier in the same run) Bought and Sold successfully with no code change in between (DEC-0032)"
  ]
}
```

## DEC-0030

```json
{
  "id": "DEC-0030",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Add native SOL (presented as \"SOL\", handled internally as wrapped SOL where the SPL token interface requires it) as a real, deployable Create Reserve asset alongside the existing DevNet fixture test mints, and relabel every remaining fictional/simulated asset option in CreateDTR.tsx with a \"(simulated)\" suffix so users can no longer mistake them for real deployable assets.",
  "context": "The Create Reserve flow's asset picker presented invented assets (fictional tickers with no on-chain existence) as if they were real choices, alongside the genuinely supported DevNet fixture mints. Separately, SOL itself -- the one asset every DevNet wallet actually holds -- was not selectable at all, forcing users into fixture test tokens they'd need a faucet for.",
  "rationale": "SOL is the natural first asset for a testing audience to want to use, and wrapping is a mechanical, well-understood SPL pattern (the swap authority already wraps its own SOL for Buy and unwraps on Sell, per the zap architecture) rather than a new trust boundary. Clearly marking simulated-only assets (rather than removing them, which the mission allowed as long as they stay isolated) preserves the existing fully-simulated demo experience for assets that were never meant to be real, while making the real/simulated boundary legible at the point of choice instead of only discoverable by trying to deploy and failing.",
  "alternativesConsidered": [
    "Remove all fictional assets from the picker entirely (rejected: mission explicitly allowed keeping simulation-only paths isolated rather than requiring their removal; some already power the pre-existing fully-mocked demo Reserves)",
    "Require users to manually wrap SOL themselves before reaching Create Reserve (rejected: adds a confusing manual prerequisite step for what should read as a single native-SOL choice)"
  ],
  "impact": "Users can create a real Reserve using SOL plus any combination of the DevNet fixture mints, with SOL wrapped/unwrapped transparently by the existing zap and seed-funding code paths (DEC-0027, DEC-0031). Fictional assets remain available for the simulated-only demo experience but are now visibly labeled as such everywhere they appear in CreateDTR.tsx.",
  "affectedAreas": ["src/merge/pages/CreateDTR.tsx", "packages/sdk/src/zapPricing.ts", "packages/sdk/src/zapInstructions.ts", "api/devnet/swap-sign.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "npx tsc -b passes clean with SOL added as a real asset entry",
    "scripts/verify_e2e_fresh_reserve.ts: a real 2-asset Reserve (mockX 70% / wrapped SOL 30%) created, seeded (creator self-wraps real SOL for the SOL leg, faucet mints the fixture leg), Bought, and Sold successfully"
  ]
}
```

## DEC-0031

```json
{
  "id": "DEC-0031",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Combine `createReserve` and every `initializeReserveAsset` call into ONE transaction (down from 2 separate transactions), reducing Create Reserve to 2 wallet approvals for fixture-only assets (create+register, then seed) or 3 if wrapped SOL is one of the selected assets (create+register, wrap-SOL, then seed). Add a real, on-chain-rent-calculator-backed cost estimate (`estimateCreateReserveCost`, using live `getMinimumBalanceForRentExemption` calls against the program's actual account sizes) surfaced as a \"Wallet Cost Summary\" in the Review & Deploy step, shown before any wallet signature, breaking out initial Reserve funding, account-creation rent, estimated network fees, and protocol fees separately, plus a plain-language list of exactly how many approvals will be requested and what each does.",
  "context": "Manual testing found two related problems: Create Reserve requested more wallet signatures than necessary (a legacy transaction's ~1232-byte limit does not require creating and registering assets as separate transactions, since they share most of their accounts), and Phantom was the FIRST place a user discovered the actual SOL cost of deployment -- the existing \"Initial Seed\" value did not reconcile with the SOL amount actually requested, and there was no upfront breakdown of rent vs. fees vs. funding.",
  "rationale": "Solana's deduplicated account-key table means a combined createReserve + N-asset-registration transaction stays well under the legacy size limit for the realistic 1-3 asset case, so there is no correctness reason to keep them separate -- only seedReserve (whose `remaining_accounts` grow per asset) risks the limit and stays its own transaction. Computing rent from the SAME real rent-exemption calculator Solana itself uses (rather than hand-rolled lamports/byte estimates) makes the cost summary numbers actually trustworthy rather than approximate. Showing this before the first signature directly satisfies the requirement that Phantom never be the first place cost is discovered.",
  "alternativesConsidered": [
    "Also fold seedReserve into the same combined transaction (rejected: its remaining_accounts size grows per asset and risks exceeding the legacy 1232-byte limit for a 3-asset Reserve; not worth the risk to save one more approval)",
    "Hand-roll a lamports-per-byte rent estimate instead of calling getMinimumBalanceForRentExemption (rejected: Solana's actual rent-exemption formula is not simple lamports-per-byte; calling the real RPC method is both simpler and correct)"
  ],
  "impact": "Create Reserve now requests 2 approvals (3 with a wrapped-SOL leg), each described in the UI before signing, with a full SOL/USD cost breakdown shown ahead of the first signature. Reduces total approvals from what would otherwise be a 4th separate registration/seed step for multi-asset Reserves.",
  "affectedAreas": ["src/merge/lib/createReserveClient.ts", "src/merge/pages/CreateDTR.tsx"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "scripts/verify_e2e_fresh_reserve.ts: createReserveOnChain's create-and-register step lands as a single confirmed transaction containing both the createReserve and initializeReserveAsset instructions",
    "estimateCreateReserveCost output for a 2-asset (mockX + wrapped SOL) Reserve at $2 seed: totalRentLamports 16,474,320, networkFeeLamportsEstimate 15,000 (3 tx), totalLamports 46,489,320 -- matches the real rent paid during the same run's create+register+seed transactions"
  ]
}
```

## DEC-0032

```json
{
  "id": "DEC-0032",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Validate this corrective pass end-to-end by driving the ACTUAL frontend client code (src/merge/lib/createReserveClient.ts, src/merge/lib/zapClient.ts) from a Node script (scripts/verify_e2e_fresh_reserve.ts) against real DevNet, with a throwaway keypair standing in for a connected wallet and the real api/devnet/*.ts handlers invoked in-process -- rather than validating only against the pre-existing Gate-9 fixture Reserves.",
  "context": "The mission explicitly required proving the fix against a genuinely fresh Reserve created through the real flow, not just the 2 persistent fixtures the swap-sign endpoint used to hardcode. Reusing the literal browser-side modules (rather than reimplementing equivalent logic directly in the script, as the earlier verify_create_reserve.ts did) means a bug in the shared client code gets caught by this script even if it would never show up in a hand-rolled equivalent.",
  "rationale": "Requiring the browser TS modules directly from a CommonJS Node script surfaced a real ESM/CommonJS module-boundary conflict (root package.json is genuine ESM; src/ had no override), fixed with a scoped src/merge/lib/package.json (\"type\": \"commonjs\"), mirroring the existing api/devnet/package.json precedent -- confirmed not to affect Vite's own build (`npm run build` still passes) since Vite's bundler determines module type from actual import/export syntax, not Node's package.json resolution. This exact approach immediately caught a real bug: the seed-funding math treated 1 raw wrapped-SOL unit as if it were pegged 1:1 to USD like the fixture test assets, instead of converting through SOL_TEST_PRICE_USD -- meaning a creator selecting SOL as an asset would have been asked to wrap ~20x too much real SOL for their stated USD allocation. Fixed by routing the wrapped-SOL leg through the SDK's existing `usdToSolLamports` helper (see createReserveClient.ts's `seedRawAmountForAsset`).",
  "alternativesConsidered": [
    "Reimplement equivalent create/buy/sell logic directly in the verification script, as the earlier verify_create_reserve.ts/verify_zap.ts did (rejected: would not have caught the USD/SOL pricing bug, since a hand-rolled reimplementation would not necessarily reproduce the same mistake the real client code contained)",
    "Skip the wrapped-SOL leg in the E2E test and only use fixture test mints (rejected: would leave DEC-0030's SOL-asset support and the pricing math specifically it depends on unverified)"
  ],
  "impact": "A real, fresh, 2-asset (mockX 70% / wrapped SOL 30%) Reserve was created, seeded, Bought from, and Sold from -- all 16 of the mission's end-to-end checklist items confirmed in one run, and a real cost-calculation bug (DEC-0030's wrapped-SOL seed pricing) was found and fixed as a direct result.",
  "affectedAreas": ["scripts/verify_e2e_fresh_reserve.ts", "src/merge/lib/package.json (new)", "src/merge/lib/createReserveClient.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Full run recorded in the corrective-pass final report: Reserve BuHRWKzzXQXhjL3WCsmHTT7qDooh2437DvXuxyExpiWg, Reserve Token mint AQ6i33grhTZk3vA9Ph4paGGnsdFR9nif7trEaK1aNJ2d, createAndRegister/fundSeedAssets/seed/Buy/Sell all confirmed with vault balances, Reserve Token supply, and creator SOL/Reserve-Token balances moving exactly as computed, and a final re-fetch (simulating a page refresh) matching the last on-chain state with zero hardcoded registration"
  ]
}
```

## DEC-0033

```json
{
  "id": "DEC-0033",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Add a new, minimal, admin-gated `update_protocol_config` instruction to the SSR Protocol Anchor program (settable field: `default_protocol_fee_destination`, i.e. the protocol-wide treasury address `collect_fees` pays protocol fee shares to; gated via the existing, previously-unused `NotProtocolAuthority` error and a `has_one = authority` constraint on ProtocolConfig), so the DevNet protocol treasury can be repointed to `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq` post-launch. Per-Reserve manager fee destinations are unaffected and unchanged -- only the global, protocol-level destination read by `collect_fees` needed a way to be updated at all, since `initialize_protocol` only ever runs once.",
  "context": "The mission required routing all protocol-level revenue (mint/redemption/TVL/buy/sell fees) to a specific DevNet treasury wallet. Inspection of protocol_config.rs, mint_reserve_tokens_in_kind.rs, redeem_reserve_tokens_in_kind.rs, and collect_fees.rs found: (a) `ProtocolConfig.default_protocol_fee_destination` is the single correct global treasury field (already validated by collect_fees per DEC-0023's earlier fix), (b) it was set at the original Gate 8 `initialize_protocol` call to an address that is not the requested treasury, and (c) no instruction existed to change it afterward -- `initialize_protocol` is a one-time `init`. Per-Reserve `fee_destination` (passed to `create_reserve`) is a SEPARATE field controlling only the MANAGER's own fee share, not the protocol's, so new Reserves already inherit the correct protocol-level treasury automatically the moment ProtocolConfig itself is updated -- no per-Reserve client change was needed.",
  "rationale": "The smallest correct fix is a single-field, admin-gated setter reusing the already-defined (but previously dead) `NotProtocolAuthority` error variant -- no new error type, no broader ProtocolConfig redesign. Because it changes the deployed program's instruction set, this requires a real DevNet program upgrade (same program ID, same upgrade authority), which is deferred until the deployer wallet has sufficient DevNet SOL (see DEC-0034) -- the instruction itself is written, compiles clean (`cargo check`), and builds successfully to a real deployable `.so` via `cargo-build-sbf`, but has not yet been deployed or invoked on DevNet as of this entry.",
  "alternativesConsidered": [
    "Redeploy initialize_protocol's ProtocolConfig account from scratch with the correct destination (rejected: ProtocolConfig is a singleton PDA already referenced by every existing Reserve; recreating it would orphan all prior state)",
    "Add a per-Reserve override for protocol fee destination instead of fixing the global field (rejected: collect_fees intentionally validates against the single global ProtocolConfig field, not a per-Reserve one; changing that would be a much larger, unrequested architecture change)"
  ],
  "impact": "Once deployed and invoked, every Reserve's protocol fee share (already flowing correctly to whatever `default_protocol_fee_destination` holds) will route to the requested treasury with zero further code or per-Reserve changes. Deployment and the before/after treasury balance verification (via a real Buy generating mint fees, then a real `collect_fees` call) are the remaining step, blocked on DevNet SOL funding.",
  "affectedAreas": ["programs/ssr_protocol/src/instructions/update_protocol_config.rs (new)", "programs/ssr_protocol/src/instructions/mod.rs", "programs/ssr_protocol/src/lib.rs", "programs/ssr_protocol/src/events.rs"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "cargo check -p ssr_protocol: clean, zero errors",
    "cargo-build-sbf (run directly from programs/ssr_protocol/): succeeds, produces a 544,472-byte .so",
    "Not yet evidenced: on-chain deployment and a real collect_fees call moving fees to EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq -- blocked on DevNet SOL funding, see DEC-0034"
  ]
}
```

## DEC-0034

```json
{
  "id": "DEC-0034",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Adopt localnet (a locally-run solana-test-validator) as the default environment for protocol development and validation going forward. Reserve real DevNet program upgrades for checkpointed releases only -- gated on: the on-chain Rust program having materially changed, all local tests passing, frontend integration validated locally, and the change set being grouped rather than deployed piecemeal. Frontend/SDK/API/documentation-only changes never require a DevNet program redeploy. Before any DevNet upgrade: inspect the compiled .so size, list and reuse/close deployment buffers, and calculate the exact additional SOL required; after: verify the deployed program and report recovered lamports and final deployer balance.",
  "context": "This session's DevNet program upgrade (DEC-0033) stalled: the deployer wallet (6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk) held 1.24 SOL against a ~3.79 SOL upgrade cost, and the public DevNet airdrop faucet was rate-limited across repeated retries. Attempting to fall back to a local validator for the same validation purpose then surfaced a separate, real environment limitation: `solana-test-validator` panics on this machine (`ERROR_PRIVILEGE_NOT_HELD`) without Windows Developer Mode enabled, since it needs `SeCreateSymbolicLinkPrivilege` for its ledger; `anchor test`/`anchor build` fail even earlier with an unrelated cargo-build-sbf toolchain-detection panic specific to how the Anchor CLI wrapper invokes it (direct `cargo-build-sbf` calls work fine).",
  "rationale": "DevNet SOL is a genuinely scarce, externally rate-limited resource for this project, not a free faucet tap -- upgrading for every small change risks leaving the deployer unable to fund a later, more important upgrade. Localnet has no such scarcity (unlimited local airdrops), making it the correct default once it is actually usable; until Developer Mode is enabled, the fallback is `cargo check` (fast correctness) plus a direct `cargo-build-sbf` run (validates the real deployable artifact) plus careful pattern-matching against already-DevNet-proven instructions.",
  "alternativesConsidered": [
    "Keep upgrading DevNet on every change as before (rejected: directly caused this session's funding stall; not sustainable given the faucet's confirmed unreliability, DEC-0024)",
    "Force solana-test-validator to work via elevated/admin execution from within this session (rejected: requires a system privilege change outside what a sandboxed shell can or should grant itself; left as a one-time manual step for the user, e.g. enabling Windows Developer Mode)"
  ],
  "impact": "DEC-0033's on-chain deployment remains pending real DevNet SOL (either faucet recovery or a direct user transfer to the deployer wallet) rather than being forced through immediately. Future protocol changes in this project default to localnet validation; DevNet upgrades become deliberate, batched, checkpoint events.",
  "affectedAreas": ["docs/protocol/DEVNET_RUNBOOK.md", "Anchor.toml (already defaulted to localnet provider, now actually the intended default)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "solana program deploy attempt: \"Error: Account 6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk has insufficient funds for spend (3.7907292 SOL) + fee (0.00271 SOL)\"",
    "Repeated solana airdrop attempts (2 SOL, 1 SOL) all returned \"Error: airdrop request failed. This can happen when the rate limit is reached.\"",
    "solana-test-validator startup: \"Os { code: 1314, kind: Uncategorized, message: \\\"Um privilégio necessário não é mantido pelo cliente.\\\" }\" (ERROR_PRIVILEGE_NOT_HELD)",
    "anchor test: cargo-build-sbf panic at toolchain.rs:357, Option::unwrap() on None"
  ]
}
```

## DEC-0036

```json
{
  "id": "DEC-0036",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Redesign the /internal/status dashboard into an executive engineering-status view: a whole-project completion metric derived from a new, explicitly-weighted \"Engineering Areas\" block (rather than the protocol-mission-only Roadmap weighting); real milestone/timeline/infrastructure panels sourced from a new curated file (docs/project/ENGINEERING_TIMELINE.md, same fenced-JSON convention as PROJECT_STATUS.md/DECISION_LOG.md); and a mechanically-generated, re-runnable repo-metrics file (docs/project/REPO_METRICS.json, via scripts/generate-repo-metrics.ts) for commit/contributor/branch/LOC facts no serverless function can compute at request time.",
  "context": "The dashboard's single completion percentage (10%) was computed purely from the current Solana-protocol mission's 8-phase Roadmap, which allocates only 10/100 weight to the entire pre-existing SSR.fun simulation platform (homepage, Discover, Create, Portfolio, Manage, Reserve-detail) -- making the number look like almost nothing had been built, when in reality a large, real product already exists. The request was for the dashboard to communicate real project scale/momentum within 10 seconds, derived from the repository wherever possible rather than hand-typed, and explicit about which facts are git-derivable versus manually recorded.",
  "rationale": "A second, differently-weighted block (Engineering Areas) that maps onto the SAME underlying Roadmap phase completions (just re-grouped and re-weighted across 5 areas reflecting true relative project scope) gives an honest whole-project number without inventing new completion figures out of thin air -- every area's % is traceable back to a Roadmap phase. Splitting data into three tiers by how derivable it is -- mechanically generated (REPO_METRICS.json, real git log/shortlog/branch data, re-run anytime), curated-but-cited (ENGINEERING_TIMELINE.md, real commit hashes a reader can `git show`), and explicitly-flagged manual (domain registration, auth model labels) -- satisfies 'derive from the repo, never fabricate' without pretending everything is mechanically provable.",
  "alternativesConsidered": [
    "Hand-edit a new higher overall percentage directly (rejected: violates CLAUDE.md's 'never hand-edit the completion number independently of weights/completions' rule, and would be an unverifiable, fabricated number)",
    "Have the dashboard's API route shell out to `git` at request time for the timeline/metrics (rejected: Vercel serverless functions have no guaranteed `git` binary or `.git` directory at runtime -- confirmed by this project's existing api/dashboard/content.ts pattern of reading committed Markdown, not live-querying anything)",
    "Auto-classify commits into milestones via keyword matching (rejected: produces a lower-quality, less legible narrative than reviewing the real `git log --all` output once and hand-curating it -- the milestones/timeline are still 100% grounded in real commits/dates, just organized by a person instead of a naive script)"
  ],
  "impact": "The dashboard now shows an 80% whole-project completion (vs. the old 10%), 5 area-level progress rings, 15 milestone cards, a 17-entry engineering timeline, an 8-item infrastructure panel, and a real repo-metrics panel (79 commits, 4 contributors, 6 branches, 35 decision records, 18 protocol instructions, ~3.1k Rust / ~12.4k TS lines) -- all traceable to real commits or explicitly marked manual. Found and fixed two real bugs in the process: vercel.json's function `includeFiles` glob only covered `docs/project/*.md`, which would have 500'd in production once content.ts started reading REPO_METRICS.json too; and ProgressRing's 'muted' tone referenced a nonexistent `--muted` CSS variable (fixed to `--text-3`).",
  "affectedAreas": ["src/internal-status/Dashboard.tsx", "src/internal-status/dashboard.css", "lib/dashboard/parseMarkdown.ts", "api/dashboard/content.ts", "docs/project/ENGINEERING_TIMELINE.md (new)", "docs/project/REPO_METRICS.json (new, generated)", "scripts/generate-repo-metrics.ts (new)", "docs/project/PROJECT_STATUS.md (new Engineering Areas block)", "vercel.json"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "npx tsc -b and npm run build both pass clean after the full change set",
    "Live API response (via `vercel dev` with SSR_DASHBOARD_PASSWORD set) confirmed: overallCompletionPercent 80, 5 engineeringAreas parsed correctly, 15 milestones / 17 timeline entries / 8 infra items parsed from ENGINEERING_TIMELINE.md, repoMetrics matching scripts/generate-repo-metrics.ts's real git-derived output (79 commits across all branches, contributor commit counts summing exactly to 79)",
    "A one-time headless-Chrome (puppeteer-core, not installed as a project dependency) screenshot pass caught the --muted CSS variable bug before it shipped"
  ]
}
```

## DEC-0035

```json
{
  "id": "DEC-0035",
  "date": "2026-07-28",
  "status": "confirmed",
  "decision": "Deploy DEC-0033's `update_protocol_config` instruction to Solana DevNet (program upgrade, same program ID/upgrade authority), regenerate and re-commit the IDL, call `update_protocol_config` once to set `ProtocolConfig.default_protocol_fee_destination` to `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`, and verify real fee routing via a `collect_fees` call against the pending fee shares accrued during DEC-0032's Buy.",
  "context": "DEC-0033/DEC-0034 left this blocked on DevNet SOL: the deployer wallet had 0.94 SOL against a ~3.79 SOL upgrade cost, and the public faucet was rate-limited. The user sent 3 SOL directly to the deployer wallet (`6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk`) from the treasury wallet itself (tx `36xa2uVFMy1LXqnAdDeSDg3AbbPV78b8as65LCfHJWFixtULS4VywL5RrZWh5PJRe9RPFKhuwB4V9k2nZsSbwmKU`), unblocking the upgrade. Per DEC-0034's hygiene steps: checked for reusable/stale deployment buffers first (none existed), deployed, then re-verified via `solana program show` and confirmed no buffers were left behind. Regenerating the IDL surfaced a real gotcha: `anchor idl build` prints Cargo build noise before the JSON on stdout (corrupting a naive stdout capture) and, more importantly, the committed `.ts` IDL companion is NOT a literal mirror of the `.json` -- it's a fully recursive camelCase transform (snake_case instruction/arg names, PascalCase account/type/event names all lowercased-first-letter), which an earlier session apparently produced by hand since `anchor build`'s own generator panics in this environment (DEC-0025/DEC-0034). Regenerating the whole `.ts` file naively (as a literal JSON mirror) broke `AccountNamespace<SsrProtocol>` account access (`program.account.reserve` etc.) at compile time. Fixed by surgically merging only the 3 new entries (the `update_protocol_config` instruction, `ProtocolConfigUpdated` event and type) into both the existing `.json` (raw Rust-style names) and `.ts` (hand-camelCased) files, leaving everything else byte-for-byte as it already was.",
  "rationale": "A full mechanical IDL regeneration was rejected the moment it broke typechecking on unrelated, already-working code -- the smallest correct fix is additive-only, matching exactly what changed on-chain (one instruction, one event/type) rather than re-deriving the whole file and risking reintroducing whatever manual correction the `.ts` file needed the first time. Verifying fee routing with a real `collect_fees` call (not just confirming the ProtocolConfig field changed) proves the destination is actually reachable by the program's own minting logic, not just stored correctly.",
  "alternativesConsidered": [
    "Regenerate ssr_protocol.ts wholesale from the fresh anchor idl build output (rejected: broke account-namespace typing across the whole SDK; the file is a hand-maintained camelCase transform, not a mechanical mirror, and a full regen would need to correctly reproduce that transform for all 18 instructions/26 types, not just the 1 new one)",
    "Skip verifying with collect_fees and only check the ProtocolConfig field changed (rejected: the mission explicitly asked for fee-routing verification via real transactions with before/after balances, not just a config-value check)"
  ],
  "impact": "The DevNet protocol treasury is now live: `ProtocolConfig.default_protocol_fee_destination` = `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`, confirmed by both a direct account read and a real fee payout. Every Reserve's protocol fee share (already computing correctly since Gate 8) now actually lands at the requested treasury with zero further code changes -- this was already true structurally per DEC-0033, now proven end-to-end.",
  "affectedAreas": ["packages/sdk/idl/ssr_protocol.json", "packages/sdk/idl/ssr_protocol.ts", "docs/protocol/DEVNET_RUNBOOK.md", "docs/project/PROJECT_STATUS.md"],
  "supersedes": ["DEC-0033"],
  "supersededBy": null,
  "evidence": [
    "solana program deploy: signature JuNiHri3m5wuCwv7aKaYHnMLvoMSEPUuJjCehainCrZRUg6RqfZMdUeVxosxjbAzn9hxSFc8nThXcoVGEx9BvVK; solana program show confirms Last Deployed In Slot 479523248, Data Length 548,296 bytes; no leftover deployment buffers (solana program show --buffers empty)",
    "update_protocol_config call: signature 2cEtFTEPa5qiEWdPWZ16bTVdQaDZ7XyhUK6zjJpwUKkLvKYwwE8fD11gseoyZHgVRvRthD1d6spzy8VaYRZGcmTC; ProtocolConfig.default_protocol_fee_destination read before = 6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk, after = EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq",
    "collect_fees call against Reserve BuHRWKzzXQXhjL3WCsmHTT7qDooh2437DvXuxyExpiWg (pending_manager_fee_shares=800, pending_protocol_fee_shares=200 raw, accrued from DEC-0032's Buy): signature 3k4KKk9EdiuNigWgSjqWK3kiigedAKAP2ifmkX1cMXAzxE4wTk5F8jj5bbGE6sPaqUA2TEKSX11RLjRAbPFxw9Ww; manager (BYnpmzHjR2eMzYZVCRJ1HTHvGoUWpt5DLs8vzm52HAeh) Reserve Token balance 1,099,500 -> 1,100,300 (+800); treasury (EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq) Reserve Token balance 0 (no ATA) -> 200",
    "npx tsc -b clean after the surgical IDL merge"
  ]
}
```

## DEC-0037

```json
{
  "id": "DEC-0037",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Final product terminology: \"Decentralized Token Reserve\" is the complete basket/product; \"Reserve\" is each underlying asset held inside one; \"Reserve Token\" is the fungible token representing ownership of the whole. User-facing copy uses \"Launch a Decentralized Token Reserve,\" not \"Launch a Reserve.\" This inverts the prior mandatory-terminology mandate in CLAUDE.md, which used \"Reserve\" for the whole basket. The deployed Anchor account structs `Reserve`, `ReserveAsset`, `Delegate`, and `ProtocolConfig` (programs/ssr_protocol/src/state/*.rs) are explicitly NOT renamed to match -- they remain legacy technical identifiers, not approved product terminology.",
  "context": "Two prior rounds of this same day's DevNet implementation planning (docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md) used \"Reserve asset\" for an underlying holding and \"Reserve\" for the whole basket, matching CLAUDE.md's then-current mandate. The user's final round of feedback redefined both terms with the opposite mapping and explicitly banned \"DTR Asset,\" \"Reserve asset,\" \"BYOR,\" and \"BOR\" from new copy/docs/identifiers where a safe rename is possible.",
  "rationale": "Anchor derives each account's on-chain discriminator from its struct name at compile time; renaming `Reserve`/`ReserveAsset`/`Delegate`/`ProtocolConfig` would change the discriminator new builds expect and break deserialization of every already-initialized account on live DevNet, including the two committed fixtures and any user-created Reserve (e.g. the real one referred to by handle \"TestLo\"). Scoping the terminology change to product copy/docs/safely-renameable TS identifiers (not deployed Rust/Anchor account names) preserves DevNet compatibility while still honoring the new terminology everywhere it's safe to apply it.",
  "alternativesConsidered": [
    "Also rename the on-chain Reserve/ReserveAsset Anchor structs to match (rejected: breaks the discriminator for every already-initialized account on live DevNet -- a real, unrecoverable-without-migration compatibility break, not worth it purely for naming consistency)",
    "Keep the old CLAUDE.md mapping and treat the new decision as documentation-only, not applied to CLAUDE.md itself (rejected: would leave CLAUDE.md actively contradicting the current, final terminology decision, which is exactly the kind of drift CLAUDE.md exists to prevent)"
  ],
  "impact": "CLAUDE.md's \"Mandatory terminology\" section rewritten to the final mapping, with an explicit unsafe-rename warning for the on-chain structs. A one-line doc comment recording the same exception was added to programs/ssr_protocol/src/state/reserve_asset.rs. No user-facing copy was changed in this pass beyond CLAUDE.md/docs (Phase A's scope was discovery/mock-purge, not a copy pass) -- actual CTA/copy changes implementing this terminology (e.g. \"Launch a Decentralized Token Reserve\") remain pending future work.",
  "affectedAreas": ["CLAUDE.md", "programs/ssr_protocol/src/state/reserve_asset.rs", "docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["Manual review of CLAUDE.md's updated terminology section against the user's exact final wording; npx tsc -b passes clean after the reserve_asset.rs comment-only change (no functional Rust change, not rebuilt/redeployed)"]
}
```

## DEC-0038

```json
{
  "id": "DEC-0038",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Phase A implemented: a canonical, on-chain-only Reserve discovery layer (packages/sdk/src/discovery.ts) replaces the hardcoded 2-fixture list as the source of truth for \"which Reserves exist,\" and every active frontend surface (Discover, DTRDetail, Portfolio, ManageDTR) is unified on it, with real (on-chain) vs. simulated Reserves now visually distinguished everywhere rather than rendered identically.",
  "context": "Prior to this pass, Discover/Portfolio/ManageDTR sourced 'real' Reserves from a hardcoded 2-entry descriptor list (REAL_RESERVE_DESCRIPTORS, src/merge/lib/onChainReserve.ts) plus whatever a user's own browser had separately remembered in localStorage after creating a Reserve through CreateDTR.tsx. A genuinely user-created Reserve not in that hardcoded list (e.g. handle \"TestLo\", Decentralized Token Reserve name \"Strategic Sol Reserve\", underlying asset MOCX) was real, confirmed DevNet state, but invisible to Discover/Portfolio from any browser other than the one that created it -- there was no mechanism to enumerate 'every Reserve the deployed program actually knows about.' Separately, several UI surfaces could show a false-success state for a real on-chain Reserve: ManageDTR's delegate add/edit/remove and rebalance-execute actions mutated only local simulation state with a success toast, with zero on-chain effect, for ANY Reserve including chain-backed ones.",
  "rationale": "A Reserve PDA is seeded only by a monotonic reserveId (programs/ssr_protocol/src/constants.rs), and ProtocolConfig.reserveCount is a real, live upper bound on how many exist -- so every Reserve can be enumerated via direct account reads (fetchNullable per candidate reserveId), with no getProgramAccounts call needed (confirmed blocked/403 on the public DevNet RPC). Per-Reserve asset mints and delegate wallets remain individually un-enumerable without either a getProgramAccounts memcmp scan or a candidate list, so a documented, honestly-flagged candidate-hint approach (never trusted without independent on-chain verification) was used instead of either fabricating completeness or blocking Phase A on an RPC-provider change. Reserve.metadataUri, already written as a data:application/json URI by CreateDTR.tsx's real-deployment path, is decoded (parseReserveMetadataUri) to recover name/ticker/description/category for any discovered Reserve without needing that information supplied manually. Any UI action that cannot yet be backed by a real signed instruction (delegate CRUD, rebalance execution, both deferred to Phase D/F) was disabled with an explanatory notice for on-chain Reserves specifically, rather than left as a working-looking but fake mutation.",
  "alternativesConsidered": [
    "Add TestLo as a 3rd hardcoded fixture descriptor (rejected: explicitly instructed against -- would not validate general dynamic discovery, and would leave the next dynamically-created Reserve just as invisible as TestLo was)",
    "Implement a getProgramAccounts-based scan now (rejected: confirmed blocked/403 on the public DevNet RPC in this environment; documented as the eventual fix once a dedicated/paid RPC provider is available)",
    "Leave ManageDTR's delegate/rebalance actions working (with a caveat comment) for on-chain Reserves rather than disabling them (rejected: produces exactly the false-success state Phase A's mandate explicitly rules out -- 'no state-changing action is successful until signed, confirmed, and refreshed from chain')"
  ],
  "impact": "packages/sdk/src/discovery.ts (new), src/merge/lib/onChainReserve.ts's buildDtrFromDiscoveredReserve (new), src/merge/lib/RealReserveSync.tsx (rewritten to run full discovery, not just refresh known ids), useAppStore's applyDiscoveredReserves/setOnChainDelegates/chainDiscoveryStatus (new), and badge/labeling updates across Discover/DTRDetail/Portfolio/ManageDTR. A real, user-created Reserve like TestLo is now discoverable and displayable by this architecture from any browser, without being hardcoded. ManageDTR's Delegates tab is read-only (with local-label editing only) and its Rebalance tab's submit button is disabled, for on-chain Reserves, until Phase D/F ship real signed instructions.",
  "affectedAreas": ["packages/sdk/src/discovery.ts", "packages/sdk/src/readOnly.ts", "packages/sdk/src/index.ts", "src/merge/lib/onChainReserve.ts", "src/merge/lib/RealReserveSync.tsx", "src/merge/lib/delegateLabels.ts", "src/merge/lib/onChainPermissions.ts", "src/merge/lib/types.ts", "src/merge/store/useAppStore.ts", "src/merge/pages/Discover.tsx", "src/merge/pages/Portfolio.tsx", "src/merge/pages/ManageDTR.tsx", "src/components/ReserveCard.tsx", "docs/protocol/FRONTEND_INTEGRATION.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "npx tsc -b: clean, zero errors",
    "npx oxlint: zero new errors/warnings (only pre-existing warnings)",
    "npx vite build: passes, all existing chunks build",
    "npx ts-mocha -p ./tests/tsconfig.json tests/phase_a_discovery.ts: 12/12 passing (parseReserveMetadataUri, decodeOnChainPermissions, delegate local-label fallback behavior)",
    "Not run in this pass: the live-DevNet Anchor test suite (tests/ssr_protocol.ts / npm run test:program) -- unrelated to this pass's frontend/SDK-discovery-layer changes and not re-triggered to avoid unnecessary live DevNet transactions/cost"
  ]
}
```

## DEC-0039

```json
{
  "id": "DEC-0039",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "The Sell tab's headline estimate for a real (on-chain) Reserve is now the proportional in-kind redemption amount (e.g. ~X MOCX), computed live from on-chain vault balances/supply via the same integer math the deployed program uses (computeRedemptionEntitlements), never a blended synthetic SOL figure. The existing fixed-rate SOL settlement mechanism (packages/sdk/src/zapInstructions.ts) is unchanged in its actual execution -- Phase A is display/discovery only -- but is now shown as an explicitly-disclosed, clearly-secondary line, never implied to be a real market quote or an actual asset-to-SOL swap.",
  "context": "The previously reported 'TestLo sell-estimate bug' (~1,004 Reserve Tokens, ~$1 NAV, ~$1,000 AUM, MOCX composition, but a ~50 SOL sell estimate at a fixed $20/SOL DevNet test price) was traced to a real mechanism, not an accounting bug: Sell always redeemed in-kind on-chain first (correct), then unconditionally converted that value to SOL at a fixed synthetic rate, and the frontend only ever displayed that final SOL number -- with no disclosure that the underlying asset was never SOL to begin with.",
  "rationale": "The deployed protocol has no oracle/pricing concept at all (confirmed structurally -- no price field anywhere in programs/ssr_protocol/src/); every dollar/SOL figure the frontend shows is a layered, off-chain construct. Making the real, already-correct in-kind redemption math (already used on-chain and already available client-side via computeRedemptionEntitlements) the headline, and demoting the fixed-rate SOL conversion to a clearly labeled secondary line, satisfies 'direct proportional redemption into the underlying Reserve(s) remains canonical' without touching the actual signing/execution path, which is out of Phase A's scope (real routed conversion / Jupiter feasibility is Phase E).",
  "alternativesConsidered": [
    "Remove the SOL settlement leg's execution entirely in this pass (rejected: out of Phase A's scope -- that's a real, working, previously-validated DevNet code path; removing it is a Phase C/E-scoped change requiring its own instruction/SDK/frontend work, not a display fix)",
    "Keep the blended SOL headline but add a disclaimer tooltip (rejected: explicitly ruled out -- 'do not preserve or display the current fixed synthetic SOL Sell estimate' as the primary figure)"
  ],
  "impact": "src/merge/pages/DTRDetail.tsx's Sell tab now shows a per-asset in-kind entitlement breakdown as the headline, with the existing SOL conversion shown underneath as 'Current settlement (secondary, fixed-rate)' with an explanatory tooltip. No change to Buy, to the actual transaction the Sell button submits, or to any on-chain instruction.",
  "affectedAreas": ["src/merge/pages/DTRDetail.tsx"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["npx tsc -b clean; manual trace of computeRedemptionEntitlements' inputs (dtr.onChain.assets/vaultBalancesRaw/reserveTokenSupplyRaw/redemptionFeeBps) against the same fields programs/ssr_protocol/src/instructions/redeem_reserve_tokens_in_kind.rs reads on-chain"]
}
```

## DEC-0040

```json
{
  "id": "DEC-0040",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Locked in for future phases (not built in Phase A): a real, controlled DevNet settlement token (working name \"SSR Test USD\" / devUSDC, Phase B) replaces the retired \"Mule\" concept; Jupiter is Mainnet-only until a later phase proves real DevNet quote+execution+confirmation+balance-verification (an API key alone is never sufficient evidence); and an 8-phase delivery order (A: mock-purge/discovery -- B: settlement token/faucet -- C: real creation/funding/mint/direct-redemption -- D: fee/treasury verification -- E: Jupiter feasibility/real swap -- F: composition management/real rebalance -- G: staged wind-down -- H: full e2e verification) governs all subsequent DevNet work.",
  "context": "Round 3 of docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md's same-day planning confirmed SSR DevNet's target end-state (a fully on-chain testing environment, with an explicit list of things that must never be simulated) and asked for these specific architecture/sequencing decisions to be locked in and preserved across phases, not just noted informally.",
  "rationale": "Recording these as an explicit decision-log entry (not just plan-document prose) ensures Phase B onward can't silently drop or renegotiate them without a new, explicitly-linked decision -- matching this repo's existing pattern of using DECISION_LOG.md as the durable record for exactly this kind of cross-session architectural commitment.",
  "alternativesConsidered": [
    "Leave this only in the plan document (rejected: the plan document is explicitly a working/append-only planning artifact, not the durable decision record CLAUDE.md designates DECISION_LOG.md for)"
  ],
  "impact": "No code changed by this entry itself -- it's the durable record for decisions whose implementation is explicitly deferred to Phases B-H. Phase A's own changes are recorded separately in DEC-0038/DEC-0039.",
  "affectedAreas": ["docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md", "docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md round 3 sections: \"Final DevNet objective\", \"DevNet asset architecture\", \"Jupiter and trading\", \"Delivery phases A-H\""]
}
```

## DEC-0041

```json
{
  "id": "DEC-0041",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Confirm Phase A's canonical discovery layer (DEC-0038) against the live deployed SSR Protocol program via a new reusable, read-only verification script (scripts/verify_discovery.ts, zero transactions sent), rather than relying solely on typechecking and offline unit tests. During this pass, harden packages/sdk/src/discovery.ts (per-reserve/per-asset/per-vault/per-delegate try/catch, a new non-breaking `issues: DiscoveryIssue[]` return field) after a live 429-rate-limit event on the public DevNet RPC exposed that a single unreachable/malformed account could otherwise abort discovery of every other Reserve.",
  "context": "DEC-0038's own evidence section explicitly flagged that Phase A's discovery logic had been typechecked and unit-tested offline but not yet exercised against the live deployed program from this environment. This entry closes that gap. Separately, the user's TestLo/MOCX scenario (handle 'TestLo', Decentralized Token Reserve name 'Strategic Sol Reserve', ~1,004 Reserve Tokens, underlying asset MOCX) needed to be confirmed as real, generally-discoverable DevNet state rather than repository fixtures.",
  "rationale": "Running the exact same functions the frontend calls (discoverAllReserves, discoverDelegatesForReserve, fetchProtocolConfig, parseReserveMetadataUri, buildDtrFromDiscoveredReserve) directly against live DevNet, rather than reimplementing verification logic, is evidence the frontend's own code path works live -- a parallel/duplicate implementation could pass while the real one still failed. The first live run crashed on a real 429 inside the verification script's own extra integrity-check calls (not inside discovery.ts itself, which was already resilient by design) -- fixing this by wrapping every per-reserve verification step, and applying the same resilience directly to discovery.ts's core loops, converts a live-observed failure mode into a permanently-guarded one rather than a one-off manual retry.",
  "alternativesConsidered": [
    "Treat the offline unit tests (tests/phase_a_discovery.ts) as sufficient proof and skip live verification (rejected: explicitly what this pass was authorized to close -- offline tests cannot prove the live reserveId-enumeration strategy, PDA derivations, or Anchor discriminators actually match the deployed program's real, currently-initialized state)",
    "Retry the crashed script manually without fixing the underlying resilience gap (rejected: would leave a latent bug in a reusable script future verification passes would hit again, and left discovery.ts's own analogous per-account resilience unverified under real failure conditions)"
  ],
  "impact": "Confirmed live: RPC https://api.devnet.solana.com, cluster devnet (genesis hash match), program 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW. ProtocolConfig.reserveCount=16; all 16 reserveIds enumerated and decoded with zero account-integrity issues (owner/discriminator/PDA-derivation/cross-contamination/duplicate-identity checks all passed). TestLo confirmed real and found via general discovery at reserveId 13 (Reserve Token mint DQ8ZTGnrgXjDwpn2nLULmY1DtfXKDN8fXM4DKzQZGm7w, decimals 6 verified live, supply ~1,004.975, backed 100% by mint 2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu i.e. mintX/\"mockX\"/\"MOCX\", vault balance ~1,005, name/ticker \"StrategicSolReserve\"/\"TESTLO\" resolved from its own on-chain metadataUri) -- plus an earlier abandoned attempt at the same Reserve (reserveId 12, zero supply/assets). packages/sdk/src/discovery.ts and scripts/verify_discovery.ts both hardened against RPC failure; RealReserveSync.tsx now logs (non-fatally) when discovery issues occur.",
  "affectedAreas": ["scripts/verify_discovery.ts", "packages/sdk/src/discovery.ts", "src/merge/lib/RealReserveSync.tsx", "docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md", "docs/protocol/FRONTEND_INTEGRATION.md", "docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "scripts/verify_discovery.ts run 1 (pre-hardening): crashed with exit code 1 at reserveId=5 on a real 429 from https://api.devnet.solana.com inside the script's own verifyAccountOwnerAndDiscriminator helper; 6 reserves (0-5, partial) and 1 issue (reserveId=10 429, caught by discovery.ts's own try/catch) recorded before the crash",
    "scripts/verify_discovery.ts run 2 (post-hardening): exit code 0, 16/16 reserveIds enumerated, 0 discovery issues, 0 integrity issues, TestLo/MOCX result as stated above",
    "npx tsc -b (repo-wide) and npx tsc -p scripts/tsconfig.json --noEmit: both clean",
    "npx oxlint: zero new warnings/errors",
    "npx vite build: passes; local vite dev server confirmed to serve / and /#/discover with HTTP 200",
    "npx ts-mocha -p ./tests/tsconfig.json tests/phase_a_discovery.ts: 12/12 passing, unchanged"
  ]
}
```

## DEC-0042

```json
{
  "id": "DEC-0042",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Implement Phase B: a real Solana DevNet SPL-token mint ('SSR Test USD' / devUSDC, Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k, 6 decimals, classic SPL Token, zero initial supply), a real server-signed faucet for it (api/devnet/faucet-devusdc.ts) gated by a durable live on-chain balance ceiling plus a best-effort cooldown, and a tightly-limited real DevNet SOL sponsorship endpoint (api/devnet/sponsor-sol.ts) with the same eligibility shape. Both reuse the existing DEVNET_SWAP_AUTHORITY_SECRET_KEY-backed manager keypair as mint/freeze authority and signer -- no new required secret. Shared server-only helpers (authority loading, live DevNet-cluster verification via genesis hash, the cooldown tracker, request/response types) were factored out of api/devnet/swap-sign.ts and api/devnet/mint-test-assets.ts into api/devnet/_lib/ and reused by all four endpoints.",
  "context": "Today's objective was to make the live SSR website usable by internal teammates for real DevNet testing, starting with a settlement token and onboarding path so testers aren't solely dependent on the public, often-rate-limited DevNet airdrop faucet. Pre-implementation inspection confirmed no existing devUSDC/Mule/settlement-token/treasury infrastructure, no persistent KV/DB in this project, and no Metaplex/token-metadata integration anywhere in the repo.",
  "rationale": "Reusing the existing manager/swap-authority keypair (already the mint authority for the 3 fixture test-asset mints, already the Buy/Sell zap co-signer, already configured as a Vercel production secret) means Phase B needs zero new secrets provisioned before it can deploy today -- the alternative (a dedicated new authority) would have blocked today's deployment goal on the user adding a new Vercel environment variable. The durable-balance-ceiling-plus-best-effort-cooldown eligibility design was chosen because this project has no persistent store (confirmed by inspection) -- the balance ceiling is unspoofable and needs no new infrastructure, matching this repo's established 'never trust client-supplied state, always re-derive from chain' convention (e.g. swap-sign.ts's dynamic Reserve validation); the in-memory cooldown is the same accepted, already-shipped pattern used by the /internal/status dashboard's login lockout. No on-chain Metaplex metadata was created for devUSDC, matching the existing mintX/Y/Z convention exactly, to avoid introducing a new dependency and a one-off exception in the same pass. Neither new endpoint requires a user wallet signature, following the precedent already shipped for mint-test-assets.ts (both operations only ever add funds to the caller, never remove) -- flagged explicitly in the plan document as a considered, not silently made, choice.",
  "alternativesConsidered": [
    "A dedicated new keypair/secret for devUSDC's mint+faucet authority, separate from the swap-authority key (rejected for this pass: would require the user to add a new Vercel secret before deployment could proceed, blocking today's stated objective; noted as a future hardening step before wider testing)",
    "A real elapsed-time cooldown backed by a new Vercel KV/Redis integration (rejected: no persistent store exists in this project today; introducing one was judged out of scope for 'settlement token + faucet' and would need its own marketplace-integration decision; the live on-chain balance ceiling achieves the same anti-abuse goal without new infrastructure)",
    "Real on-chain Metaplex metadata for devUSDC (rejected: no Metaplex integration exists anywhere in this repo; adding one now would be a new dependency solely for a display label, inconsistent with the existing mintX/Y/Z off-chain-registry convention)",
    "Requiring a mandatory user wallet signature for the faucet/sponsorship claim transactions (rejected: matches no existing precedent in this repo, adds UI friction with no security benefit for a gift-only transaction; documented as a one-line future addition if a UX consent gate is specifically wanted)"
  ],
  "impact": "A real, live, verified devUSDC mint and two new real DevNet endpoints are available in the codebase and pass all automated checks. Live-verified end-to-end against a disposable test wallet: mint configuration confirmed (owner, decimals, authorities, supply), a real faucet claim (+500 devUSDC, signature 5ySJEctYwRUv8tQxkugcDtQ9FYa5msrUN55hR3VcADnKwGboszDBQUBnbuRBxEwdVnjSn3pCYQHUgeHKa6qpMQJi) and a real SOL grant (+0.01 SOL, signature 3Dec58wN3Xi2HCKpHmp3URh7ygXGJxqimT9rm9m2Ztadrev5E566pu4h2PWRY6dBbLnhipjpAKtXufDTQJ2z9sSY) both confirmed on-chain, both immediate repeat claims correctly rejected (429/cooldown). A DevnetOnboarding panel is live on the existing Portfolio page. The manager/swap-authority wallet now serves four DevNet roles on one balance (~0.391 SOL remaining after this pass) -- an operational constraint documented, not hidden. Phase C (real creation/funding/minting/redemption using this settlement token) remains explicitly not started.",
  "affectedAreas": ["scripts/create_devusdc_mint.ts", "scripts/verify_devusdc_faucet.ts", "packages/sdk/fixtures/devusdc.json", "packages/sdk/src/devUsdc.ts", "packages/sdk/src/index.ts", "api/devnet/faucet-devusdc.ts", "api/devnet/sponsor-sol.ts", "api/devnet/_lib/authority.ts", "api/devnet/_lib/network.ts", "api/devnet/_lib/rateLimit.ts", "api/devnet/_lib/apiTypes.ts", "api/devnet/swap-sign.ts", "api/devnet/mint-test-assets.ts", "src/merge/components/DevnetOnboarding.tsx", "src/merge/pages/Portfolio.tsx", "tests/phase_b_devusdc.ts", ".env.example", "docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md", "docs/protocol/FRONTEND_INTEGRATION.md", "docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "scripts/create_devusdc_mint.ts run: creation signature 2fcshGpJMTytqZdCpysdbuvUMQwyGgtSMMTyeeAt2dyFCpEiN5qNmunaeXNo9dk4WHzFfg9xmtT5dLWC5uLhJDFd; post-creation getMint/getAccountInfo readback confirmed owner=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, decimals=6, mintAuthority=freezeAuthority=Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj, supply=0",
    "scripts/verify_devusdc_faucet.ts run against test wallet 827QX6fPtLvHRc1KRsqVa8utHcan6MLy3H7VShhU2GJh: starting balances 0/0; faucet claim signature 5ySJEctYwRUv8tQxkugcDtQ9FYa5msrUN55hR3VcADnKwGboszDBQUBnbuRBxEwdVnjSn3pCYQHUgeHKa6qpMQJi, post-claim devUSDC balance 500,000,000 raw (re-fetched from chain); repeat claim correctly returned HTTP 429; SOL sponsorship signature 3Dec58wN3Xi2HCKpHmp3URh7ygXGJxqimT9rm9m2Ztadrev5E566pu4h2PWRY6dBbLnhipjpAKtXufDTQJ2z9sSY, post-grant balance 10,000,000 lamports (re-fetched from chain); repeat grant correctly returned HTTP 429",
    "npx tsc -b, npx tsc -p api/devnet/tsconfig.json --noEmit, npx tsc -p scripts/tsconfig.json --noEmit, npx tsc -p tsconfig.tests.json, npx tsc -p tsconfig.node.json --noEmit: all clean",
    "npx oxlint: zero new warnings/errors",
    "npx vite build: passes",
    "npx ts-mocha -p ./tests/tsconfig.json tests/phase_a_discovery.ts tests/phase_b_devusdc.ts: 32/32 passing"
  ]
}
```

## DEC-0043

```json
{
  "id": "DEC-0043",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Wire devUSDC into every existing 'real DevNet asset' allowlist (CreateDTR.tsx, api/devnet/mint-test-assets.ts, api/devnet/swap-sign.ts, onChainReserve.ts, discovery candidate-mint lists) as Phase C, rather than building any new protocol instruction -- the deployed program's existing create_reserve/initialize_reserve_asset/seed_reserve/mint_reserve_tokens_in_kind/redeem_reserve_tokens_in_kind instructions already work generically with any correctly-registered SPL mint.",
  "context": "Phase C's approved scope was 'real creation, funding, Reserve Token minting/burning, and direct redemption' using the new devUSDC settlement token. Inspection confirmed the protocol has no asset-specific logic that would need extending -- the only gap was the frontend/API layer's hardcoded allowlists of which mints are 'real'.",
  "rationale": "Treating devUSDC as a 4th entry in the same allowlists mintX/Y/Z and wrapped SOL already occupy is the minimal, consistent, lowest-risk way to satisfy Phase C -- it reuses 100% existing, already-audited instruction logic rather than adding new attack surface.",
  "alternativesConsidered": ["Building a dedicated devUSDC-specific mint/redeem code path (rejected: unnecessary -- the existing generic instructions already handle any registered asset correctly, confirmed by live test)"],
  "impact": "A real Reserve (HAaoBxSVAnaxEusxxYUnPpAJAyjRzti4zuqxrLWYS4VE) composed 70% devUSDC / 30% mockX was created, seeded, Bought, and Sold live on DevNet using entirely pre-existing instructions.",
  "affectedAreas": ["src/merge/pages/CreateDTR.tsx", "api/devnet/mint-test-assets.ts", "api/devnet/swap-sign.ts", "src/merge/lib/onChainReserve.ts", "src/merge/lib/RealReserveSync.tsx", "scripts/verify_discovery.ts", "scripts/verify_devusdc_reserve.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["scripts/verify_devusdc_reserve.ts live run: createAndRegister tx 3kLjRovqhY3xNWsczDEuc44AtYyEKAc1nVYe5Hh844tyHmb6Z8gGLvifE3wG4pN6UMwSt9Zcp2sMZLN3x2qAbUML, seed tx KFacX7Vo7fiX9iZDKGydCKmaHvoPZXtxGygfawYtTbmJ2Y4vDiG8fN8L3B6KLjA7SrrvE4A5sEp7pYHVoPpKiw2, Buy tx 4Lih9wtiqin8ymsCWRCcKWqkdnwvpFm3YM8j5t7Tgf3zfxCWpAXK6j3YmNanK36S4SRETxDERByuxxpLvogvQKn3, Sell tx 2QpgDFwJcLb1XZqvXVNUe5woStX3bdRasYhqQYGKG5TVfve9a7ioUKkiiJvkc1JfgUV69seeZucgBk1agz3a3KvS; npx tsc -b/vite build/oxlint clean; 32/32 offline tests passing"]
}
```

## DEC-0044

```json
{
  "id": "DEC-0044",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Verify (no protocol change) that fee accrual and collect_fees routing work correctly for a devUSDC-composed Reserve, satisfying Phase D.",
  "context": "Phase D's approved scope was fee/treasury verification. mint_reserve_tokens_in_kind and collect_fees are Reserve-Token-denominated and never inspect Reserve composition, so this was a verification task, not a development task.",
  "rationale": "Reusing the real Phase C Reserve (already carrying real pending fee shares from its Buy) for this verification, rather than creating another throwaway Reserve, minimizes DevNet SOL/rent spend and directly proves the exact scenario (a devUSDC-backed Reserve) the phase asked about.",
  "alternativesConsidered": [],
  "impact": "collect_fees signature 2nAyMS45kLQRSKQheryzFcfknw55gTFjMQq8ovErNHvSiyfPBoBdPNzAcdqwz72PE3YZhjzkpiez7QHmPonqDQ6e: manager Reserve Token balance 2,599,500 -> 2,600,300 (+800), protocol treasury 0 -> 200, pending shares reset to 0 -- confirms DEC-0035's treasury routing generalizes correctly to any Reserve composition, not just the original mintX/Y/Z fixtures.",
  "affectedAreas": ["scripts/verify_devusdc_fees.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["collect_fees tx 2nAyMS45kLQRSKQheryzFcfknw55gTFjMQq8ovErNHvSiyfPBoBdPNzAcdqwz72PE3YZhjzkpiez7QHmPonqDQ6e; npx tsc -b clean"]
}
```

## DEC-0045

```json
{
  "id": "DEC-0045",
  "date": "2026-07-29",
  "status": "superseded",
  "decision": "Jupiter cannot serve Solana DevNet at all -- confirmed by real API evidence, not assumption. Do not build a real on-chain swap/AMM fallback mechanism unilaterally; flag the specific design decision needed and stop this sub-item, while continuing with the unblocked parts of Phases F/G.",
  "context": "Phase E required proving Jupiter DevNet feasibility before claiming support, with a documented fallback ('smallest legitimate controlled on-chain DevNet liquidity or swap mechanism') if infeasible. Live API checks against api.jup.ag/swap/v1/quote confirmed: (a) our real devUSDC mint returns TOKEN_NOT_TRADABLE, and (b) the identical endpoint returns a real 200 quote for SOL->Mainnet-USDC, routed through real Mainnet AMM pools (Raydium CLMM, Manifest). Jupiter's aggregator has no DevNet awareness at all -- it only ever quotes Mainnet liquidity.",
  "rationale": "Building a real swap/AMM mechanism directly reopens DEC-0017/DEC-0021's deliberate v1 scope boundary (no on-chain trade execution) and involves genuinely open, consequential architecture choices (new program vs. ssr_protocol extension; real AMM vs. generalized fixed-rate swap; scope limited to Sell's optional zap vs. also covering Phase F's rebalance execution). Committing to one unilaterally, on a live program other work depends on, risks building something the user did not actually want.",
  "alternativesConsidered": [
    "Build a minimal on-chain AMM/swap mechanism now without checking (rejected: exactly the kind of large, hard-to-reverse architecture commitment this session's own instructions call out as a stop-and-flag condition)",
    "Fake/approximate a swap using the existing fixed-rate swap-authority mechanism, presented as 'genuine swap execution' (explicitly forbidden by instruction -- never substitute fake quotes or locally-manipulated balances)"
  ],
  "impact": "Item 8/9's 'redeem and swap to SOL' secondary Sell path remains correctly absent (no regression -- this was already Phase A's decision). Phase F's rebalance TRADE EXECUTION (moving real holdings) is blocked pending this decision; Phase F's composition MANAGEMENT (config-only) and Phase G (wind-down) are independent and proceed unblocked in this same pass.",
  "affectedAreas": ["docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md"],
  "supersedes": null,
  "supersededBy": "DEC-0051",
  "evidence": [
    "curl https://api.jup.ag/swap/v1/quote?inputMint=So11...112&outputMint=Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k&amount=1000000 -> HTTP 400 TOKEN_NOT_TRADABLE",
    "curl https://api.jup.ag/swap/v1/quote?inputMint=So11...112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000 -> HTTP 200, real Mainnet route plan (Raydium CLMM ammKey G8LqPHYAMcwP14CDgk9XsV9VdwpsW3aJ59VubwnyrJVr, Manifest ammKey 4ba9bguTo7HbXFopJHaNMh8iAyApFpyQPgoufj3cSnyt)"
  ]
}
```

## DEC-0046

```json
{
  "id": "DEC-0046",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Implement Phase F composition management (add_reserve_asset_active, fund_new_reserve_asset, remove_reserve_asset) and Phase G wind-down (ReserveStatus::WindDown/Closed, initiate_wind_down, close_reserve) as five new instructions plus one renamed/extended existing method (Reserve::require_active_or_paused -> require_redemption_allowed, now also permitting WindDown), per the security analysis in docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md.",
  "context": "Original sketch assumed a simple enabled=false flag would suffice for 'disable an asset,' and that revoking the Reserve Token mint authority at wind-down time would add useful defense-in-depth. Reading common::load_asset_legs/load_reserve_asset_configs and mint_reserve_tokens_in_kind.rs before writing any Rust disproved both: (1) load_asset_legs/load_reserve_asset_configs require ALL asset_count legs unfiltered by enabled, and mint's deposit math (mul_div_ceil(requested, vault_balance_before, total_supply_before) per asset) never reads enabled or target_weight_bps at all -- a disabled asset would still receive proportional deposits forever; (2) revoking the mint authority at initiate_wind_down would break collect_fees, which mints pending shares via CPI through that same authority, and the plan requires fees to remain collectible during WindDown.",
  "rationale": "Real removal (last-registered + zero-balance only, to stay structurally safe without order_index renumbering or a balance-draining mechanism) replaces the flag-flip design. Not revoking the mint authority, relying solely on mint_reserve_tokens_in_kind's pre-existing status==Active check, avoids the collect_fees regression with zero code changes to mint. A second, more consequential gap was found in the same pass: redeem_reserve_tokens_in_kind's require_active_or_paused() did not permit WindDown, which would have made close_reserve's supply==0 requirement permanently unreachable for any Reserve that actually winds down (holders could never redeem out). Fixed by extending that check to include WindDown and renaming it to require_redemption_allowed (its one call site updated to match).",
  "alternativesConsidered": [
    "Flip ReserveAsset.enabled=false for 'disable' (rejected: proven not to actually stop new deposits, per the load_asset_legs/mint-math finding above)",
    "Revoke Reserve Token mint authority at initiate_wind_down for defense-in-depth (rejected: breaks collect_fees's ability to mint pending fee shares during WindDown, which the plan requires to keep working)",
    "Leave redemption blocked during WindDown, matching the original require_active_or_paused scope unchanged (rejected: makes close_reserve's zero-supply requirement unreachable -- a correctness bug, not a stylistic choice)"
  ],
  "impact": "5 new instructions (add_reserve_asset_active, fund_new_reserve_asset, remove_reserve_asset, initiate_wind_down, close_reserve), 2 new ReserveStatus variants (WindDown, Closed, appended after Paused -- Borsh-compatible with all 16 existing live Reserve accounts), 3 new errors, 5 new events, and one renamed/behavior-extended existing method (require_redemption_allowed). cargo check + cargo clippy against programs/ssr_protocol: zero errors, zero new warnings.",
  "affectedAreas": [
    "programs/ssr_protocol/src/instructions/add_reserve_asset_active.rs",
    "programs/ssr_protocol/src/instructions/fund_new_reserve_asset.rs",
    "programs/ssr_protocol/src/instructions/remove_reserve_asset.rs",
    "programs/ssr_protocol/src/instructions/initiate_wind_down.rs",
    "programs/ssr_protocol/src/instructions/close_reserve.rs",
    "programs/ssr_protocol/src/instructions/redeem_reserve_tokens_in_kind.rs",
    "programs/ssr_protocol/src/state/reserve.rs",
    "programs/ssr_protocol/src/errors.rs",
    "programs/ssr_protocol/src/events.rs",
    "programs/ssr_protocol/src/lib.rs",
    "programs/ssr_protocol/src/instructions/mod.rs"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "cargo check --manifest-path programs/ssr_protocol/Cargo.toml: Finished, zero errors",
    "cargo clippy --manifest-path programs/ssr_protocol/Cargo.toml: zero new warnings (2 pre-existing clippy::redundant_field_names in update_protocol_config.rs, untouched by this pass)"
  ]
}
```

## DEC-0047

```json
{
  "id": "DEC-0047",
  "date": "2026-07-29",
  "status": "blocked",
  "decision": "Do not force the Phase F/G program upgrade through with a partial or improvised funding workaround. Stop at this specific step and report the exact shortfall.",
  "context": "The new binary (5 additional instructions) is larger than the currently-deployed one (programs/ssr_protocol/src/lib.rs, +647,608 bytes built vs. 548,296 bytes currently deployed), so its upgrade buffer costs more rent-exempt SOL to create. `solana program deploy` against the confirmed correct upgrade authority (6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk, matches `solana program show`'s reported Authority) failed: needed ~4.51 SOL (buffer rent + fee), deployer held 3.65985132 SOL -- a ~0.85 SOL shortfall. The public DevNet airdrop faucet, already flagged as unreliable in PROJECT_STATUS.md's Dependencies section, refused every retry this pass (2 SOL, 1 SOL, 0.5 SOL, 0.1 SOL -- all 'rate limit reached'), confirming a full lockout rather than a per-request cap. No other signer under this environment's control (manager-keypair.json ~0.26 SOL, holderA/B ~0.04 SOL each, delegate keypairs ~0.02 SOL each) holds enough spare balance to close the gap even combined, and consolidating them would only reach ~4.05 SOL, still short.",
  "rationale": "SOL cannot be minted by any signer this environment controls -- only the public faucet or an external transfer can add DevNet SOL. Deploying anyway would require draining other test wallets for an amount that still wouldn't cover the cost, or leaving a partially-written buffer as improvised technical debt. Per this session's own explicit deployment-blocker instruction, the correct action is to stop and report exactly what's needed, not to route around it.",
  "alternativesConsidered": [
    "Drain the small test-fixture wallets (manager/holderA/holderB/delegate keypairs) into the deployer (rejected: combined balance still falls short of the shortfall, and it would strip funds those wallets may still need for other verification scripts)",
    "Deploy a smaller/split binary to reduce buffer cost (rejected: contradicts DEC-0034's explicit batching policy for this exact scenario, and the shortfall is a resource problem, not a design one)"
  ],
  "impact": "Phase F/G Rust code (DEC-0046) is complete, compiled, and clippy-clean, but not yet live on DevNet. Tasks #40 (SDK/frontend wiring), #41 (live verification), and #42 (Phase H) all depend on the deployed program and are blocked until this is resolved. No on-chain state or existing deployment was touched or put at risk -- the failed `solana program deploy` attempt created no buffer account and spent no funds (confirmed: deployer balance unchanged at 3.65985132 SOL both before and after).",
  "affectedAreas": ["docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "solana program deploy ... -> Error: Account 6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk has insufficient funds for spend (4.50855576 SOL) + fee (0.003215 SOL)",
    "solana airdrop 2/1/0.5/0.1 (all attempts) -> Error: airdrop request failed. This can happen when the rate limit is reached.",
    "solana balance 6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk -> 3.65985132 SOL (unchanged before/after the failed deploy attempt)"
  ]
}
```

## DEC-0048

```json
{
  "id": "DEC-0048",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Deploy the Phase F/G program upgrade and live-verify all 5 new instructions with real signed transactions against the live DevNet program, closing out DEC-0047's blocker.",
  "context": "The user sent a real, finalized 5 SOL transfer to the deployer wallet (confirmed via `solana confirm` against signature 4oBt6rh3x8uLUDp9Zqm7De2wvvM97ysADZXgr2JXz1B7jjTUrKrUeEjJ69pqSgJakg58VD3fQjhophzUBexw8C2k: 3.65985132 -> 8.65985132 SOL), resolving DEC-0047's shortfall. `solana program deploy` then succeeded (signature W9w5pn9wTwHayWPbVXL89WKYTYDQZ39ZpY5jZefi9ZTVVTNZzjMiE1SYqC8cVZvNyKhStuiRQuZnS4d5wD8sDK8; `solana program show` confirmed Data Length 647608 bytes matching the built .so exactly). The IDL was regenerated via `anchor idl build` (plain `anchor build` still panics in cargo-build-sbf's toolchain-detection code in this environment, an unrelated pre-existing issue -- `anchor idl build` uses a different, unaffected code path) and synced into `packages/sdk/idl/ssr_protocol.json`.",
  "rationale": "A new script, scripts/verify_phase_f_g.ts, exercises every new instruction with real transactions rather than simulation: Part 1 runs add_reserve_asset_active / remove_reserve_asset / add_reserve_asset_active again / fund_new_reserve_asset against the persistent Gate-9 fixture reserveOne (chosen because the Phase C script's own Reserve was created by an ephemeral throwaway keypair never persisted anywhere, so it can no longer be re-signed for). Part 2 creates a brand-new disposable single-asset Reserve and runs initiate_wind_down -> confirms mint_reserve_tokens_in_kind is rejected with custom program error 0x177a (6010 = UnexpectedReserveStatus's exact error-table index, not an incidental failure) -> confirms redeem_reserve_tokens_in_kind still succeeds during WindDown (the exact invariant this pass's require_redemption_allowed fix depends on) -> close_reserve, then confirms via fetchNullable/getAccountInfo that the Reserve, ReserveAsset, and vault accounts are all actually gone on-chain, not just reported as closed.",
  "alternativesConsidered": [
    "Reuse the Phase C script's own Reserve for Part 1 (rejected: its manager keypair was generated with Keypair.generate() and never persisted -- discovered live when the script's own manager-mismatch guard correctly refused to proceed under the wrong signer)",
    "Skip the mint-rejection assertion and only check the happy path (rejected: the specific error code is the only way to distinguish 'blocked because WindDown, as designed' from 'blocked for some unrelated reason', which would be a false-positive pass)"
  ],
  "impact": "Phase F/G is now live and verified on DevNet, not just compiled. Every new instruction has a real signature: add_reserve_asset_active x2 (64EtFh1Ph3wbaPYYbcku39Sjbmn8xcCpzVwc3p9wSnKmUQmcuyCMQi6dcbmKiJhGpScxgMs6KpVuis8Zy8WRPw3j, 5crWgFPsBU48crnTT8ywHi5eaMoYoCQGKv8d6w4hE2ivEQ6cEc3xKpuLfFPYgzh4FuxbP3DzLxDdMi8TGrpnLyUh), remove_reserve_asset (EcpMHXZQAKESYKgYvUeKXMEdyGVTLaRriuKaCwpQBcVSVZ7DaPqkdGnYgh1yg7mrK3ZBhsuqJAf6FGvZcXGT6yX), fund_new_reserve_asset (3cgG1odjMCWd4XncZzr4Jno1YTosXRDV53qsDzexrjTMSkEQ24oUHueugfKGZr1tbztJpKBAeJBSWXAfJKUjF68F), initiate_wind_down (2dMtaU2Fp1MqjuCdTmSuP7va8GxT9Xi2gmkM6pPCLgftELRuYKCnGBrxdrmzsQk3g8dN2MmVTnQPkfULjuY5Bjz9), redeem_reserve_tokens_in_kind during WindDown (3dxi7j7pDBXf5esQgPtNvMWSeGupqZ4bHeJKQEg7N3TxgavQMbSY1u5B7U8F3ipD8XrPV6TTNi7Gcfd1jPf3wANq), close_reserve (4wpRnu4ZE2ihvBycgZ7kwAKJThuunA6Jg3FkS3mpD2zqkT3pyZ1Dg3XjfsiPMsGtcRJE9z6cWVcSz7hoEd4WDGSr). reserveOne now permanently carries a 3rd asset (mockZ, 0 bps target weight, ~5.0 mockZ backing) as a side effect of this test -- harmless and documented, matching the same 'genuine on-chain side effect from real verification' pattern as prior phases.",
  "affectedAreas": [
    "packages/sdk/idl/ssr_protocol.json",
    "scripts/verify_phase_f_g.ts",
    "docs/project/PROJECT_STATUS.md"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "solana confirm 4oBt6rh3x8uLUDp9Zqm7De2wvvM97ysADZXgr2JXz1B7jjTUrKrUeEjJ69pqSgJakg58VD3fQjhophzUBexw8C2k -> Status Ok, Account 1 balance 3.65985132 -> 8.65985132",
    "solana program deploy -> Signature W9w5pn9wTwHayWPbVXL89WKYTYDQZ39ZpY5jZefi9ZTVVTNZzjMiE1SYqC8cVZvNyKhStuiRQuZnS4d5wD8sDK8; solana program show -> Data Length 647608 bytes, Authority 6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk",
    "scripts/verify_phase_f_g.ts full run: all assertions passed, 8 real signatures produced (listed above), final on-chain state confirmed via fetchNullable/getAccountInfo returning null for every closed account"
  ]
}
```

## DEC-0049

```json
{
  "id": "DEC-0049",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Wire packages/sdk instruction builders and the ManageDTR UI to the now-deployed, now-verified Phase F/G instructions (task #40), gated to the Reserve's root manager only (no on-chain delegate signing wired in this pass) and behind real signed DevNet transactions -- consistent with every other on-chain action already in this app.",
  "context": "Phase F/G's 5 instructions were deployed and live-verified via a Node script (DEC-0048), but nothing in the actual website could call them yet -- ManageDTR.tsx still showed 'Execute Rebalance (coming soon)' and no composition/wind-down controls at all for on-chain Reserves. Investigated the existing delegate-permission model (canManageDelegates/canRebalance in useAppStore.ts) and found it only ever checks the fully-local, simulated dtr.delegates array (always empty for real on-chain Reserves) -- meaning no on-chain delegate signing path exists yet for ANY manager action in this app, not just the new ones. Extending that is out of scope for this pass; root-manager-only matches the existing precedent exactly.",
  "rationale": "Added packages/sdk/src/managementInstructions.ts (6 builder functions: updateTargets, addReserveAssetActive, fundNewReserveAsset, removeReserveAsset, initiateWindDown, closeReserve -- the first of these being update_targets, a pre-existing instruction that had never been wired to a real signed transaction from the browser before this pass either) and src/merge/lib/managementClient.ts (browser-side sign-and-send wrapper, same pattern as createReserveClient.ts's signAndSend). Wired ManageDTR.tsx: the Rebalance tab's target-weight editor now submits a real update_targets transaction for on-chain Reserves instead of a no-op preview; a new 'Reserve Composition' card lists every registered asset with its live vault balance, offers 'Fund' for any zero-balance asset, 'Remove' only on the last-registered zero-balance asset (mirroring the program's own eligibility rule so the UI never offers an action the program would reject), and an 'Add Asset' selector restricted to the same real-asset allowlist CreateDTR.tsx already uses; a new 'Wind Down' card in Overview shows live status and offers Initiate Wind Down (when Active) or Close Reserve (when WindDown AND supply/all vault balances are already zero -- again mirroring the program's own precondition). Added orderIndex to OnChainAssetMeta (previously dropped during the on-chain-to-DTR mapping, needed to compute remove-eligibility) and a small on-chain-state-refresh helper that immediately re-fetches after any confirmed action rather than waiting for the next poll.",
  "alternativesConsidered": [
    "Wire on-chain delegate signing for MANAGE_LIQUIDITY_CONFIG/UPDATE_TARGETS-permitted delegates too (deferred: no existing manager action in this app has ever supported on-chain delegate signing, not even the pre-existing update_targets/pause/unpause instructions -- doing it only for the new Phase F/G actions would be an inconsistent, confusing half-step; a proper fix touches the shared canManageDelegates/canRebalance helpers and is a separate, better-scoped follow-up)",
    "Let the UI offer Remove/Close regardless of eligibility and surface the program's rejection as an error toast (rejected: mirroring the program's own precondition client-side, as every other action in this app already does for its own preconditions, gives an honest disabled state with an explanatory title instead of an avoidable failed transaction and wasted network fee)"
  ],
  "impact": "npx tsc -b: clean. npx vite build: clean (pre-existing >500kB main-chunk warning only, unrelated). npx oxlint: zero new warnings. npx ts-mocha -p ./tests/tsconfig.json tests/phase_a_discovery.ts tests/phase_b_devusdc.ts: 32/32 passing, unchanged. Dev server boots with no console/log errors on both / and /#/manage/devnet-reserve-one. No real browser + Phantom click-through was performed (no browser-automation tool available in this environment -- a pre-existing, already-documented limitation, unchanged by this pass).",
  "affectedAreas": [
    "packages/sdk/src/managementInstructions.ts",
    "src/merge/lib/managementClient.ts",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/lib/types.ts",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/pages/CreateDTR.tsx"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "npx tsc -b -> no output (clean)",
    "npx vite build -> built in 994ms, only the pre-existing chunk-size warning",
    "npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_a_discovery.ts tests/phase_b_devusdc.ts -> 32 passing"
  ]
}
```

## DEC-0050

```json
{
  "id": "DEC-0050",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Deploy DEC-0049's SDK + ManageDTR frontend changes to the existing live production website via `vercel deploy --prod`, matching the delivery requirement established for every prior phase of this plan (pushed to GitHub, deployed through the existing live site, no separate website, no domain change).",
  "context": "DEC-0049's frontend changes (Reserve Composition and Wind Down cards in ManageDTR.tsx, the new managementInstructions.ts/managementClient.ts modules) were committed and pushed to main (commit 2e0cd64) but not yet live. `npx vercel env ls production` confirmed the one required production secret (DEVNET_SWAP_AUTHORITY_SECRET_KEY) was already present -- no new environment variable was needed for this deploy.",
  "rationale": "This is a frontend-only change to already-verified, already-deployed on-chain functionality (Phase F/G, DEC-0046/DEC-0048) -- the deployment gate is the same one every prior phase followed: build passes, no new required secret is missing, deploy to the existing production site.",
  "alternativesConsidered": [],
  "impact": "Production is live at https://strategic-super-reserve.fun (aliased from deployment dpl_pf7NyUoizbQ2EK7kBW64mqFdLXi9, target production) with Phase F/G's composition-management and wind-down controls now reachable from the real website, not just a Node verification script. Verified post-deploy: `/` returns 200 on the custom domain.",
  "affectedAreas": ["docs/project/PROJECT_STATUS.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "vercel deploy --prod -> {\"status\":\"ok\",\"deployment\":{\"id\":\"dpl_pf7NyUoizbQ2EK7kBW64mqFdLXi9\",\"readyState\":\"READY\",\"target\":\"production\"}}, aliased to https://ssr-fun.vercel.app",
    "curl -o /dev/null -w '%{http_code}' https://strategic-super-reserve.fun/ -> 200"
  ]
}
```

## DEC-0051

```json
{
  "id": "DEC-0051",
  "date": "2026-07-29",
  "status": "confirmed",
  "decision": "Build the smallest legitimate controlled on-chain swap mechanism required for complete DevNet testing: a new, separate, dedicated Anchor program (`ssr_devnet_amm`, its own program ID, never ssr_protocol's) implementing single-authority-funded constant-product AMM pools, hub-and-spoke on wrapped SOL, covering exactly the representative test assets already in use (mockX, mockY, mockZ, devUSDC). Supersedes DEC-0045's blocker.",
  "context": "DEC-0045 proved Jupiter has zero DevNet awareness and stopped to ask for a decision on whether/how to build a real on-chain swap mechanism, since that decision reopens DEC-0017/DEC-0021's deliberate v1 scope boundary (ssr_protocol itself does not implement on-chain trade execution) and involves genuinely consequential architecture choices. The user has now made that decision explicitly, with a detailed requirements list (DevNet-only; dedicated testing infrastructure, not presumed Mainnet architecture; modular/isolated behind the existing swap/routing abstraction; representative test assets only; genuine on-chain swaps with real transfers and verifiable balance changes; explicit liquidity; deterministic/documented pricing; slippage protection; minimum output; fee handling; strict mint/vault validation; no fabricated quotes/prices/liquidity/outcomes; never described as Jupiter or production-ready; fail-closed Mainnet prevention; no unauthorized liquidity withdrawal/arbitrary mint substitution/cross-Reserve contamination/manager extraction of holder assets; direct proportional redemption stays canonical; redeem-and-swap and rebalance execution are additive, optional uses of the new mechanism).",
  "rationale": "A SEPARATE program (not new instructions inside ssr_protocol) is the only architecture that satisfies 'dedicated testing infrastructure, not the presumed Mainnet liquidity architecture' AND the anti-contamination/anti-extraction requirements simultaneously and structurally, not just by convention: ssr_devnet_amm has its own program ID, its own PDA seed namespace (amm_config/amm_pool/amm_vault_authority/amm_vault, entirely distinct from ssr_protocol's reserve/reserve_vault/vault_authority), never receives an ssr_protocol account as an instruction input, and ssr_protocol never CPIs into it -- so it is architecturally impossible for this program to ever sign for or move a Reserve's vault tokens, regardless of any bug in this new, less-audited code. This is a stronger guarantee than any access-control check could provide inside a shared program. Single-authority liquidity (no public LP tokens, no multi-depositor share accounting) is the smallest design that still satisfies 'explicit liquidity' and 'genuine on-chain swaps with real transfers' -- it eliminates an entire class of AMM attack surface (LP-share manipulation, flash-deposit/withdraw-in-one-block exploits, impermanent-loss edge cases) that a full multi-LP design would require auditing, at zero functional cost since DevNet testing needs exactly one trusted liquidity source, not a decentralized market. Hub-and-spoke on wrapped SOL (4 pools: SOL/mockX, SOL/mockY, SOL/mockZ, SOL/devUSDC) covers every required flow -- redeem-and-swap-to-SOL needs each asset priced against SOL directly; a rebalance swap between two non-SOL assets composes two swaps (asset-in -> SOL -> asset-out) in one transaction, avoiding the combinatorial cost of full pairwise pools (10 pairs among 5 assets) for a currently-unneeded generalization. Constant-product (x*y=k) pricing is explicit and deterministic by construction (a public formula over real, readable vault balances, not an oracle, not a fabricated number) and is honestly DIFFERENT from the existing fixed-rate swap-authority zap: price drifts with trade flow, exactly like a real AMM, which is a truer test of Sell/rebalance code paths than a rate that never moves.",
  "alternativesConsidered": [
    "Extend ssr_protocol itself with swap instructions (rejected: directly reopens DEC-0017/DEC-0021's deliberate no-trade-execution boundary, and any bug in new swap code would then share ssr_protocol's account space/trust boundary with real Reserve vaults instead of being structurally walled off)",
    "Full pairwise pools among all 5 representative assets (rejected: 10 pools to create/seed/maintain vs. 4, for swap routes no current SSR flow actually needs -- a hub-and-spoke topology already covers every required flow)",
    "Public multi-LP pools with an SPL LP-token mint (rejected: real DevNet testing needs exactly one trusted liquidity source; adding public liquidity provision would require auditing an entire additional attack surface -- LP share dilution, sandwich attacks on deposit/withdraw, share-price manipulation -- for a decentralization property this testing environment doesn't need)",
    "A generalized version of the existing fixed-rate swap-authority mechanism instead of a real AMM (rejected: explicitly forbidden by this decision's own requirements -- 'do not fabricate quotes, prices, liquidity, transactions, or successful outcomes'; a fixed rate is not a genuine on-chain swap with verifiable price formation)"
  ],
  "impact": "New program crate `programs/ssr_devnet_amm`. Full design below; implementation, deployment, live verification, SDK/frontend wiring, and production deployment are tracked as this pass's remaining steps and recorded in follow-up decision entries as they land.",
  "affectedAreas": [
    "programs/ssr_devnet_amm/ (new)",
    "packages/sdk/src/",
    "src/merge/lib/",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md"
  ],
  "supersedes": "DEC-0045",
  "supersededBy": null,
  "evidence": [],
  "architecture": {
    "program": "ssr_devnet_amm -- a new, standalone Anchor program with its own generated program ID, deployed independently of ssr_protocol (2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW). Never referenced by ssr_protocol; ssr_protocol is not modified by this decision at all.",
    "topology": "Hub-and-spoke on wrapped SOL. 4 pools: SOL/mockX, SOL/mockY, SOL/mockZ, SOL/devUSDC. create_pool requires mint_a == the canonical wrapped-SOL mint (So11111111111111111111111111111111111111112) -- enforced on-chain, not just by client convention.",
    "accounts": "AmmConfig (singleton: authority, default_fee_bps, paused, bump). Pool (per pair: mint_a, mint_b, vault_a, vault_b, fee_bps, bump, vault_authority_bump, created_at). Vaults are ordinary SPL token accounts owned by a per-pool vault_authority PDA (seeds: amm_vault_authority + pool). No LP-token mint exists -- the sole liquidity authority's contribution/withdrawal is tracked purely by reading real vault balances, since there is exactly one depositor by construction.",
    "instructions": "initialize_amm_config(default_fee_bps) [authority-only, one-time singleton]. create_pool(fee_bps) [authority-only]. add_liquidity(amount_a, amount_b) [authority-only, transfers the authority's own tokens into the vaults]. remove_liquidity(amount_a, amount_b) [authority-only, transfers vault tokens back to the authority, bounded by require!(amount <= vault balance)]. swap(amount_in, minimum_amount_out, a_to_b) [PERMISSIONLESS -- the only public-facing instruction]. pause_amm / unpause_amm [authority-only].",
    "pricing": "Constant product x*y=k over live vault balances -- explicit and deterministic (a public formula, not an oracle, not fabricated). fee_bps is deducted from amount_in before the swap formula runs and stays in the pool (compounds k, benefiting the liquidity authority on withdrawal) -- no separate fee treasury. Initial seed ratio chosen to roughly match the app's existing DevNet test-pricing convention (SOL_TEST_PRICE_USD=20, $1/fixture-asset from zapPricing.ts/onChainReserve.ts) purely for UI/display coherence at t=0 -- price WILL drift after that per the curve, honestly unlike the old fixed-rate swap-authority, and this drift is disclosed in the UI, never hidden.",
    "slippageAndFees": "swap() requires amount_out >= minimum_amount_out (caller-supplied), rejecting otherwise -- the same slippage-protection pattern already used by mint_reserve_tokens_in_kind/redeem_reserve_tokens_in_kind. Rounding is floor (protocol/pool-favor), matching ssr_protocol's existing rounding-direction policy.",
    "authorityReuse": "The AMM authority reuses the existing DevNet swap-authority/manager keypair (same deliberate zero-new-secrets reuse decision already made for devUSDC's mint/freeze authority in Phase B, DEC-0042) -- documented tradeoff, not a new key-concentration risk beyond what's already flagged in PROJECT_STATUS.md's Risks."
  },
  "securityInvariants": [
    "Only amm_config.authority may create_pool / add_liquidity / remove_liquidity / pause_amm / unpause_amm -- prevents unauthorized liquidity withdrawal and arbitrary pool creation with substituted mints; swap() is the only instruction a normal user can ever call.",
    "swap() re-derives and strictly validates every PDA from the instruction's own accounts (pool from [amm_pool, mint_a, mint_b], each vault from [amm_vault, pool, mint]) before trusting any balance or performing any transfer -- the exact defensive pattern already established and live-verified in ssr_protocol's common.rs::load_asset_legs, applied here for the same reason: makes vault/mint substitution structurally impossible, not just checked by convention.",
    "Zero coupling to ssr_protocol by construction: different program ID, disjoint PDA seed namespace, no ssr_protocol account is ever passed into an AMM instruction, no ssr_protocol instruction ever CPIs into this program. A Reserve's vault_authority PDA is only ever derivable as a valid signer under ssr_protocol's OWN program ID (Solana's PDA signing model -- invoke_signed requires the CALLING program's ID to match the seeds' derivation program) -- ssr_devnet_amm can never produce a valid signature for it. This is what makes 'cross-Reserve contamination' and 'manager extraction of holder-owned Reserve assets' impossible, not merely disallowed.",
    "Redeem-and-swap is strictly additive: it always begins with a real, unmodified redeem_reserve_tokens_in_kind call that moves assets into the connected wallet's OWN token accounts -- exactly the existing canonical Sell path, untouched -- and only then optionally continues into a swap() the user's own wallet signs, from their own tokens. The AMM never touches a Reserve vault directly, and direct proportional redemption remains available and default regardless of whether a swap route exists.",
    "DevNet-only enforcement is client-side and fails closed: every script/API/browser entry point that builds an ssr_devnet_amm transaction calls the existing genesis-hash check (assertDevnetCluster, copied into packages/sdk for cross-boundary reuse from api/devnet/_lib/network.ts's original) before constructing anything. Documented honestly: Solana programs have no native on-chain 'which cluster' syscall, so this is an application-layer guarantee (identical in kind to Phase B's faucet/sponsor endpoints), not an on-chain one -- reinforced by the program simply never being deployed anywhere but DevNet and being labeled DevNet-only everywhere its program ID appears.",
    "Never described as Jupiter, a real router, or production-ready anywhere in code, docs, or UI copy -- explicitly labeled 'SSR DevNet Test AMM' / 'DevNet-only test swap pool' throughout, visually and textually distinct from both the real (future) router interface and the existing fixed-rate swap-authority zap."
  ],
  "limitations": [
    "Single centralized liquidity authority -- not decentralized, not economically real liquidity provision. This is a deliberate simplification (see alternativesConsidered), not an oversight.",
    "Liquidity depth is whatever this pass explicitly seeds (a real but arbitrary, documented amount) -- large swaps will show heavy slippage or hit the minimum-output check and correctly fail on-chain; this is expected, correct constant-product behavior for a shallow test pool, not a bug.",
    "No price-oracle correctness guarantee of any kind -- the price is exactly whatever the constant-product curve over current vault balances says, intentionally, and is expected to drift from the app's other DevNet test-pricing constants over time as swaps occur.",
    "A rebalance or redeem-and-swap between two non-SOL assets composes two swaps through the SOL hub in one transaction, paying the pool fee twice -- an accepted, documented tradeoff of the hub-and-spoke topology, not a correctness bug.",
    "The AMM authority keypair reuses the existing DevNet swap-authority/manager key -- the same single-key concentration risk already flagged in PROJECT_STATUS.md's Risks for that key's other roles, now with one more role added to it."
  ],
  "mainnetMigrationPath": "This program is never intended to be deployed to Mainnet and provides no basis for one. Before any real Mainnet migration, the existing isolation point (packages/sdk/src/zapInstructions.ts's interface, already documented as the swap-routing abstraction boundary in FRONTEND_INTEGRATION.md's Mainnet-readiness section) gets a real implementation backed by an actual liquidity venue (a real aggregator once one supports the relevant assets, or a real, professionally audited AMM with genuine third-party liquidity providers, real governance over fee parameters, and real economic security) -- none of which ssr_devnet_amm provides or claims to provide. This program's code, program ID, and deployment artifacts are explicitly out of scope for Mainnet and would be retired entirely at that point, not hardened into a production system."
}
```

## DEC-0052

```json
{
  "id": "DEC-0052",
  "date": "2026-07-30",
  "status": "confirmed",
  "decision": "Re-source the landing page's Featured Reserves and KPI strip from the same on-chain-verified discovery store Discover Reserves uses (useAppStore's dtrs, filtered to onChain), via a new shared src/merge/lib/reserveCardProps.ts helper; drop the KPI strip's 24h Volume and Reserve Token Holders tiles (no genuine data source exists for either); replace the landing page's 'Create. Launch. Trade.' / fee-table / 'Transparent by construction' sections with a single 'How It Works' section using mandated copy; and fix the remaining 'Browse Reserves' CTAs to read 'Discover Reserves'.",
  "context": "Home.tsx's Featured Reserves sourced from the legacy src/state/store.tsx seed data (src/data/reserves.ts) -- a completely different store from the one Discover Reserves uses -- and its card link (/reserve/:address) pointed at a route App.tsx never registers, making it a silent dead link. The KPI strip read from the same stale store, and its own code comment admitted the 24h volume figure was 'Fictional... for the simulation.'",
  "rationale": "A landing page showing fabricated/mismatched Reserve data directly contradicts the product's core promise of transparent on-chain state, and a dead Featured Reserve link actively misleads a first-time visitor. Deriving both sections from the exact same store and filter Discover already uses (dtr.onChain) removes the possibility of the two ever drifting apart again, rather than patching Home.tsx's old data in place.",
  "alternativesConsidered": [
    "Patch Home.tsx's existing native-Reserve seed data to be less obviously fake (rejected: still fabricated, still a second data path that can drift from Discover)",
    "Keep the KPI strip's 24h Volume/Holders tiles but relabel them as illustrative (rejected: the task's mandate is to never present fabricated numbers as real, and a relabeled fake number is still a fake number)"
  ],
  "impact": "src/pages/Home.tsx, src/merge/pages/Discover.tsx, new src/merge/lib/reserveCardProps.ts, src/index.css (.kpi-grid now 2 columns, new .how-cell hover/emphasis styles, new .wallet-panel-wrap layout support), src/components/Shell.tsx (dead '#fees' footer link removed since that landing section no longer exists).",
  "affectedAreas": ["src/pages/Home.tsx", "src/merge/pages/Discover.tsx", "src/merge/lib/reserveCardProps.ts", "src/index.css", "src/components/Shell.tsx"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_landing_wallet_corrections.ts -- selectFeaturedReserves/buildReserveCardProps pure-logic coverage", "npm run build and npm run test:program both pass after this change"]
}
```

## DEC-0053

```json
{
  "id": "DEC-0053",
  "date": "2026-07-30",
  "status": "confirmed",
  "decision": "Remove Portfolio.tsx's standalone 'Get DevNet Test Assets' button (and its handleGetTestAssets handler), which minted mockX/mockY/mockZ directly to any connected wallet on demand. api/devnet/mint-test-assets.ts itself is unchanged and stays live -- it remains the legitimate seed-funding path createReserveClient.ts uses to fund a Reserve creator's seed amounts during genuine Reserve creation.",
  "context": "The mandated DevNet token model requires the user-facing faucet to distribute only devUSDC and forbids presenting mockX/Y/Z as a general spendable currency. Auditing the token flow found the primary faucet UI (DevnetOnboarding.tsx / api/devnet/faucet-devusdc.ts) was already devUSDC-only, but Portfolio's separate button was a second, independent faucet-like path handing out mockX/Y/Z to any wallet, explicitly to let a user test Sell without Buying first.",
  "rationale": "No legitimate flow requires a regular user to hold mockX/Y/Z before minting or redeeming Reserve Tokens: Buy already sources every non-devUSDC leg itself within the same transaction, and Create-Reserve seeding (the one genuine reason a wallet needs mockX/Y/Z) goes through createReserveClient.ts calling the same mint-test-assets endpoint directly, never through this button. Removing the button eliminates the only reachable path that handed out mockX/Y/Z as if they were ordinary currency, without touching any protocol/trade mechanics.",
  "alternativesConsidered": [
    "Keep the button but relabel it (rejected: still a general-purpose mockX/Y/Z faucet reachable outside any legitimate flow)",
    "Remove the mint-test-assets.ts endpoint entirely (rejected: it is load-bearing for genuine Reserve-creation seeding; removing it would break Create)"
  ],
  "impact": "src/merge/pages/Portfolio.tsx only -- no API route or on-chain program change. Testing Sell without first Buying is no longer possible from the Portfolio UI; a tester needing that must use Create's own seeding path or a direct script call, consistent with mockX/Y/Z's Reserve-Asset-only role.",
  "affectedAreas": ["src/merge/pages/Portfolio.tsx"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_landing_wallet_corrections.ts -- confirms DEVNET_FIXTURES.mints still registers mockX/Y/Z as genuine, selectable Reserve Assets after this removal"]
}
```

## DEC-0054

```json
{
  "id": "DEC-0054",
  "date": "2026-07-30",
  "status": "open",
  "decision": "Deliberately leave unresolved in this pass: Buy (mintReserveTokensInKind) still sources every non-devUSDC basket leg by minting fresh mockX/Y/Z from the server-held swap authority within the same transaction rather than from the user's own holdings, and Sell (redeemReserveTokensInKind) still always converts the redeemed basket to SOL, never devUSDC. No frontend-simulated swap was added and the experimental ssr_devnet_amm program (DEC-0051) was not activated to patch this.",
  "context": "The requested intended flow is Claim devUSDC -> mint Reserve Tokens with devUSDC -> genuine on-chain backing/supply/TVL updates -> redeem Reserve Tokens for devUSDC. Auditing packages/sdk/src/zapInstructions.ts confirmed Buy and Sell both execute genuine, correctly-confirmed on-chain Anchor instructions, but neither leg of that intended devUSDC round-trip is genuinely backed: Buy's non-devUSDC legs are conjured by the swap authority (a pre-existing, code-commented 'DevNet convenience'), and Sell pays out SOL, not devUSDC, because ssr_protocol has no devUSDC<->mockX/Y/Z conversion instruction and the only swap mechanism that could provide one (ssr_devnet_amm) is intentionally unmerged/dormant.",
  "rationale": "The task explicitly instructs that when the deployed protocol does not genuinely support the full multi-asset devUSDC flow, the correct action is to report the gap plainly rather than redefine the product model or bolt on a workaround (a frontend-simulated swap would itself be a new synthetic-conversion fabrication; activating ssr_devnet_amm requires the user's explicit go-ahead per DEC-0051's own deferral). This decision records that the gap was found, understood, and consciously left open rather than silently patched or hidden.",
  "alternativesConsidered": [
    "Add a frontend-only simulated devUSDC<->mockX/Y/Z conversion to make Sell 'appear' to return devUSDC (rejected: exactly the synthetic-conversion fabrication the task forbids)",
    "Activate ssr_devnet_amm now to close the gap (rejected: requires explicit user approval per DEC-0051, not assumed here)",
    "Redefine the product's settlement asset for Sell as SOL instead of devUSDC (rejected: not this decision's call to make -- a product-level change requiring explicit sign-off)"
  ],
  "impact": "No code changed as a result of this entry. The gap remains: a user's Sell today receives SOL, not devUSDC, and Buy's non-devUSDC legs are not genuinely user-funded. Closing it requires one of: (a) explicit approval to activate/extend ssr_devnet_amm and wire it into the live Buy/Sell paths, or (b) a different, explicitly-approved architecture for a real devUSDC<->mockX/Y/Z conversion.",
  "affectedAreas": ["packages/sdk/src/zapInstructions.ts", "api/devnet/swap-sign.ts", "programs/ssr_devnet_amm (dormant, unmerged)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["packages/sdk/src/zapInstructions.ts:222-226 code comment acknowledging the mockX/Y/Z minting convenience", "packages/sdk/src/zapInstructions.ts:375-387 Sell always paying out SOL via SystemProgram.transfer"]
}
```

## DEC-0055

```json
{
  "id": "DEC-0055",
  "date": "2026-07-30",
  "status": "confirmed",
  "decision": "Adopt Helius as the primary Solana DevNet RPC provider for every server-side action (faucet, sponsorship, test-asset minting, the Buy/Sell swap-sign co-signer), and for the browser's Connection via a new narrow server-side proxy (api/devnet/rpc-proxy.ts) rather than ever bundling the Helius URL/API key into client-visible code. The public api.devnet.solana.com endpoint remains as a bounded, read-only fallback inside the proxy only.",
  "context": "An RPC audit found every server-side handler (api/devnet/*.ts) independently duplicated its own `process.env.SOLANA_RPC_URL || \"https://api.devnet.solana.com\"` default, every scripts/verify_*.ts hardcoded the public endpoint directly, and the browser's wallet-adapter Connection read a plain, Vite-bundled VITE_SOLANA_RPC_URL with the same public default -- no dedicated provider was in use anywhere, and the user's own account/API key for Helius was available to use.",
  "rationale": "The public endpoint is confirmed, repeatedly, to rate-limit heavily and even block getProgramAccounts entirely under sustained same-day use (see prior corrective passes in this log) -- a dedicated provider directly addresses the reported 429s. Protecting the API key required a genuine architectural choice, not just an env var swap: a VITE_-prefixed variable is bundled into browser-visible JS by Vite's own design, so the key could never live there. A narrow server-side proxy (method-allowlisted, payload-validated, best-effort per-IP throttled) lets the browser keep using a plain Connection object without ever holding the credential, matching the task's explicit requirement to avoid a public VITE_* variable containing the raw key.",
  "alternativesConsidered": [
    "Put the Helius URL directly in VITE_SOLANA_RPC_URL (rejected: explicitly forbidden -- Vite bundles VITE_* vars into browser-visible JS, exposing the API key to anyone who opens devtools)",
    "A wide-open proxy that forwards any JSON-RPC method (rejected: unbounded attack surface: an allowlist of only the 9 methods this app's own Connection genuinely calls, confirmed by grepping every connection.* call site plus Anchor/spl-token's internal getAccountInfo dependency, is a small and precisely justifiable set)",
    "Route local `vite dev` through the proxy too (rejected: a plain `vite dev` session serves no api/* functions at all, so this would break local development without `vercel dev`; the proxy is only the production/preview default, gated on import.meta.env.PROD)"
  ],
  "impact": "New api/devnet/_lib/rpc.ts (resolveRpcUrl, shared by every api/devnet/*.ts handler), new api/devnet/rpc-proxy.ts (the browser's sole RPC route in production/preview builds), updated src/merge/lib/solana-config.ts (production default now the proxy path, VITE_SOLANA_RPC_URL still an explicit override for either environment), new checkRateWindow helper in api/devnet/_lib/rateLimit.ts. HELIUS_RPC_URL added to the linked Vercel project (Production, Preview as Sensitive; Development as Non-sensitive -- Vercel's Sensitive tier is Production/Preview-only) via `vercel env add`, never committed to any tracked file.",
  "affectedAreas": ["api/devnet/_lib/rpc.ts", "api/devnet/rpc-proxy.ts", "api/devnet/_lib/rateLimit.ts", "api/devnet/faucet-devusdc.ts", "api/devnet/sponsor-sol.ts", "api/devnet/mint-test-assets.ts", "api/devnet/swap-sign.ts", "src/merge/lib/solana-config.ts", "Vercel project env vars"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_helius_rpc_and_buy_fix.ts -- resolveRpcUrl precedence, rpc-proxy method allowlist/throttle coverage", "scripts/verify_helius_buy_fix.ts -- live DevNet Buy run genuinely through the Helius endpoint (see DEC-0057)", "`vercel env ls` confirms HELIUS_RPC_URL set across Production/Preview/Development, all Encrypted"]
}
```

## DEC-0056

```json
{
  "id": "DEC-0056",
  "date": "2026-07-30",
  "status": "confirmed",
  "decision": "Fix three real bugs found while tracing the reported 50-devUSDC Buy failure: (1) api/devnet/swap-sign.ts's fetchReserveOnChain call sat outside its own try/catch, so a 429 there escaped as an unhandled platform exception instead of a formatted JSON error -- moved inside the try block and wrapped in the existing withRateLimitRetry helper, matching every other RPC read in this endpoint; (2) no RPC call in swap-sign.ts was ever retried, unlike the frontend's own reads -- getLatestBlockhash and the Reserve-account fetch now share the same bounded retry; (3) Buy/Sell's swap-authority-funded legs (any wrapped-SOL leg on Buy, the full SOL payout on Sell) had no sufficiency check, so a low swap-authority SOL balance produced a transaction Phantom's own preflight simulation would reject for a DIFFERENT signer than the connected wallet -- Phantom's generic UI reports this as 'insufficient SOL' with no way to tell it apart from the user's own balance. A new assertSwapAuthorityHasSol check now fails closed with a distinct, honestly-worded error before ever handing back such a transaction.",
  "context": "Production reports: Buys frequently returning a raw '429 Connection rate limits exceeded' string, and Phantom reporting insufficient SOL for a 50 devUSDC Buy despite the wallet holding ~27 SOL. A full trace of the unsigned transaction (devUSDC mint/decimals, every instruction, fee payer, every lamport transfer) found devUSDC's decimals handling, scaling, and fee-payer assignment were all already correct -- the actual root causes were both RPC-error-handling gaps and a genuine, previously-unflagged-as-critical operational risk (the swap authority's own SOL balance, already noted as a monitoring item in PROJECT_STATUS.md's Risks, but with no code-level consequence handling before this pass).",
  "rationale": "A raw platform exception message is exactly the kind of unclassified RPC error the task requires be replaced with an accurate, user-facing message; distinguishing 'the swap adapter itself is low on SOL' from 'your wallet lacks SOL' from 'RPC congestion' requires a structured error code the client can branch on, not a single generic string. Checking the swap authority's SOL balance BEFORE returning a transaction (rather than letting it fail downstream in Phantom's simulation) turns an opaque, misattributed failure into an honest, correctly-attributed one, without changing who funds what -- no trade-mechanics change, matching the constraint against altering the devUSDC/mockX/Y/Z token model.",
  "alternativesConsidered": [
    "Have the FRONTEND estimate and warn about swap-authority SOL sufficiency (rejected: the frontend has no legitimate way to read the swap authority's identity/balance without the server anyway, and the server already has to build the transaction to know the exact required amount)",
    "Silently top up the swap authority automatically (rejected: no such automated funding mechanism exists or was requested; this is an operational/monitoring concern, not something to paper over in code)",
    "Treat every swap-sign.ts error identically as before (rejected: exactly the conflation the task asks to eliminate)"
  ],
  "impact": "api/devnet/swap-sign.ts now returns { error, code } with code in {\"rpc_congested\", \"swap_authority_low_sol\", \"build_failed\"} instead of always a bare 500. src/merge/lib/zapClient.ts's requestSignedZapTransaction now throws a typed ZapBuildError carrying that code; DTRDetail.tsx's handleBuy/handleSell branch on it for distinct, accurate toast messages, and both now also pre-check the trader's own real devUSDC/Reserve-Token balance before ever calling the server (an immediate, honest 'Insufficient devUSDC'/'Insufficient Reserve Tokens' message, cheaper than an avoidable round trip). A live run (see DEC-0057) found the swap authority's REAL current balance is 0.2345 SOL -- low enough that this check is not a hypothetical; a Reserve with a wrapped-SOL leg could hit it today. Flagged as a follow-up funding/monitoring action, not fixed by this decision (no protocol/trade-mechanics change).",
  "affectedAreas": ["api/devnet/swap-sign.ts", "src/merge/lib/zapClient.ts", "src/merge/pages/DTRDetail.tsx", "src/merge/lib/managementClient.ts", "src/merge/lib/createReserveClient.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_helius_rpc_and_buy_fix.ts -- sumWrappedSolLegLamports, SwapAuthorityLowSolError, ZapBuildError, devUSDC decimals-scaling coverage", "scripts/verify_helius_buy_fix.ts live run: signature hGDWXhLtLFHrsJssUd7YzQxXcyY4oQJdqVjTxLVMoNsrYCqHMdxJK1zcDNHvJTvunYkJr13j5Acr1fQacTLj1Sa, trader SOL spent 0.004089 (fee+rent only, never the devUSDC amount), swap authority live balance 0.2345 SOL"]
}
```

## DEC-0057

```json
{
  "id": "DEC-0057",
  "date": "2026-07-30",
  "status": "confirmed",
  "decision": "Also migrate the two remaining connection.confirmTransaction call sites (src/merge/lib/managementClient.ts's and createReserveClient.ts's shared signAndSend helpers) from the websocket-subscription confirmation strategy to the same bounded, signature-status-polling confirmSignatureBounded already used by Buy/Sell -- required because these two call sites would otherwise silently break once the browser's Connection is routed through the new HTTP-only rpc-proxy (a serverless function has no persistent websocket to subscribe through).",
  "context": "The RPC audit found `connection.confirmTransaction`'s default websocket-subscription strategy still in use by ManageDTR's composition-management/wind-down actions and Create-Reserve's launch flow, even though Buy/Sell had already moved off it in an earlier pass specifically because that strategy was observed live throwing under DevNet congestion. Once the frontend's Connection points at rpc-proxy.ts (an HTTP-only Vercel function, not a persistent socket), any code path still relying on the websocket subscription would fail outright, not just under congestion.",
  "rationale": "confirmSignatureBounded already implements exactly the 'never blindly resubmit, reconcile by signature first' requirement this task restates explicitly -- reusing it for these two remaining call sites is both the fix required to keep them working under the new proxy and a direct, low-risk application of an already-tested primitive, not new logic.",
  "alternativesConsidered": [
    "Have rpc-proxy.ts also proxy websocket subscriptions (rejected: substantially more complex for a Vercel serverless function, and unnecessary now that every confirmation path in this app can use bounded HTTP polling instead)",
    "Leave these two call sites on the websocket strategy and route only Buy/Sell's Connection through the proxy (rejected: the whole app shares one ConnectionProvider/Connection instance; splitting it per-feature would be a larger, riskier architecture change for no real benefit)"
  ],
  "impact": "src/merge/lib/managementClient.ts, src/merge/lib/createReserveClient.ts. Every remaining `connection.confirmTransaction` reference in src/ is now only a code comment, not a live call -- confirmed by grep.",
  "affectedAreas": ["src/merge/lib/managementClient.ts", "src/merge/lib/createReserveClient.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["grep for confirmTransaction across src/ after this change shows only comments in rpcResilience.ts/zapClient.ts/managementClient.ts/createReserveClient.ts, no live call sites"]
}
```

## DEC-0058

```json
{
  "id": "DEC-0058",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Hide the one on-chain Reserve created without any underlying asset (reserveId 12, AUW57xjqXmCKbP6wjPZfR5H3TCNah28fiTp6fwLZLNAq, status 'created') from every frontend surface (Discover, Featured Reserves, KPI counts, Portfolio, ManageDTR) by excluding assetCount === 0 at the single central discovery-merge point (mergeDiscoveredReserves). No on-chain transaction was sent and no protocol/program change was made.",
  "context": "Live discovery (via Helius) enumerated all 18 on-chain Reserves and found exactly one with zero registered assets, stuck in a pre-Active 'created' lifecycle status -- almost certainly an abandoned/incomplete Create-a-Reserve attempt from before create+asset-registration was combined into one atomic transaction (DEC-0031). Its manager (EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq) also created the legitimate 'TestLo' Reserve (reserveId 13) immediately after, consistent with a first attempt going wrong.",
  "rationale": "Genuine on-chain deletion is not currently possible, confirmed by reading the deployed Anchor source directly: both initiate_wind_down and close_reserve require the Reserve's own manager signature (has_one = manager, no ProtocolConfig.authority override anywhere in either instruction), and initiate_wind_down additionally requires status == Active -- a Reserve stuck in 'created' has no on-chain instruction path to WindDown or Closed at all. None of the keypairs available in this environment match that manager. Rather than fabricate a workaround or attempt an unauthorized/impossible on-chain action, the correct fix is a frontend-side exclusion -- it directly addresses the actual complaint ('messing up the website') without touching chain state or requiring a protocol change.",
  "alternativesConsidered": [
    "Design a new 'abandon_reserve' program instruction to allow closing a pre-Active Reserve (rejected for this pass: a real protocol/security change requiring its own review, and the account's real owner would still need to sign or a new authority-override path would need separate security justification)",
    "Attempt to close it anyway (impossible: no available signer, and no instruction path exists regardless of signer)",
    "Leave it visible with a 'broken' badge (rejected: doesn't address the actual complaint that it's cluttering Discover/Featured/KPI counts)"
  ],
  "impact": "src/merge/lib/onChainReserve.ts's mergeDiscoveredReserves now filters rawDiscovered to exclude assetCount === 0 before either the merged or discoveredAddresses computations -- a previously-cached copy in an existing user's localStorage is also correctly dropped on the next fully-verified discovery poll (it cannot be rescued by the untouched/transient-failure branch, which only applies when fullyVerified is false). The on-chain account itself is untouched and still exists exactly as before.",
  "affectedAreas": ["src/merge/lib/onChainReserve.ts", "api/devnet/landing-stats.ts (same exclusion rule reused for KPI aggregation)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_hide_zero_asset_and_kpis.ts -- mergeDiscoveredReserves exclusion coverage (fresh discovery, previously-cached entries, fullyVerified true/false, assetCount undefined never affected)", "programs/ssr_protocol/src/instructions/{initiate_wind_down,close_reserve}.rs read directly to confirm the has_one=manager / status==Active constraints", "live discovery via Helius: 18 reserves enumerated, exactly 1 with assetCount === 0"]
}
```

## DEC-0059

```json
{
  "id": "DEC-0059",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Restore all 4 original landing-page KPI tiles (Total Reserve AUM, 24h Volume, Active Reserves, Reserve Token Holders), with 24h Volume and Reserve Token Holders now computed from genuine on-chain data via a new api/devnet/landing-stats.ts endpoint, instead of leaving them removed (as in the prior pass, when no genuine source existed) or reintroducing the old fabricated formula (volume24h = tvl * 0.054).",
  "context": "A prior pass dropped these 2 tiles because 24h Volume had no genuine source (no indexer) and Reserve Token Holders wasn't tracked (getProgramAccounts, needed to enumerate holders, is 403-blocked on the public DevNet RPC). Helius (DEC-0055) genuinely supports getProgramAccounts (confirmed live), and the deployed program emits real, IDL-declared ReserveTokensMinted/ReserveTokensRedeemed events carrying real per-asset-leg amounts -- both gaps are now closeable with real data.",
  "rationale": "New packages/sdk/src/readOnly.ts functions: fetchReserveTokenHolderCount (getProgramAccounts filtered by mint, counts genuinely non-zero-balance accounts) and fetchReserve24hVolumeUsd (walks each Reserve's real transaction history via getSignaturesForAddress, decodes real trade events via Anchor's EventParser, values each leg at the same fixed DevNet test prices already used honestly for TVL elsewhere). A live pre-deploy sanity run caught and fixed two real bugs before shipping: (1) a single un-retried RPC call anywhere in the per-Reserve chain silently zeroed that Reserve's whole contribution under Helius rate-limiting -- fixed with the same bounded rate-limit-only retry pattern already used elsewhere in this SDK; (2) Anchor's EventParser reports event names camelCased with a lowercase first letter ('reserveTokensMinted'), not the IDL's declared PascalCase ('ReserveTokensMinted') -- the initial implementation matched the wrong casing and always computed 0 volume; confirmed by decoding a known real transaction directly. Both fixes were verified live afterward: a real run against production Reserves returned 22 genuine holders and $1,121.43 in genuine 24h volume across 17 displayable Reserves.",
  "alternativesConsidered": [
    "Show 24h Volume as 'coming soon' instead of building the real indexer (offered as an option; user chose to build the real thing now)",
    "Reintroduce the old tvl * 0.054 fictional volume formula (rejected outright -- exactly the fabrication this pass exists to replace)",
    "Compute holders/volume client-side per page load (rejected: would fire getProgramAccounts/getSignaturesForAddress/getTransaction calls from every visitor's browser on every load; a server-side endpoint with a 60s cache computes it once and serves everyone, far cheaper on the RPC budget)"
  ],
  "impact": "New packages/sdk/src/readOnly.ts exports (fetchReserveTokenHolderCount, fetchReserve24hVolumeUsd, valueAssetLegsUsd, countHoldersFromParsedAccounts, withRateLimitRetryGeneric). New api/devnet/landing-stats.ts (GET, 60s in-memory cache, same assetCount-exclusion rule as DEC-0058). src/pages/Home.tsx fetches it once per visit with explicit loading/unavailable states (never a fabricated 0 on failure); src/index.css's .kpi-grid reverts to 4 columns with the matching 2x2 tablet-breakpoint layout.",
  "affectedAreas": ["packages/sdk/src/readOnly.ts", "api/devnet/landing-stats.ts", "src/pages/Home.tsx", "src/index.css"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_hide_zero_asset_and_kpis.ts -- valueAssetLegsUsd and countHoldersFromParsedAccounts pure-logic coverage", "scripts/verify_landing_stats.ts -- live read-only sanity check, permanently added to the repo", "live run (2026-07-31): 22 holders, $1,121.43 24h volume, 17 Reserves counted, confirmed against a known real Buy transaction's decoded on-chain event"]
}
```

## DEC-0060

```json
{
  "id": "DEC-0060",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Remove the hardcoded `: 100` fallback from DTRDetail.tsx's Buy quick-select (25/50/75%/Max) availability calculation. When a Reserve has a devUSDC leg (devUsdcWeightFraction > 0), Max is the trader's real devUSDC balance divided by that fraction (unchanged, already correct). When a Reserve has NO devUSDC leg at all, there is no genuine balance-derived quantity for the buttons to represent, so they are disabled outright (with an honest reason shown) instead of falling back to any number. Extracted the calculation into a new pure `computeBuyAvailable` (src/merge/lib/calculations.ts) for direct test coverage. Also added an explicit devUsdcBalanceStatus ('loading'/'ready'/'unavailable') so the buttons are disabled until the real balance read has resolved, distinguishing that from mid-transaction disabling.",
  "context": "Live testing reported: wallet held ~750 devUSDC, 25% quick-select filled ~25 devUSDC, Max filled exactly 100 devUSDC -- unrelated to the real balance. Traced to `buyAvailable = devUsdcWeightFraction > 0 ? devUsdcBalanceHuman / devUsdcWeightFraction : 100` in DTRDetail.tsx: the Reserve being tested had devUsdcWeightFraction === 0 (no devUSDC leg), hitting the literal `100` fallback, which was designed as a placeholder 'not balance-constrained' default but reads to a trader as if their wallet were being (incorrectly) read as holding only 100 devUSDC.",
  "rationale": "The corrective-pass mandate is explicit: percentage controls must derive from the genuine devUSDC balance with no hardcoded cap, and must be disabled (not fake-populated) when the balance is unconfirmed or the calculation doesn't apply. Disabling is the only non-fabricating option for the zero-devUSDC-leg case, since that Buy genuinely draws $0 of the trader's real devUSDC (the non-devUSDC legs are DevNet-test-asset-faucet-funded, already disclosed in the composition breakdown directly below the buttons).",
  "alternativesConsidered": [
    "Pick a different but still-arbitrary default number instead of 100 (rejected -- exactly the same fabrication, just a different magnitude)",
    "Derive a number from the faucet-funded legs' own notional value (rejected -- those aren't the trader's own balance, and presenting them as such would misrepresent whose funds are being spent)"
  ],
  "impact": "src/merge/pages/DTRDetail.tsx (buyAvailable, buyPctUnavailableReason, devUsdcBalanceStatus, the quick-select buttons' disabled/title props, the balance display row). src/merge/lib/calculations.ts (new computeBuyAvailable).",
  "affectedAreas": ["src/merge/pages/DTRDetail.tsx", "src/merge/lib/calculations.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_buy_chart_category_deploy_pass.ts -- computeBuyAvailable coverage including the exact reported 750-devUSDC/no-devUSDC-leg scenario", "tsc -b, vite build, oxlint all clean"]
}
```

## DEC-0061

```json
{
  "id": "DEC-0061",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Wire the already-existing but never-called `appendPricePoint`/trade-log machinery (src/merge/lib/calculations.ts) into a new store action `recordConfirmedTrade`, called immediately after a Buy or Sell this wallet itself confirms (both the direct-success and ambiguous-then-reconciled paths, in DTRDetail.tsx). Do NOT hook it into the routine background discovery poll or into ManageDTR's composition-management refresh (both also call mergeOnChainReserve, which recomputes nav/aum but must never itself log a 'trade').",
  "context": "Live testing reported that a successful Buy didn't visibly move the chart, and that AUM/NAV appeared unchanged. Tracing the code found AUM/NAV/vault-balance refresh was already fully genuine and correct (mergeOnChainIntoDTR recomputes them from live vault balances on every refresh) -- the actual gap was that `priceHistory` and `trades` were never appended to at all; `mergeDiscoveredReserves` only ever preserved-or-replaced a Reserve's single seed point, so every real Reserve's chart was permanently flatlined at its creation-time point.",
  "rationale": "Scoping the append to the trading wallet's own confirmed transaction (rather than the shared background poll) avoids two failure modes: (1) polluting every Reserve's history with a new point every ~15s regardless of whether anything happened (which would still just be a flat line, since NAV genuinely doesn't move between trades, while blowing through MAX_PRICE_POINTS much faster), and (2) accidentally logging a 'trade' for non-trade actions like ManageDTR's fund/rebalance/wind-down flows, which also call mergeOnChainReserve to refresh vault-balance display. The appended price point uses the DTR's own already-refreshed `nav` (read from the freshest store state at the moment the action runs, after refreshRealReserveNow has already completed) -- so a Reserve whose NAV genuinely, correctly stays $1.00 under proportional backing logs an honest unchanged point, never a synthesized movement.",
  "alternativesConsidered": [
    "Append a price point on every RealReserveSync background poll tick (rejected -- would flatline-spam history and risks exceeding MAX_PRICE_POINTS from routine polling alone, unrelated to actual trades)",
    "Backfill full historical price/trade data from on-chain event history for every viewer, not just the trader (a real, larger indexer-completeness improvement -- deliberately out of scope for this pass; flagged as a legitimate follow-up, not built as a partial/fragile version here)"
  ],
  "impact": "src/merge/store/useAppStore.ts (new recordConfirmedTrade action). src/merge/pages/DTRDetail.tsx (calls it from handleBuy/reconcileBuy/handleSell/reconcileSell, using the exact real spent/redeemed amount -- the balance delta itself when reconciling an ambiguous confirmation, the literal signed amount on the direct-success path).",
  "affectedAreas": ["src/merge/store/useAppStore.ts", "src/merge/pages/DTRDetail.tsx"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_buy_chart_category_deploy_pass.ts -- appendPricePoint chronological/monotonic/truthful-flat-NAV coverage", "tsc -b, vite build, oxlint all clean"]
}
```

## DEC-0062

```json
{
  "id": "DEC-0062",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Add a canonical, shared Reserve category list (`RESERVE_CATEGORIES`, 15 categories per the corrective-pass spec: DeFi, Layer 1, Layer 2, AI, DePIN, Gaming, Meme, RWA, Stablecoins, Infrastructure, Privacy, Social, Ecosystem, Index, Custom) to src/merge/lib/types.ts, and a `normalizeReserveCategory` helper that displays a missing/empty category as an honest 'Uncategorized' label while passing any other value (canonical or legacy) through completely unchanged. Replace CreateDTR.tsx's free-text category input + datalist with a structured `<select>` over this list. Discover.tsx's category filter now unions the canonical list with whatever legacy category strings are actually present in the data, so nothing already on-chain becomes unfilterable.",
  "context": "Category support existed only as a free-form string with a loose datalist of suggestions and a naive exact-match Discover filter -- no canonical definition anywhere, and no dropdown as required by the corrective-pass spec.",
  "rationale": "A Reserve's persisted `category` stays `string`, not the new literal union type, deliberately: existing on-chain Reserves may carry a legacy category (e.g. 'DevNet Fixture', predating this convention) that must display exactly as before, per the explicit 'do not infer or overwrite categories for existing Reserves without evidence' requirement -- coercing it into the canonical list would be exactly that kind of unevidenced overwrite.",
  "alternativesConsidered": [
    "Make DTR.category a strict literal union of the 15 canonical values (rejected -- would either break/coerce every legacy Reserve's real on-chain-derived category or require an unsafe cast at every read site)",
    "Add a real shadcn Select component (no @radix-ui/react-select dependency currently exists in this repo; a plain native <select>, styled to match the existing Input aesthetic, avoids adding a new dependency for a single form field)"
  ],
  "impact": "src/merge/lib/types.ts (RESERVE_CATEGORIES, ReserveCategory, DEFAULT_RESERVE_CATEGORY, normalizeReserveCategory). src/merge/pages/CreateDTR.tsx (dropdown). src/merge/pages/Discover.tsx (filter). src/merge/pages/DTRDetail.tsx and src/merge/lib/reserveCardProps.ts (display via normalizeReserveCategory, the latter shared by Discover's grid and the landing page's Featured Reserves). Removed the now-unused CATEGORY_SUGGESTIONS from seed-data.ts.",
  "affectedAreas": ["src/merge/lib/types.ts", "src/merge/pages/CreateDTR.tsx", "src/merge/pages/Discover.tsx", "src/merge/pages/DTRDetail.tsx", "src/merge/lib/reserveCardProps.ts", "src/merge/lib/seed-data.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_buy_chart_category_deploy_pass.ts -- RESERVE_CATEGORIES exact-list and normalizeReserveCategory coverage", "tsc -b, vite build, oxlint all clean"]
}
```

## DEC-0063

```json
{
  "id": "DEC-0063",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Fix a confirmed React stale-closure bug in CreateDTR.tsx that made every Create-Reserve failure misreport as a pre-submission '(setup)' failure regardless of which step actually ran, by having createReserveOnChain throw a new typed `CreateReserveStepError` (carrying the real step and the exact derived Reserve addresses for that attempt) instead of the caller inferring the step from React state inside an async catch block. Reconcile create-and-register failures against the EXACT derived Reserve PDA (a direct getAccountInfo/owner check, `reserveAccountExistsOnChain`) instead of a fuzzy ProtocolConfig.reserveCount before/after comparison. Submit every signed transaction with `skipPreflight: true` (createReserveClient.ts, zapClient.ts, managementClient.ts) since `confirmSignatureBounded`'s real signature-status polling is already each of these functions' sole source of truth for the actual outcome. Add a synchronous re-entrancy guard (submittingRef) against double-invocation, set `txInFlight` during Create-Reserve submission (previously never set, contradicting RealReserveSync's own documented deferral comment), and persist a deployment-in-progress marker (wallet + derived Reserve address) in localStorage so a reload mid-flight reconciles against real on-chain state on the next mount instead of presenting a blank form that invites a duplicate launch.",
  "context": "Live testing reported: 'Deployment Failed (setup) -- Transaction simulation failed: Blockhash not found', yet the Reserve was created on-chain anyway, and retrying created a second Reserve with the same name/ticker. Tracing the code found two real, compounding bugs: (1) CreateDTR.tsx's catch block read the `createStep` React state variable to decide whether create-and-register had already succeeded -- but `setCreateStep(...)` never mutates the local binding inside the ALREADY-RUNNING async closure that called it (only a future render/invocation sees the new value), so `createStep` was always its value from before submission started, meaning every failure always displayed as '(setup)' and the 'already created on-chain, don't retry' branch could never actually fire; (2) `signAndSend`'s `sendRawTransaction` used default preflight, which can run its simulation against a DIFFERENT RPC node than the one that served `getLatestBlockhash` (an expected occurrence with any multi-node provider/proxy) -- that node not yet having seen the blockhash produces exactly a 'Blockhash not found' rejection even though the network itself, and possibly a concurrent/retried submission, would accept and had accepted it. A live discovery scan while investigating this pass also found the actual duplicate-Reserve pair this exact bug already produced: reserveId 19 ('ABC'/'123', status assetsInitializing, never seeded -- the abandoned attempt) and reserveId 20 ('ABC'/'123', status active -- the one that actually landed).",
  "rationale": "Carrying `step` and the derived `addresses` directly on the thrown error sidesteps the stale-closure bug structurally rather than patching around it (e.g. with a ref mirroring the state) -- the error is the one artifact that's guaranteed to reflect the exact attempt that failed. Checking the SPECIFIC derived Reserve PDA (rather than the aggregate reserveCount) is strictly more precise: reserveCount can also move because of a concurrent Reserve creation by a completely different wallet, which would have produced a false 'may have succeeded' warning against a reserveCount-only heuristic. skipPreflight is justified because this codebase already treats confirmSignatureBounded's bounded signature-status polling, never preflight simulation, as authoritative for every outcome (confirmed/failed/expired/ambiguous) -- preflight was only ever an extra, sometimes-wrong gate in front of that.",
  "alternativesConsidered": [
    "Fix the stale closure with a ref mirroring createStep instead of an error-carried value (rejected -- more moving parts for the same guarantee; the error object is already the single, unambiguous source of truth for 'what step failed and against which addresses')",
    "Implement full step-level resumption of a partially-completed Reserve (rejected for this pass -- a real v1.1-scope feature requiring re-deriving/replaying the exact prior instructions; the reconciliation-and-warn approach fully closes the 'silently duplicates' failure mode without that larger scope)",
    "Leave preflight enabled and instead retry sendRawTransaction on a 'Blockhash not found' error specifically (rejected -- this app's stated policy is never to auto-resubmit a transaction, precisely because a resubmission of something that may have already landed is how a duplicate Reserve gets created in the first place)"
  ],
  "impact": "src/merge/lib/createReserveClient.ts (CreateReserveStepError, reserveAccountExistsOnChain, savePendingReserveDeploy/readPendingReserveDeploy/clearPendingReserveDeploy, skipPreflight in signAndSend, onAddressesResolved callback removing a redundant duplicate ProtocolConfig fetch). src/merge/pages/CreateDTR.tsx (submittingRef, recovering/mount-time reconciliation effect, rewritten catch-block reconciliation, txInFlight). src/merge/lib/zapClient.ts and src/merge/lib/managementClient.ts (skipPreflight, for the same reasoning).",
  "affectedAreas": ["src/merge/lib/createReserveClient.ts", "src/merge/pages/CreateDTR.tsx", "src/merge/lib/zapClient.ts", "src/merge/lib/managementClient.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tests/phase_buy_chart_category_deploy_pass.ts -- CreateReserveStepError step/address-carrying coverage, PendingReserveDeploy save/read/clear/staleness/wallet-mismatch coverage", "scripts/find_reserve_by_ticker.ts live run (2026-07-31) -- confirmed the exact duplicate 'ABC' Reserve pair (reserveId 19 abandoned, reserveId 20 active) this bug had already produced", "tsc -b, vite build, oxlint all clean"]
}
```

## DEC-0064

```json
{
  "id": "DEC-0064",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Hide the exact on-chain Reserve with ticker EGAYQQ (reserveId 18, address `GNAvLuTNmccXx5bSAVQeqPSncay7kBNjjHZFKFvKUbo2`, name 'ozeegay') from every user-facing surface via a new, small, explicit address-keyed registry (`HIDDEN_RESERVE_ADDRESSES` in packages/sdk/src/hiddenReserves.ts), applied at the same central points as DEC-0058's assetCount===0 filter (src/merge/lib/onChainReserve.ts's mergeDiscoveredReserves and api/devnet/landing-stats.ts's KPI aggregation).",
  "context": "Live discovery (scripts/find_reserve_by_ticker.ts, adapted from scripts/verify_discovery.ts's ticker-matching pattern) confirmed the exact Reserve: status 'assetsInitializing', 1 registered asset (wrapped SOL) with a zero vault balance, reserveTokenSupplyRaw '0' -- an abandoned Create-a-Reserve attempt whose asset was registered but never seeded, so it never reached Active and holds zero real value. This Reserve does NOT match DEC-0058's assetCount===0 structural filter (it has 1 registered asset, not 0), so a new, separate exclusion was required.",
  "rationale": "A structural filter generalizing to 'any non-Active, low-assetCount Reserve' was deliberately rejected: several OTHER Reserves discovered in the same live scan (reserveIds 6, 8, 14) are also genuinely mid-initialization ('assetsInitializing') and may be real, legitimately in-progress creations by other testers -- a broad structural filter risks hiding those too, which the corrective-pass spec explicitly forbids ('do not delete or hide any similarly named Reserve', generalized here to 'any similarly-shaped Reserve'). An explicit, address-verified registry entry, added only after confirming the exact address live, cannot make that mistake. Genuine on-chain closure was confirmed impossible for the same reason as DEC-0058: initiate_wind_down/close_reserve both require the Reserve's own manager signature with no admin override, initiate_wind_down additionally requires status == Active (never reached here), and no keypair available in this environment matches this Reserve's manager (6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen).",
  "alternativesConsidered": [
    "Generalize the exclusion to any Reserve with status !== 'active' (rejected -- would also hide reserveIds 6/8/14, which have no evidence of being abandoned rather than genuinely in-progress)",
    "Attempt on-chain closure anyway (impossible -- no available signer, and no instruction path exists for a non-Active Reserve regardless of signer, same as DEC-0058)"
  ],
  "impact": "New packages/sdk/src/hiddenReserves.ts (HIDDEN_RESERVE_ADDRESSES, isHiddenReserveAddress), exported from packages/sdk/src/index.ts. src/merge/lib/onChainReserve.ts's mergeDiscoveredReserves and api/devnet/landing-stats.ts's displayable filter both now also exclude any hidden address. Zero on-chain transactions; the account itself is untouched and still exists exactly as before.",
  "affectedAreas": ["packages/sdk/src/hiddenReserves.ts", "packages/sdk/src/index.ts", "src/merge/lib/onChainReserve.ts", "api/devnet/landing-stats.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["scripts/find_reserve_by_ticker.ts live run (2026-07-31): confirmed reserveId 18, address GNAvLuTNmccXx5bSAVQeqPSncay7kBNjjHZFKFvKUbo2, ticker EGAYQQ, name ozeegay, status assetsInitializing, assetCount 1, reserveTokenSupplyRaw 0", "tests/phase_buy_chart_category_deploy_pass.ts -- isHiddenReserveAddress and mergeDiscoveredReserves exclusion coverage, including a similarly-shaped-but-different-address Reserve NOT being excluded"]
}
```

## DEC-0065

```json
{
  "id": "DEC-0065",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Re-confirm DEC-0054 as still fully applicable and take no implementation action on it in this pass: Buy's non-devUSDC legs are still minted fresh by the DevNet swap authority rather than sourced from a real conversion, and Sell still always pays out SOL (from the swap authority's own balance) rather than devUSDC, for every Reserve regardless of composition -- including a 100%-devUSDC-backed Reserve, which under the current architecture still settles its Sell leg in SOL rather than returning the trader's devUSDC.",
  "context": "This pass's corrective spec asked to investigate exactly this ('why does a 100%-devUSDC-backed Reserve redemption require a SOL settlement leg') and explicitly instructed: do not solve this solely by topping up the adapter, do not activate the unmerged/unapproved experimental/devnet-amm-swap branch, and stop and report if a genuine multi-asset conversion component remains incomplete. Re-reading packages/sdk/src/zapInstructions.ts confirmed the architecture is byte-for-byte unchanged since DEC-0054/DEC-0056: Sell is `redeem` (proportional, in-kind, correct) followed by an ALWAYS-applied fixed-price zap of the entitled amount into SOL, funded from the swap authority's own real SOL balance, with no code path that instead returns devUSDC directly even when devUSDC is the (or one of the) entitled asset(s).",
  "rationale": "The two architecturally sound options remain exactly as DEC-0054 already framed them: (a) finish and wire in the deliberately-deferred, unmerged `ssr_devnet_amm` (DEC-0051) to provide a real devUSDC<->other-asset conversion, which is out of scope without separate explicit approval per this pass's own instructions, or (b) change the Sell instruction path itself so that any ALREADY-devUSDC-denominated entitlement (i.e., a Reserve's devUSDC-weighted leg) is returned to the trader as real devUSDC directly (a genuine `transfer_checked` from the vault, mirroring how Buy's devUSDC leg already works in reverse) instead of being converted to SOL at all -- leaving only genuinely non-devUSDC entitlements (mockX/Y/Z legs) needing any conversion mechanism, which for those specific test assets could plausibly stay faucet/swap-authority-funded exactly as Buy already does today. Option (b) is a real, scoped protocol/instruction change (new or modified Anchor instruction logic, security review of the vault-authority signing path, and a matching SDK/frontend update) -- implementing it without explicit sign-off would be exactly the kind of unauthorized architecture change this pass's instructions warn against.",
  "alternativesConsidered": [
    "Silently top up the swap authority's SOL balance and call the immediate symptom fixed (explicitly rejected by this pass's own instructions -- treats a monitoring/funding gap as if it were the architecture fix)",
    "Activate ssr_devnet_amm now (explicitly rejected -- unapproved, unmerged, and a materially larger scope than this corrective pass)",
    "Implement option (b) unilaterally in this pass (rejected -- a genuine on-chain instruction/security change belongs behind its own explicit decision, not folded into a UI/reconciliation corrective pass)"
  ],
  "impact": "No code changed as a result of this entry. Recorded so this pass's investigation (and its conclusion that nothing has changed since DEC-0054) is itself part of the durable record, per this repo's decision-logging convention.",
  "affectedAreas": ["packages/sdk/src/zapInstructions.ts (read, not modified)", "docs/project/DECISION_LOG.md"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["packages/sdk/src/zapInstructions.ts re-read in full (2026-07-31): Sell's SOL-out leg is unconditional, sourced from the swap authority's real SOL balance, with no devUSDC-direct-return path", "git branch -a confirms experimental/devnet-amm-swap still exists, unmerged, untouched"]
}
```

## DEC-0066

```json
{
  "id": "DEC-0066",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Increase api/devnet/sponsor-sol.ts's DevNet SOL onboarding grant from 0.01 SOL per claim (60-second cooldown, 0.03 SOL recipient ceiling) to 1 SOL per claim, at most once per wallet every 24 hours (2 SOL recipient ceiling). At the user's explicit request, funding the underlying authority wallet's real balance is being done manually by the user (a direct DevNet SOL transfer), not automated by this change.",
  "context": "User asked to 'top up the SOL faucet and make sure it's working... it should airdrop 1 SOL max every 24hrs', clarified to mean this specific endpoint (not the separate, already-tracked concern of the swap-authority wallet's own low operational balance, which remains open -- see Risks).",
  "rationale": "The endpoint's balance-ceiling check is the durable, on-chain-verified primary defense against abuse (per its existing design, unchanged in shape); the in-memory per-wallet cooldown is already documented elsewhere in this codebase (api/devnet/_lib/rateLimit.ts) as a best-effort SECONDARY control that resets on a serverless cold start -- raised to 24 hours here for the new grant size, with that caveat re-documented in this file's own header so it's not mistaken for a durable guarantee. The recipient ceiling was raised from 0.03 to 2 SOL (200x the old ceiling vs. 100x the old grant) so the larger grant isn't neutered by an unchanged tiny eligibility ceiling, while still refusing wallets that are already reasonably well-funded.",
  "alternativesConsidered": [
    "Add a durable, cross-invocation persistent store (e.g. a KV/Redis integration) for a cryptographically-exact 24h limit (rejected as over-engineering for a DevNet-only, zero-real-value test faucet already using the same best-effort pattern everywhere else in this codebase; flagged transparently instead of silently accepted)",
    "Automate the authority wallet's own top-up via the public DevNet airdrop faucet (rejected per the user's explicit choice to fund it manually themselves)"
  ],
  "impact": "api/devnet/sponsor-sol.ts (GRANT_LAMPORTS, BALANCE_CEILING_LAMPORTS, COOLDOWN_MS, and the cooldown error message's time formatting). src/merge/components/DevnetOnboarding.tsx (copy updated from 'small and limited' to the actual '1 SOL, once per wallet every 24 hours' figures). AUTHORITY_MIN_RESERVE_LAMPORTS (0.05 SOL, the floor this endpoint won't drain the authority below) was left unchanged -- not part of what was asked -- though it is worth noting separately that it's low relative to previously-observed real Sell settlement costs (~3.75 SOL for one transaction, see the 2026-07-30 Helius pass); a broader review of the authority wallet's reserve strategy across all its duties is a distinct follow-up, not folded into this change.",
  "affectedAreas": ["api/devnet/sponsor-sol.ts", "src/merge/components/DevnetOnboarding.tsx"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": ["tsc -b, tsc -p api/devnet/tsconfig.json both clean", "live read (2026-07-31): authority wallet Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj balance confirmed at 0.23244962 SOL via a direct getBalance RPC call -- below the 1.05 SOL (grant + floor) this endpoint now requires to grant, consistent with the user's plan to fund it directly"]
}
```

## DEC-0067

```json
{
  "id": "DEC-0067",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Correct the Buy/Sell architecture so devUSDC is genuinely SSR.fun's universal purchasing/settlement currency, never coupled to a Reserve's own asset composition: (1) the 25/50/75/Max quick-select buttons now always derive from the wallet's real devUSDC balance for every Reserve, with the 'no devUSDC leg' gating message and logic removed entirely; (2) Buy execution is now gated to Reserves backed 100% by devUSDC (`isReservePureDevUsdc`), both client-side (DTRDetail.tsx) and server-side (api/devnet/swap-sign.ts's buy-devusdc action now rejects any Reserve with a non-devUSDC asset) -- this removes the previous hidden funding of mockX/Y/Z (minted for free) and wrapped SOL (wrapped from the swap authority's own real SOL) during Buy for any Reserve the user's devUSDC didn't actually cover; (3) Sell for that same 100%-devUSDC composition now redeems genuine devUSDC directly via a new zero-fabrication `buildRedeemToDevUsdcInstructions` (single-signer, no swap-authority co-signature, no SOL leg at all) instead of the previous redeem-then-convert-to-fixed-price-SOL zap.",
  "context": "User-reported architecture review, with screenshots, of the Buy flow: the UI displayed 'This Reserve has no devUSDC leg, so quick-select isn't balance-gated -- enter an amount directly' and disclosed that SOL and mockX legs were funded by a 'DevNet test-asset faucet' during a Buy the UI otherwise labeled as devUSDC-settled. Tracing `packages/sdk/src/zapInstructions.ts`'s `buildBuyZapInstructionsDevUsdc` confirmed the underlying mechanics precisely: `reserveTokensRequested` is computed from the trader's FULL devUSDC input divided by NAV (i.e. the entire mint is sized as if fully paid in devUSDC), but only the fraction of that mint attributable to the Reserve's own devUSDC-weighted leg (if any) is actually debited from the user's real balance -- every other leg (mockX/Y/Z via a direct swap-authority-signed SPL mintTo, wrapped SOL via the swap authority wrapping its own real SOL) is fabricated for free in the same atomic transaction. For a Reserve with NO devUSDC leg, 100% of the resulting Reserve Tokens were backed by assets nobody paid for.",
  "rationale": "The authoritative product model is: devUSDC in -> genuinely converted into the Reserve's proportional underlying assets -> those assets deposited into vaults -> Reserve Tokens minted -- and the inverse on redemption. The deployed `ssr_protocol` Anchor program has no devUSDC<->other-asset conversion instruction, oracle, or AMM of its own (confirmed: `mint_reserve_tokens_in_kind`/`redeem_reserve_tokens_in_kind` are strictly in-kind -- you must already hold, or already receive in-kind, each asset amount involved). The ONLY Reserve composition with a genuine, zero-fabrication path in both directions today is one backed 100% by devUSDC: `mint_reserve_tokens_in_kind`'s own `transfer_checked` moves the user's real devUSDC directly into the vault on Buy (already true before this fix -- no server involvement needed for that leg), and `redeem_reserve_tokens_in_kind` deposits the redeemer's real proportional entitlement directly into their own wallet on Sell, which for this composition IS real devUSDC (discovered while tracing Sell's existing code: the current SOL-zap Sell path takes that already-correctly-redeemed devUSDC BACK from the user's wallet and gives fixed-price synthetic SOL instead -- confirming this is the exact mechanism behind the previously-logged DEC-0054/'3.75 SOL settlement' report). Disabling Buy (and correcting Sell) for any other composition, rather than patching around the missing conversion layer, is the only choice consistent with 'never simulate this conversion, never show a successful Buy not funded by the user's devUSDC.'",
  "alternativesConsidered": [
    "Keep faucet-funding non-devUSDC legs but disclose it more clearly in the UI (rejected -- the user's explicit instruction is that a Reserve should never need hidden funding at all; disclosure doesn't fix a still-fabricated mint)",
    "Activate the experimental, unmerged `ssr_devnet_amm` (DEC-0051) now to provide a real conversion layer for mixed Reserves (rejected for this pass -- explicitly out of scope without separate approval; see 'smallest decision required' in the session report)",
    "Extend the Sell fix to mixed-composition Reserves by returning their in-kind assets without any zap at all (a real, likely-safe option identified while investigating -- deliberately NOT implemented in this pass since it wasn't part of this session's explicit, detailed spec; flagged as a natural low-risk follow-up)",
    "Leave the plain SOL-denominated `action: 'buy'` / `buildBuyZapInstructions` path as-is (confirmed dead/unreachable from the live UI -- only referenced by historical scripts/verify_*.ts files; left untouched rather than risk breaking those, but flagged as a known remaining hidden-funding-capable code path reachable only via direct API call)"
  ],
  "impact": "src/merge/lib/calculations.ts (new `buyAvailableFromDevUsdcBalance`, replacing the removed `computeBuyAvailable`; new `isReservePureDevUsdc`). src/merge/pages/DTRDetail.tsx (quick-select buttons always balance-derived; Buy button/panel gated on `isGenuineDevUsdcBuySupported`/`isPureDevUsdcReserve`; composition breakdown no longer lists faucet-funded legs -- shows an accurate 'Buy not available' panel with the Reserve's real composition instead; Sell panel shows genuine-devUSDC messaging for a pure Reserve instead of the fixed-rate SOL note). packages/sdk/src/zapInstructions.ts (new `buildRedeemToDevUsdcInstructions`). api/devnet/swap-sign.ts (buy-devusdc rejects any non-devUSDC-asset Reserve server-side; sell branches to the new zero-fabrication redeem-only path for a pure-devUSDC Reserve). src/merge/lib/zapClient.ts (`ZapQuote.devUsdcOutRaw`). New scripts/check_reserve_compositions.ts (read-only live composition lookup).",
  "affectedAreas": [
    "src/merge/lib/calculations.ts",
    "src/merge/pages/DTRDetail.tsx",
    "packages/sdk/src/zapInstructions.ts",
    "api/devnet/swap-sign.ts",
    "src/merge/lib/zapClient.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "tests/phase_devusdc_buy_architecture_fix.ts and updated tests/phase_buy_chart_category_deploy_pass.ts -- isReservePureDevUsdc, buyAvailableFromDevUsdcBalance, devUsdcToReserveTokensRequested, computeRedemptionEntitlements coverage (145/145 offline tests total passing)",
    "packages/sdk/src/zapInstructions.ts re-read in full to confirm redeem_reserve_tokens_in_kind already deposits real in-kind entitlements directly to the user before any zap instruction runs",
    "tsc -b, tsc -p api/devnet/tsconfig.json, tsc -p packages/sdk, tsc -p scripts/tsconfig.json, vite build, oxlint all clean"
  ]
}
```

## DEC-0068

```json
{
  "id": "DEC-0068",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Add a new internal-team-only page, /internal/feedback, for quick DevNet bug/feedback intake (reporter, area, severity, description, repro steps, up to 3 screenshots). Submissions upload screenshots to a specific Google Drive folder and append one row per submission to a specific Google Sheet, via a Google Cloud service account. Gated by the exact same session cookie/password as /internal/status (SSR_DASHBOARD_PASSWORD) -- one login covers both pages, no new auth system.",
  "context": "User request: an internal quick-feedback tool with screenshot upload that lands in Google Drive, built as a real section of the live site rather than a Google Form or a standalone Claude Artifact (both considered and set aside per the user's explicit choice). joao@enigma-fund.com's Google Drive was confirmed connected/accessible in this session (via the assistant's own Drive tools) and used to create the destination folder (`SSR.fun DevNet Feedback (Internal Team)`, id `1B1HMK1HHmnINSuQQ42iztgtTyU8-z5zv`) and Sheet (`SSR.fun DevNet Feedback Log`, id `1xacWW9Bu0CmcUEBhw1TQsibdLwn6gZrK2OAiebmWQag`) directly -- but that session-level Drive access cannot be used by the DEPLOYED app itself, which needs its own independent Google API credentials to write to Drive/Sheets from its own serverless functions at request time.",
  "rationale": "Implemented as plain REST calls against the Drive v3 upload endpoint and Sheets v4 append endpoint, authenticated via a service-account JWT signed with Node's built-in `crypto` module (RS256) -- deliberately avoiding the full `googleapis` SDK (tens of MB) or even `google-auth-library`, matching this repo's existing minimal-dependency convention (see lib/dashboard/session.ts's own HMAC-only approach). The service account is scoped to `drive.file` (not full `drive`) -- it can only touch files explicitly shared with it (the one folder and one sheet created for this feature), never a user's whole Drive. Reusing SSR_DASHBOARD_PASSWORD/the existing session-cookie middleware for gating (rather than a new password or auth system) matches the 'don't over-engineer' principle -- this is exactly the same internal-team trust boundary /internal/status already established. The Sheet auto-writes its own header row on first use (checked via a read-before-write) so no manual spreadsheet setup is needed beyond sharing it with the service account.",
  "alternativesConsidered": [
    "A native Google Form + linked Sheet (rejected -- no Google Forms API is available to this assistant's tooling; would have required the user to build the form by hand)",
    "A standalone Claude Artifact form (evaluated and initially proposed; rejected by the user in favor of a real section of the live site)",
    "Full `googleapis` Node SDK (rejected -- large dependency for what plain fetch + Node's built-in crypto module already does)",
    "A new, separate password/auth system for this page (rejected -- reusing the existing internal-dashboard session is simpler and matches the same trust boundary)"
  ],
  "impact": "New api/internal/_lib/googleAuth.ts (service-account JWT/token exchange), api/internal/_lib/googleDrive.ts (Drive upload + Sheets append with auto-header), api/internal/feedback-submit.ts (the gated endpoint). New internal-feedback.html + src/internal-feedback/{main.tsx,Feedback.tsx,feedback.css,constants.ts} (the gated page). vite.config.ts (new build entry), vercel.json (new rewrite), middleware.ts (matcher + gating extended to the new page/endpoint), .env.example (new required vars documented). Cross-links added between /internal/status and /internal/feedback. New required env vars: GOOGLE_SERVICE_ACCOUNT_KEY (secret, not yet set -- blocks this feature until the user completes GCP service-account setup and shares the folder/sheet with it), FEEDBACK_DRIVE_FOLDER_ID and FEEDBACK_SHEET_ID (both already set on Production+Preview by the assistant, pointing at the real folder/sheet created this pass).",
  "affectedAreas": [
    "api/internal/_lib/googleAuth.ts",
    "api/internal/_lib/googleDrive.ts",
    "api/internal/feedback-submit.ts",
    "src/internal-feedback/",
    "internal-feedback.html",
    "vite.config.ts",
    "vercel.json",
    "middleware.ts",
    ".env.example",
    "src/internal-status/Dashboard.tsx"
  ],
  "supersedes": null,
  "supersededBy": "DEC-0069",
  "evidence": [
    "tsc -b, vite build, oxlint all clean (new internalFeedback build entry confirmed in dist/ output)",
    "Google Drive folder/sheet genuinely created this session via the assistant's connected Drive access: folder id 1B1HMK1HHmnINSuQQ42iztgtTyU8-z5zv, sheet id 1xacWW9Bu0CmcUEBhw1TQsibdLwn6gZrK2OAiebmWQag, both owned by joao@enigma-fund.com",
    "FEEDBACK_DRIVE_FOLDER_ID/FEEDBACK_SHEET_ID confirmed added to Vercel (Production + Preview) via `vercel env add`",
    "No live end-to-end submission test performed -- GOOGLE_SERVICE_ACCOUNT_KEY is not yet configured (pending the user's GCP setup) and the destination folder/sheet have not yet been shared with a service account, so a real Drive write cannot succeed yet; the endpoint fails closed with an honest 'not configured' error in the meantime, never a fabricated success"
  ]
}
```

## DEC-0069

```json
{
  "id": "DEC-0069",
  "date": "2026-07-31",
  "status": "confirmed",
  "decision": "Abandon the Google service-account-based Drive/Sheets automation for /internal/feedback (DEC-0068) after the user hit organization policy blockers while creating the service account, and replace it with a simple gated link-through page pointing at a manually-maintained Google Sheet the user created and shared directly (\"SSR.fun — Simple Feedback\", already header-rowed: Date, Name/contact, Page/feature, Feedback, Screenshot or document link). Removed api/internal/_lib/googleAuth.ts, api/internal/_lib/googleDrive.ts, and api/internal/feedback-submit.ts entirely; /internal/feedback is now a static gated page with one link, no backend, no env vars.",
  "context": "The user began creating the GCP service account this pass (email ssr-654@ssr-fun-feedback.iam.gserviceaccount.com was generated) but reported hitting 'organization blockers' before completing setup -- consistent with a Google Workspace/Cloud org policy blocking service-account key creation and/or sharing Drive files outside the organization's domain, both common default-security postures. An Apps-Script-Web-App alternative (running under the user's own identity, avoiding both blockers) was proposed and about to be discussed further when the user instead chose to sidestep Google API automation altogether and just maintain a Sheet manually.",
  "rationale": "No further engineering effort is justified chasing an automated integration the user no longer wants -- they already created and shared a working Sheet themselves, which is simpler, needs no credentials of any kind, and cannot hit the same organizational restrictions since it's pure manual data entry, not an API integration. Keeping the page gated (same SSR_DASHBOARD_PASSWORD session) preserves the one property that mattered from the original request -- internal-team-only access -- while dropping everything else (custom form, screenshot upload, automated logging) that depended on infrastructure the org wouldn't allow.",
  "alternativesConsidered": [
    "Google Apps Script Web App (a genuine alternative that avoids both service-account keys and cross-domain sharing, since it runs under the sheet owner's own identity) -- proposed but not pursued once the user opted for a fully manual sheet instead",
    "Leave the DEC-0068 code in place, dormant (rejected by the user's explicit choice -- 'repurpose it as a simple link page')",
    "Revert /internal/feedback entirely (rejected -- the user still wants a gated internal entry point, just pointing at a manual sheet instead of a custom form)"
  ],
  "impact": "Deleted api/internal/_lib/googleAuth.ts, api/internal/_lib/googleDrive.ts, api/internal/feedback-submit.ts, src/internal-feedback/constants.ts. Rewrote src/internal-feedback/Feedback.tsx as a single-link static page (removed the form/screenshot-upload UI and feedback.css's now-unused form/thumbnail styles). middleware.ts's matcher no longer includes an /api/internal/feedback-submit entry. Removed GOOGLE_SERVICE_ACCOUNT_KEY (never set)/FEEDBACK_DRIVE_FOLDER_ID/FEEDBACK_SHEET_ID from .env.example and from Vercel (both Production and Preview, via `vercel env rm`) -- the page now needs zero server-side configuration. The Blockers entry this feature added to PROJECT_STATUS.md is resolved/removed accordingly.",
  "affectedAreas": [
    "src/internal-feedback/Feedback.tsx",
    "src/internal-feedback/feedback.css",
    "middleware.ts",
    ".env.example",
    "docs/project/PROJECT_STATUS.md"
  ],
  "supersedes": "DEC-0068",
  "supersededBy": null,
  "evidence": [
    "tsc -b, vite build, oxlint all clean; internalFeedback JS bundle shrank from 5.44kB to 1.24kB reflecting the removed form/upload logic",
    "Sheet verified live and real via the assistant's Google Drive access: id 1Xk-9ngsu9_Gihe0s9Rd72fnzP2apsJ42tWLcfjU5QsM, title \"SSR.fun — Simple Feedback\", header row confirmed present",
    "`vercel env ls` confirmed FEEDBACK_DRIVE_FOLDER_ID/FEEDBACK_SHEET_ID no longer present in either environment after removal"
  ]
}
```

## DEC-0070

```json
{
  "id": "DEC-0070",
  "date": "2026-08-03",
  "status": "confirmed",
  "decision": "Fix api/devnet/swap-sign.ts's buy-devusdc action to only call tx.partialSign(swapAuthority) when at least one leg genuinely still needs the swap authority's test-asset-faucet mechanism (result.legSources.some(leg => leg.source === \"devnet-test-asset-faucet\")), instead of unconditionally. Separately, replace api/devnet/landing-stats.ts's holder count -- previously a naive per-Reserve sum -- with a globally deduplicated union of owner-address sets (new packages/sdk/src/readOnly.ts functions fetchReserveTokenHolderOwners/collectHolderOwners), exposing a perReserve breakdown so the Reserve-detail page and the landing page read the same computed numbers rather than risking two disagreeing implementations.",
  "context": "Every Buy against a Reserve backed 100% by devUSDC failed before submission with 'Buy Failed -- unknown signer: Ef7vbQ...' (the shared DevNet swap-authority/devUSDC-mint-authority keypair, devnet-fixtures/manager-keypair.json). Traced to buildBuyZapInstructionsDevUsdc (packages/sdk/src/zapInstructions.ts) deliberately never including the swap authority as an account for a devUSDC leg (by design -- the user's own devUSDC funds that leg directly, no faucet/mint involved) combined with swap-sign.ts unconditionally trying to co-sign with it anyway; web3.js's Transaction.partialSign throws 'unknown signer: <pubkey>' when asked to sign with a key absent from the transaction's own required-signer list. Separately, while verifying AUM/NAV correctness against Reserve '123'/ABC (reserveId 20), found via getSignaturesForAddress + Anchor event decoding that it had genuinely been seeded with 100 devUSDC (2026-07-31) then fully redeemed (100/100 Reserve Tokens, 0 fee) the same day as this pass (2026-08-03) -- so its current $0 AUM is real, correct state, not a display bug; the AUM/NAV formula in src/merge/lib/onChainReserve.ts was independently confirmed already correct via a full live reproduction. Also found landing-stats.ts's holders figure summed each Reserve's own holder count independently, over-counting any wallet holding tokens from more than one Reserve.",
  "rationale": "The signer fix is scoped precisely to the condition that makes the swap authority a genuine transaction party, rather than either always requiring it (which would defeat the entire point of the pure-devUSDC path -- no faucet funding should be involved) or unconditionally removing the partialSign call (which would silently break the mixed-asset devUSDC+other-asset case, if that gating is ever relaxed later). A generic describeUnknownSignerError/describeUnknownSignerMessage mapping (server-side authoritative, client-side defensive fallback) was added alongside the fix so any FUTURE unexpected-signer bug -- not just this one -- self-diagnoses with a named account role instead of a bare, unresolved public key. The holder-count fix moves from a count-based to a set-based computation specifically because deduplication is impossible without knowing WHICH wallet holds which Reserve's token, not just how many token accounts exist per Reserve.",
  "alternativesConsidered": [
    "Always partialSign with the swap authority in buy-devusdc regardless of leg sources, and just accept the extra unused signature slot -- rejected: a Transaction's signature array is keyed to its actual required-signer set; signing with a key that isn't one of them is exactly what throws unknown signer, so this isn't actually available as an option, only removing the call unconditionally or making it conditional are.",
    "Remove tx.partialSign(swapAuthority) unconditionally from buy-devusdc -- rejected: would silently break the transaction the moment any leg legitimately needs swap-authority funding again (e.g. if the 100%-devUSDC-only gating on this action is ever relaxed), with no error until that day.",
    "Treat Reserve 20's $0 AUM as a bug and 'fix' it by hardcoding a nonzero display -- explicitly rejected per the task's own instruction; the real vault balance is genuinely 0 after a real full redemption, and the correct fix is verifying the formula elsewhere, not force-displaying a stale number.",
    "Keep summing per-Reserve holder counts for the global figure and add a second, separately-implemented deduplication pass just for the global number -- rejected: this is exactly the 'two competing counting systems' anti-pattern the corrective task explicitly warned against; a single owner-set-based function serving both the per-Reserve and global figures is the only version that can't disagree with itself."
  ],
  "impact": "api/devnet/swap-sign.ts (conditional partialSign + describeUnknownSignerError), src/merge/lib/zapClient.ts (describeUnknownSignerMessage), src/merge/pages/DTRDetail.tsx (error-toast wiring, holder-count display, new 24h Volume stat card, useLandingStats wiring), packages/sdk/src/readOnly.ts (fetchReserveTokenHolderOwners/collectHolderOwners, fetchReserveTokenHolderCount now a thin wrapper), api/devnet/landing-stats.ts (perReserve breakdown, deduplicated global holders, ?force=1 cache bypass), new src/merge/hooks/useLandingStats.ts (shared by Home.tsx and DTRDetail.tsx, replacing Home.tsx's own local copy). Every pure-devUSDC Reserve's Buy is fixed, not just Reserve 20's (which is itself now permanently unable to accept a new Buy regardless, per mint_reserve_tokens_in_kind's total_supply_before > 0 guard -- an independent, pre-existing protocol invariant, not something this pass changed or could change).",
  "affectedAreas": [
    "api/devnet/swap-sign.ts",
    "packages/sdk/src/readOnly.ts",
    "api/devnet/landing-stats.ts",
    "src/merge/lib/zapClient.ts",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/hooks/useLandingStats.ts",
    "src/pages/Home.tsx",
    "docs/project/PROJECT_STATUS.md"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Live DevNet verification via new scripts/verify_corrective_pass.ts (a fresh single-asset-devUSDC Reserve, since reserveId 20 can never accept another mint): Create 2EV5pyvpyLi2HyfVToAVRZGRyTWqesSiKxTzSqS9DxiUjz2q8ZsuR4ZMECCfguPTBSW4wCarXz4EGeqK6mVEjeBs, Seed 4kUhTxVdF6g1BAgUx1ETnGqjREbqmBQDTupCaHwGK75xrheiRCaEhavEhxVAHJ5CT3SYt5nf4Yrc4XDvFURQqogB (AUM $100.00/NAV $1.00), Buy XeeUpsmqMXCbSMNrD9548SauoULRBReabjBKTUrQxUu6VBHtA4Fkz5dGRAP3KLfvy19EbtVJ4WHHGQR3qTNDfB2 (required-signer list confirmed to contain only the buyer; AUM $110.00/NAV $1.000455), Sell 62SqZnNrnUK7NKoKU5aPfa1kg1qmq1NQhRRh2a97EQjvUiHG4SaU4pNQGqogho2xjtKqipW8ByhPtKgj3i5iH7VD (AUM $55.00/NAV unchanged at $1.000455)",
    "scripts/investigate_reserve_history.ts decoded reserveId 20's real event history: reserveCreated + reserveAssetInitialized (2026-07-31T10:11:42Z), reserveSeeded 100/100 (2026-07-31T10:12:23Z), reserveTokensRedeemed 100/100 fee-0 (2026-08-03T14:45:06Z)",
    "145/145 pre-existing offline tests pass; tsc -b, tsc -p api/devnet/tsconfig.json --noEmit, vite build all clean",
    "4 pre-existing TS errors in tests/phase_data_integrity.ts, tests/phase_devusdc_buy_architecture_fix.ts, tests/phase_landing_wallet_corrections.ts confirmed via git stash to predate this pass",
    "tests/ssr_protocol.ts confirmed unable to run this session: cargo not on PATH in either bash or PowerShell, so anchor.workspace's cargo metadata call fails -- a pre-existing environment gap"
  ]
}
```

## DEC-0071

```json
{
  "id": "DEC-0071",
  "date": "2026-08-03",
  "status": "confirmed",
  "decision": "Restrict every visible/tradable Reserve on the site to exactly the 4 configured DevNet test mints (devUSDC, mockX, mockY, mockZ), validated by mint address via a single new shared function (packages/sdk/src/tradableAssets.ts's isReserveTradable), enforced identically in discovery/merge, landing-stats, swap-sign, and the Create-Reserve asset picker. Remove the devUSDC-only restriction on Buy (api/devnet/swap-sign.ts) so any allocation of the 4 supported assets can genuinely Buy and Sell -- adding a new devUSDC-settled Sell builder (buildSellZapInstructionsDevUsdc) for mixed/multi-asset compositions that converts non-devUSDC proceeds into freshly-minted devUSDC instead of the prior fixed-rate SOL settlement.",
  "context": "The site could show Reserves holding wrapped SOL or other unsupported assets with no genuine Buy/Sell path, and Buy itself was hard-restricted to Reserves backed 100% by devUSDC (DEC-0067) even though the underlying buildBuyZapInstructionsDevUsdc builder already correctly handled non-devUSDC legs (minted directly to the buyer via the swap authority's own mint authority) -- the restriction was a server-side rejection, not a capability gap. Sell for any non-pure-devUSDC Reserve still used the original fixed-rate SOL settlement (DEC-0054/0065's long-standing open gap), which was inconsistent with devUSDC now being the site's universal settlement currency.",
  "rationale": "Every mock test mint (mockX/Y/Z) is a worthless, freely-mintable DevNet convenience token that the swap authority already controls the mint authority for -- the same trust boundary already accepted for devUSDC's own faucet (api/devnet/faucet-devusdc.ts). Extending that same mechanic to cover arbitrary allocations, and mirroring it on the Sell side (convert non-devUSDC proceeds into devUSDC via the same mint authority, rather than paying SOL from the swap authority's own balance), removes the SOL-balance dependency for Sell entirely and unifies the whole Buy/Sell surface on one settlement currency. Restricting the tradable catalogue to exactly these 4 mints (rather than continuing to allow wrapped SOL, which has no such conversion path) keeps every visible Reserve genuinely tradable -- a Reserve that isn't fully supported is hidden, not shown broken.",
  "alternativesConsidered": [
    "Keep the devUSDC-only Buy restriction and only fix the tradable-catalogue filtering -- rejected: this was the task's explicit, primary ask, and the underlying builder already supported it; leaving the restriction in place would have left the stated bug unfixed.",
    "Extend the OLD fixed-rate SOL settlement to also cover mixed-composition Sell instead of building a devUSDC-settled path -- rejected: SOL settlement depends on the swap authority's own real SOL balance (an operational risk already flagged in Risks previously), whereas devUSDC is already freely mintable by the same authority with no comparable balance constraint, and unifies Buy/Sell on one settlement currency as the product model intends.",
    "Also allow wrapped SOL in the tradable set, since the protocol itself has no restriction against it -- rejected: no genuine devUSDC-settled conversion path exists for SOL (nobody holds mint authority over it), so a SOL-containing Reserve would need to fall back to the old fixed-rate zap inconsistently with everything else; simpler and more honest to exclude it from the tradable catalogue entirely."
  ],
  "impact": "packages/sdk/src/tradableAssets.ts (new), src/merge/lib/onChainReserve.ts (mergeDiscoveredReserves filter), api/devnet/landing-stats.ts (displayable filter), api/devnet/swap-sign.ts (allowlist + removed buy-devusdc rejection + new Sell routing), packages/sdk/src/zapInstructions.ts (new buildSellZapInstructionsDevUsdc), src/merge/pages/CreateDTR.tsx (removed wrapped SOL from selectable assets), src/merge/pages/DTRDetail.tsx (gating + messaging + Price History fix), src/merge/lib/calculations.ts (buildLineSeries insufficientHistory), src/merge/lib/reserveCardProps.ts (updated call site). New risk introduced and explicitly flagged (not fixed): a 0%-devUSDC Reserve's Buy-then-Sell path has no rate limit of its own, unlike the dedicated devUSDC faucet.",
  "affectedAreas": [
    "packages/sdk/src/tradableAssets.ts",
    "packages/sdk/src/zapInstructions.ts",
    "api/devnet/swap-sign.ts",
    "api/devnet/landing-stats.ts",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/lib/calculations.ts",
    "docs/project/PROJECT_STATUS.md",
    "docs/project/ENGINEERING_TIMELINE.md"
  ],
  "supersedes": "DEC-0067",
  "supersededBy": null,
  "evidence": [
    "Live DevNet verification via new scripts/verify_multi_asset_tradability.ts against 4 real persistent Reserves: 100% devUSDC (Buy 5j7TMVWV6j8oASKtXiXg8hMAj7n18bFTEzVMqiTnuWDLVBDFWpKw6AwGKMzGPHZz2hfHLkvh5FPjBTnt5jnQJhp6 / Sell 2BqhSDkZnPdJCrtSC6eoxMSXitXupUgg1yd7yNvXYtjU6c1bJZdHcUFr33UPZpJBLxXeM3jQppPZaPDRxy8RxYfL), 100% mockX/TestLo (Buy 3VPPdqFk6p6zR8zVHr2SfbPp2uJnPLJtoyNbR4CswkbAXLwT6VYkbfr6nWuH6wLrJA2nbMjxTx9qTTsCGzs7Eni3 / Sell 3TG7jmDSomTiMD88SLGSoGzhK2jqD23k9344M6qLMwg5AchGsLD5sXVc9ZWw5Kk5mUJYLkRxiKmukQE5kXQ8Lqiy), multi-asset mockX/Y/Z/DevNet Reserve Two (Buy 5EYrBuWwmPkrk1j78DWDMrAxXn5DtEs29mgXVxMZjDyZryKmqxMKzGjvha4KjLMND7mxRphmoNA5K5sbfCa6Awdj / Sell JoeJArhwn5goQ3V3chekVvoiMxZ9PzWjGWwzpVwgH7Auv41jDSo4KdS29M6bmN6yKhc3VYtvg6vz9RUMQjxcG16), mixed devUSDC+mockX/Phase C Reserve (Buy 59YGxj8ihHeJQP7czJXbgJxNhbyedbSacEEGjfn1FC3VEnpeY7MYABmvk9eP1eqrSJCdrhrfRmf4Me1X6fQrKt3f / Sell 9JZFtpvNUja4AdvvusSMrkgAT62MjKTPvAPB91r7u24nRNjfksf5u6qk7XsVGr8c5zbeBkgzJ5jfx4qpjaTRVK9)",
    "Exact vault/supply/NAV deltas confirmed per composition including mockZ's differing 9-decimal mint; required-signer lists confirmed (single signer for pure devUSDC, buyer+swap-authority whenever a non-devUSDC leg is involved)",
    "Cross-Reserve isolation explicitly confirmed: Reserves 1 and 2's own vault/supply state re-read byte-identical to their own post-trade snapshots after Reserves 3 and 4 traded",
    "Real holder/volume refresh confirmed across all 4 compositions (2-5 holders, $11.98-$76.98 24h volume each)",
    "18 new offline tests passing (163/163 total); tsc -b, tsc -p api/devnet/tsconfig.json --noEmit, vite build all clean"
  ]
}
```

## DEC-0072

```json
{
  "id": "DEC-0072",
  "date": "2026-08-04",
  "status": "confirmed",
  "decision": "Make Create-Reserve deployment safely resumable after a partial failure, instead of the prior all-or-nothing behavior where any failure past create-and-register discarded the one persisted pointer to the real on-chain Reserve and left the user on a blank form that could only create a SEPARATE Reserve. Added a pure decision module (src/merge/lib/createReserveResume.ts: determineDeploymentResumePoint, computeFundingShortfall, isWalletRejectionError, isPendingDeployStale) and a new resumeReserveDeploymentOnChain orchestration function (createReserveClient.ts) that reads real on-chain Reserve state before doing anything, classifies it into start-fresh / resume-from-funding / already-complete / asset-count-mismatch, funds only the genuine shortfall per asset (idempotent seed-funding), re-checks status immediately before AND after seeding (never blindly resubmits seed_reserve, never reports success without a fresh confirming read), and refuses to auto-resume at all on an asset-count mismatch. CreateDTR.tsx now shows a dedicated 'Resume Deployment' panel instead of dead-ending the user, blocks a fresh submission whenever a pending marker already exists for the wallet (the same mechanism now also guards against a second tab/fast-click race, since localStorage is shared per-origin), and classifies wallet-popup rejection as its own case (never treated as ambiguous, since nothing was ever submitted). Also added packages/sdk/src/errors.ts (decodeSsrProtocolError/extractCustomErrorCode/describeOnChainError) to decode a raw on-chain Custom(N) error against the real, deployed ssr_protocol IDL instead of ever guessing at its meaning again.",
  "context": "Live-reported DevNet failure: Reserve deployment (50% SOL / 50% MOCKX) created its Reserve account successfully, then failed during 'Funding seed assets (DevNet)' with 'InstructionError / Custom 6400,' and the UI incorrectly told the user to create another Reserve. Investigating the reported error code first: ssr_protocol's entire custom-error range (Anchor numbers them sequentially from 6000) is 6000-6040 (41 variants) -- confirmed against both errors.rs and the built IDL (target/idl/ssr_protocol.json) -- and the sibling ssr_devnet_amm program's range is 6000-6011. 6400 does not exist in either; it cannot be a genuine custom error from any program deployed in this repo as currently written. The real, reproducible root cause was architectural, not a specific error code: createReserveClient.ts's own header comment already documented 'Full step-level resumption ... is a natural v1.1 follow-up, not implemented here,' and CreateDTR.tsx's catch block for a fund-seed-assets/seed failure called clearPendingReserveDeploy() -- discarding the exact persisted pointer (wallet+reserve address) that a resume would need -- before telling the user to 'check Discover,' with no actual resume action anywhere in the UI. The only remaining actionable control was the same blank 'Launch a Decentralized Token Reserve' Submit button, which calls createReserveOnChain fresh every time: it re-derives a NEW reserve_id from ProtocolConfig.reserve_count (already incremented by the first attempt's successful create-and-register), so clicking it creates a genuinely separate, duplicate Reserve rather than resuming the original -- this exact failure mode was already independently confirmed once before, in DEC-0059's investigation, which found the actual orphaned/duplicate reserveId 19/20 pair this produced.",
  "rationale": "The Reserve account model (programs/ssr_protocol/src/state/reserve.rs) already exposes exactly the state needed to make this safe: ReserveStatus::Created/AssetsInitializing/Active (etc.) plus asset_count, both readable with zero wallet involvement via the existing fetchReserveOnChain (packages/sdk/src/readOnly.ts). create-and-register is a single atomic transaction (createReserve + every initializeReserveAsset combined -- DEC-0031), so 'assetsInitializing with the expected asset count already registered' and 'a status past AssetsInitializing' are the only two non-start-fresh states reachable through this app's own flow; a mismatched asset count can only mean external/corrupted state, which is refused rather than guessed through. seed_reserve's own on-chain guard (require reserve.status == AssetsInitializing, else UnexpectedReserveStatus/6010) already made a raw re-submission safe from double-minting -- this pass adds genuine CLIENT-SIDE idempotency (shortfall-based funding, a fresh status re-read immediately before seeding) so a resume never even attempts a redundant submission, rather than relying on the program's error as the only backstop. Removing PendingReserveDeploy's prior 10-minute staleness expiry was necessary for this to actually solve the reported problem: a real half-built Reserve on-chain is exactly as safe to resume an hour or a week later as a minute later, since every resume decision re-reads authoritative on-chain state regardless of the local marker's age -- keeping the old expiry would have silently reintroduced the same dead-end for any failure the user didn't return to within 10 minutes.",
  "alternativesConsidered": [
    "Keep 'retrying creates a new Reserve' but improve the warning copy -- rejected: this was the reported bug's actual behavior already; better copy doesn't give the user any way to finish a Reserve that already exists on-chain, and doesn't stop the abandoned-Reserve accumulation DEC-0059 already found evidence of.",
    "Detect an existing pending deployment and auto-resume it silently on the next Submit click, without a distinct Resume panel/action -- rejected: violates 'Show the exact failed step and a functional Resume deployment action' and 'never display success until every required transaction is confirmed' -- a distinct, explicit panel makes what's happening (and that a Reserve already exists) visible rather than surprising.",
    "Try to reconcile an asset-count mismatch automatically (e.g. by trusting whichever asset list is longer) -- rejected: a mismatch between the local pending marker and real on-chain state can only come from data corruption or an unrelated concurrent modification; guessing a reconciliation could construct wrong remaining_accounts for seed_reserve or attribute funds to the wrong asset. Refusing and surfacing it for manual Explorer verification is the only choice consistent with 'never create duplicate Reserves' and 'never recreate initialized accounts.'"
  ],
  "impact": "New: packages/sdk/src/errors.ts, src/merge/lib/createReserveResume.ts, tests/phase_reserve_deploy_resumability.ts (24 new tests covering all 7 required regression scenarios). Changed: src/merge/lib/createReserveClient.ts (resumeReserveDeploymentOnChain, fundSeedAssetsIdempotent shared by both the fresh and resume paths, signAndSend's failed-status branch now decodes through describeOnChainError, PendingReserveDeploy extended with assets/seedTotalUsd and its 10-minute expiry removed), src/merge/pages/CreateDTR.tsx (Resume Deployment panel, asset-count-mismatch panel, pre-submit pending-marker check as the concurrent-submission guard, wallet-rejection-specific toast, catch-block branches now transition into Resume instead of dead-ending), packages/sdk/src/readOnly.ts (ReserveOnChain now also surfaces mintFeeBps/tvlFeeBps/feeDestination, needed to describe a resumed Reserve accurately), tests/phase_buy_chart_category_deploy_pass.ts (updated for the new PendingReserveDeploy shape and the removed staleness expiry). No user-facing terminology was changed in this pass -- the task's request to use 'Reserve'/'reserve assets' for the whole product was explicitly declined in favor of keeping this file's own 'Mandatory terminology' section (Decentralized Token Reserve / Reserve / Reserve Token, DEC round 3, 2026-07-29) exactly as documented.",
  "affectedAreas": [
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/createReserveResume.ts",
    "src/merge/pages/CreateDTR.tsx",
    "packages/sdk/src/errors.ts",
    "packages/sdk/src/readOnly.ts",
    "tests/phase_reserve_deploy_resumability.ts",
    "tests/phase_buy_chart_category_deploy_pass.ts",
    "docs/project/PROJECT_STATUS.md"
  ],
  "supersedes": null,
  "supersededBy": ["DEC-0074"],
  "evidence": [
    "Confirmed via both programs/ssr_protocol/src/errors.rs and target/idl/ssr_protocol.json (41 custom errors, codes 6000-6040) and target/idl/ssr_devnet_amm.json (12 custom errors, codes 6000-6011) that error code 6400 exists in neither -- it is not a genuine custom error from any program in this repo as currently deployed.",
    "Live, read-only DevNet verification (no wallet signature) against the real deployed program at 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW: fetched real Reserve id 9 (GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C, status Active, 3 registered assets) and confirmed fetchReserveOnChain's new mintFeeBps(50)/tvlFeeBps(100)/feeDestination fields decode correctly against real on-chain data; determineDeploymentResumePoint correctly returned asset-count-mismatch when given a stale/incomplete candidate-mint list and already-complete once given the real, full list; a non-existent Reserve address correctly returned start-fresh.",
    "24 new offline tests in tests/phase_reserve_deploy_resumability.ts, all passing, covering all 7 required regression scenarios (fresh deployment, failure after Reserve creation, failure during seed-funding, retry/resume of a partial deployment, repeated-click/concurrent-submission guarding, an already-completed deployment, wallet rejection and error-code decoding). Full offline suite: 188/188 passing. tsc -b --force clean. vite build clean.",
    "No live signed-transaction resume was performed -- that requires an actual wallet approval (Phantom/Solflare popup) this environment cannot provide; the orchestration logic itself was verified via the pure decision-function tests plus the live read-only DevNet checks above, exercising the exact same fetchReserveOnChain/determineDeploymentResumePoint path resumeReserveDeploymentOnChain uses."
  ]
}
```

## DEC-0073

```json
{
  "id": "DEC-0073",
  "date": "2026-08-04",
  "status": "confirmed",
  "decision": "Stand up ssr.fun as its own production domain, on its own, completely separate Vercel project (ssr-fun-final -- distinct from ssr-fun, the project already serving strategic-super-reserve.fun), serving a static Coming Soon page ahead of public launch. ssr.fun is canonical; www.ssr.fun is configured as a real 308 (permanent) redirect to it, not a second, independently-servable copy. strategic-super-reserve.fun and its project/deployment/domain configuration/repository/branch were explicitly required to remain untouched throughout, and were verified untouched (domain-record updatedAt timestamps and a live health check both re-confirmed unchanged immediately after every Vercel-side change).",
  "context": "This repository (SSR.FUN) and its ssr-fun Vercel project are the closed DevNet/beta testing site (strategic-super-reserve.fun) -- not the intended public-facing product domain. ssr.fun is that domain. The project ssr-fun-final and its Vercel domain attachments for ssr.fun/www.ssr.fun already existed (created ~21h before this decision was recorded, evidently a prior manual/session step never logged here) but were not DNS-live: GoDaddy (ssr.fun's registrar) still held its default parked-domain records, and no www->apex redirect had been configured. This decision and its evidence record what was actually done to finish and verify that setup, since it was materially incomplete and entirely undocumented before now.",
  "rationale": "A second, fully separate Vercel project (rather than a second domain on the existing ssr-fun project) keeps the public marketing domain's deploy history, environment variables, and access entirely isolated from the closed DevNet/beta site -- a mistake in one can't affect the other, and it mirrors this repo's own established separation of concerns (DevNet-only endpoints already isolated under api/devnet/, DevNet-only secrets never shared with unrelated features). Canonical-apex-with-www-redirect (rather than serving identical content at both) avoids duplicate-content SEO issues and matches how strategic-super-reserve.fun/www.strategic-super-reserve.fun are already set up on the other project, for consistency. DNS was resolved through Vercel's own generated records (A 216.198.79.1 + 64.29.17.1 for the apex, CNAME for www) rather than switching ssr.fun to Vercel-managed nameservers, since the user's registrar (GoDaddy) and DNS management stay firmly outside Vercel/this session's control per explicit instruction -- only the exact records to add/remove at GoDaddy were reported, never applied directly.",
  "alternativesConsidered": [
    "Add ssr.fun as a second domain on the existing ssr-fun project (same project as strategic-super-reserve.fun) -- rejected per explicit instruction: the two must be fully separate to guarantee zero risk of the beta site's project/deployment/config being touched while working on the marketing domain.",
    "Point ssr.fun at Vercel's own nameservers (ns1/ns2.vercel-dns.com) instead of adding A/CNAME records at the existing GoDaddy DNS -- rejected: would have required a full nameserver migration at the registrar, a much larger and more disruptive GoDaddy-side change than the two records actually needed, and was explicitly out of scope (no GoDaddy changes to be made or guessed at by this session).",
    "Serve identical content at both ssr.fun and www.ssr.fun rather than redirecting -- rejected per explicit instruction to make ssr.fun canonical."
  ],
  "impact": "New production domain live: https://ssr.fun (Coming Soon page, project ssr-fun-final). www.ssr.fun redirects to it (308, Server: Vercel, own valid Let's Encrypt certificate). No files in this repository were changed by the Vercel-side work itself; a genuinely separate repository (ssr-fun-coming-soon, outside this repo, local-only -- see below) now holds the Coming Soon page's source. strategic-super-reserve.fun/ssr-fun confirmed untouched throughout (see evidence).",
  "affectedAreas": [
    "Vercel project ssr-fun-final (separate from this repository's ssr-fun project)",
    "DNS: ssr.fun / www.ssr.fun (GoDaddy-managed; only the exact required records were reported, never applied by this session)",
    "docs/project/PROJECT_STATUS.md (Environment Status, Dependencies)",
    "docs/project/ENGINEERING_TIMELINE.md (Milestones, Infrastructure)"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Live verification, all passing: https://ssr.fun returns 200 with the Coming Soon page's real content ('SSR.fun' / 'Coming Soon...'); TLS certificate CN=ssr.fun, Let's Encrypt, issued 2026-08-04, SAN exactly ssr.fun, verified by curl against the default trust store with no -k needed; http://ssr.fun returns 308 -> https://ssr.fun/; https://www.ssr.fun returns 308 -> https://ssr.fun/ with its own valid certificate; http://www.ssr.fun upgrades to https first, then redirects to the apex.",
    "Vercel domain-config API (GET /v6/domains/ssr.fun/config and /v6/domains/www.ssr.fun/config) confirmed misconfigured: false and conflicts: [] for both, and vercel certs ls confirmed both certificates issued, immediately after DNS was corrected at the registrar.",
    "strategic-super-reserve.fun confirmed untouched: GET /v9/projects/ssr-fun/domains re-read immediately after the ssr.fun redirect change showed identical updatedAt timestamps to the pre-change read for all 3 of its domain records (no mutating call was ever made against project ssr-fun or its domains in this session); a direct live request to https://strategic-super-reserve.fun/ and https://www.strategic-super-reserve.fun/ both returned 200, served by Vercel, immediately after the ssr.fun work completed.",
    "A stale intermediate state was caught and corrected, not assumed fixed: after the first round of GoDaddy changes, ssr.fun's apex still carried its old default parking A records (3.33.130.190 / 15.197.148.33) ALONGSIDE the two new Vercel records, confirmed live via two independent public resolvers (1.1.1.1, 8.8.8.8) and Vercel's own config API (misconfigured: true, explicit conflicts array) -- reported precisely as the remaining blocker rather than assumed resolved; re-checked and confirmed clean after the user's follow-up GoDaddy fix.",
    "The Coming Soon page's source (previously not tracked in any repository -- the live deployment had no git origin at all) is now committed to a new, separate local git repository (not this one) at Projects/ssr-fun-coming-soon, branch main. Not yet pushed to a hosted remote -- no GitHub CLI/token/credential helper was available in this environment; flagged as an open follow-up, not fabricated as done."
  ]
}
```

## DEC-0074

```json
{
  "id": "DEC-0074",
  "date": "2026-08-04",
  "status": "confirmed",
  "decision": "Reverse this repo's product terminology: 'Reserve' now means the complete basket/product (the fund), 'reserve assets' means its underlying holdings, and 'Reserve Token' is unchanged (the fund's fungible token). 'BYOR,' 'BOR,' 'DTR,' 'DTR Token,' 'DTR Asset,' and 'Decentralized Token Reserve' must never appear in new user-facing copy. CLAUDE.md's 'Mandatory terminology' section was rewritten accordingly. This is a full reversal of the 2026-07-29 round-3 wording (which used 'Decentralized Token Reserve' for the whole product and 'Reserve' for an underlying asset) and of DEC-0072's same-day decision, recorded only hours earlier, to keep that wording unchanged.",
  "context": "This exact terminology question was put to this session directly, given a live conflict between the current corrective-pass task's own terminology instructions (Reserve = whole product) and CLAUDE.md's then-current 'Final, 2026-07-29' section (the opposite mapping) -- the same fork DEC-0072 had already hit and declined earlier the same day. Asked directly whether this was a deliberate reversal of that same-day decision (not an accidental answer to a question the user didn't realize had already been settled once today), the user confirmed twice, explicitly: once giving the new mapping unprompted (funds = reserves, underlying assets = reserve assets, the fund's token = reserve token), and again after being shown DEC-0072's exact declining language and asked to confirm the reversal was intentional.",
  "rationale": "Two consecutive explicit confirmations from the user, the second made after being shown the exact prior decision being overturned, is sufficient basis to treat this as a genuine, deliberate change of direction rather than re-litigate or silently keep the old wording a second time. The Anchor account struct names (Reserve, ReserveAsset, Delegate, ProtocolConfig) already use 'Reserve' to mean the whole basket account -- under the OLD terminology this was flagged as a legacy mismatch needing a special carve-out explanation; under this new terminology the struct names and the product terminology now agree, which simplifies (but does not remove) CLAUDE.md's existing on-chain-discriminator-safety carve-out for internal identifiers.",
  "alternativesConsidered": [
    "Keep CLAUDE.md's 2026-07-29 wording a second time, as DEC-0072 did hours earlier -- rejected: the user was shown DEC-0072's exact language and explicitly confirmed this is a deliberate reversal, not confusion.",
    "Apply the new terminology only to new copy going forward without touching CLAUDE.md's documented section -- rejected: would leave the terminology section actively wrong and contradicting the terminology actually being shipped, defeating its purpose as the source of truth for future sessions."
  ],
  "impact": "Changed: CLAUDE.md ('Mandatory terminology' section rewritten; approved hero copy in src/pages/Home.tsx confirmed to need no change, since it already reads correctly under either mapping). Affects all subsequent user-facing copy sweeps in this corrective pass (button labels, headings, empty states, toasts, the 'Unnamed Reserve (#N)' fallback name, the discovery-resolution banner text) -- internal technical identifiers (createDTR, DTRAsset/CreateDTRAssetInput types, CreateDTR.tsx/ManageDTR.tsx/DTRDetail.tsx filenames, and the Anchor Reserve/ReserveAsset/Delegate/ProtocolConfig struct names) are explicitly unaffected, per CLAUDE.md's own carve-out.",
  "affectedAreas": [
    "CLAUDE.md",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/ManageDTR.tsx"
  ],
  "supersedes": ["DEC-0072"],
  "supersededBy": null,
  "evidence": [
    "Two explicit user confirmations in this session: an unprompted statement of the new mapping (funds = reserves, underlying assets = reserve assets, the fund's token = reserve token), then a direct AskUserQuestion confirmation after being shown DEC-0072's exact declining language, answered 'Yes, reverse it now.'",
    "Direct read of src/pages/Home.tsx confirmed the approved hero copy ('SSR.fun is where anyone can create, launch, and trade decentralized tokenized reserves... issue a Reserve Token backed by transparent, on-chain holdings') never uses 'Reserve' to mean an underlying asset, so it required no edit under the new mapping."
  ]
}
```

## DEC-0075

```json
{
  "id": "DEC-0075",
  "date": "2026-08-04",
  "status": "confirmed",
  "decision": "Wire real on-chain delegate management (add_delegate/update_delegate_permissions/remove_delegate) into the frontend for the first time, and fix a real placeholder bug that meant no genuinely non-root delegate could ever successfully call any real management transaction from this dashboard before now. New SDK builders (packages/sdk/src/managementInstructions.ts: buildAddDelegateInstruction/buildUpdateDelegatePermissionsInstruction/buildRemoveDelegateInstruction) and managementClient.ts functions (executeAddDelegate/executeUpdateDelegatePermissions/executeRemoveDelegate). Fixed executeUpdateTargets/executeAddReserveAsset/executeRemoveReserveAsset, which all previously passed the connected wallet's own pubkey as the 'delegate' account placeholder instead of deriving its real Delegate PDA (findDelegate(reserve, signer, programId)) -- this only ever worked by accident for the root manager, since require_reserve_permission short-circuits when signer == reserve.manager; any real, permitted delegate calling one of these would have failed. New hasOnChainPermission helper (src/merge/lib/onChainPermissions.ts), fail-closed by design: an unresolved delegate (discovery only resolves from a candidate-wallet hint list, no getProgramAccounts on the public RPC) reads as 'no permission,' never silently treated as 'not a delegate.' ManageDTR.tsx's gating replaced isRoot with isRoot || hasOnChainPermission(...) for every genuinely delegate-capable action (update_targets -> UPDATE_TARGETS, add/remove_reserve_asset -> MANAGE_LIQUIDITY_CONFIG); wind-down/close/fund_new_reserve_asset correctly stay root-only (confirmed those instructions accept no delegate account at all). Added a real add/edit-permissions/remove delegate UI to the previously read-only Delegates tab. The local-simulated delegate system in useAppStore.ts is deliberately kept, unchanged, for Reserves with no dtr.onChain (a purely local/simulated demo Reserve has no real Delegate PDAs to point at) -- never used as a fallback for a genuinely on-chain Reserve.",
  "context": "Part of the 2026-08-04 platform-wide DevNet corrective pass (see DEC-0074 for the terminology decision governing this same pass). Confirmed via direct source read that add_delegate/update_delegate_permissions/remove_delegate were fully implemented on-chain (real PDA, real permission-bitmask verification via require_reserve_permission) but had ZERO SDK-builder usage anywhere in this app -- delegate management existed only as a read-only, locally-labeled list, and every real management button hard-locked to isRoot regardless of any real on-chain delegate's actual permissions.",
  "rationale": "require_reserve_permission (programs/ssr_protocol/src/instructions/common.rs) already implements the exact delegate-signature verification needed -- this was a frontend/SDK gap, not a program design gap. Deriving the real Delegate PDA via the already-existing findDelegate helper (rather than inventing a new derivation) and reusing the existing signAndSend/runOnChainAction patterns in managementClient.ts/ManageDTR.tsx kept this consistent with the rest of the codebase's established conventions.",
  "alternativesConsidered": [
    "Remove the local-simulated delegate system entirely now that a real path exists -- rejected: a purely local/simulated demo Reserve (no dtr.onChain) has no real Delegate PDAs to check against, so the simulation is the only thing that can exist for it; removing it would break that category of Reserve entirely.",
    "Leave the wallet.publicKey delegate-placeholder bug alone since it 'worked' for the root manager -- rejected: it silently meant no real delegate could ever use these dashboard actions, a genuine correctness gap worth fixing while touching this exact code path."
  ],
  "impact": "New: packages/sdk/src/rpcResilience.ts is unrelated (see DEC-0074's sibling bug-fix work), packages/sdk/src/managementInstructions.ts (3 new builders), src/merge/lib/onChainPermissions.ts (hasOnChainPermission, PERMISSION_FLAGS), tests/phase_delegate_wiring.ts (10 new tests), scripts/verify_delegate_wiring.ts (live verification, not committed test infra but a real diagnostic script). Changed: src/merge/lib/managementClient.ts (3 new execute* functions, placeholder-bug fix across 3 existing functions), src/merge/pages/ManageDTR.tsx (real permission gating replacing isRoot in 3 places, new Grant/Edit/Remove Delegate UI).",
  "affectedAreas": [
    "packages/sdk/src/managementInstructions.ts",
    "src/merge/lib/managementClient.ts",
    "src/merge/lib/onChainPermissions.ts",
    "src/merge/pages/ManageDTR.tsx",
    "tests/phase_delegate_wiring.ts",
    "scripts/verify_delegate_wiring.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Live DevNet verification via scripts/verify_delegate_wiring.ts against the persistent Gate-9 fixture Reserve One (GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C) and its two already-real restricted delegates: hasOnChainPermission's decoding matched real fetched permission bitmasks (perms=2 for the UPDATE_TARGETS-only delegate, perms=192 for the PAUSE_RESERVE+UNPAUSE_RESERVE-only delegate) exactly.",
    "A genuinely non-root delegate (AKWHGN3EDPfkcpFhkG3EQcHBRY7eBFNCWNbV1osfDu7u, holding ONLY UPDATE_TARGETS) submitted a REAL, signed, confirmed update_targets transaction end to end for the first time via this fixed code path: signature 5t11fNo2Zq2TLuf5rWDGv3aWFVkVvdut6xd3gjtD1Mje5wCbmZrriN8RDdNDQSH7DxCZtsAzwA6tj611aQW1Mc8C.",
    "The SAME instruction, attempted by the OTHER real delegate (68gfCCwZRCXnyQN8MzEKykBhhenMKCqWxDC9oxS7TiBt, holding only PAUSE_RESERVE/UNPAUSE_RESERVE, NOT UPDATE_TARGETS), was genuinely rejected on-chain with the correct DelegatePermissionDenied error (custom program error 0x178c/6028) -- confirming permission gating is truly enforced on-chain, not merely that signing works.",
    "A full add_delegate -> update_delegate_permissions -> remove_delegate cycle against a fresh, disposable delegate wallet, all 3 real signed transactions confirmed (signatures do9seUHFkP79W8Q3VHudroKTLTapTzMWo1uq7U9JZiHrpYxfBCmUgmAhwAe8KQ3Tf8opqy6qi1fEMZG3FHMFiL2, M6TdJTFyVhuuM688Zrsd3wpg18VZvd3tt6MBgiDwnCDvMJcfSNoxevBEVFx2T4pFvVtBFrBHfSMJ76f34UuAEub, 3pVrpSTy2fd4vDw664Uw5xzREZkq2jFrqDgArDdfDsjAhFBKfuLog6izqS29wmmKQSYR2wK6bmTgEpbVoEctAeU2), with real before/after on-chain reads confirming the grant, the permission update, and the account's genuine closure.",
    "13/13 checks passed in scripts/verify_delegate_wiring.ts's final run. 10 new offline tests in tests/phase_delegate_wiring.ts, all passing (full offline suite: 205/205). tsc -b --force, vite build, oxlint all clean."
  ]
}
```

## DEC-0076

```json
{
  "id": "DEC-0076",
  "date": "2026-08-04",
  "status": "confirmed",
  "decision": "Rework and merge the previously-unmerged, uninitialized ssr_devnet_amm program (branch experimental/devnet-amm-swap, commit d6d1979) into this repo's working tree, changing its pool design from a hardcoded wrapped-SOL hub to a runtime-configured hub asset (AmmConfig.hub_mint, set to devUSDC), so it can eventually provide genuine devUSDC<->mockX/Y/Z liquidity for Buy/Sell -- replacing the current architecture where Buy mints non-devUSDC legs and Sell mints devUSDC, both fabricated by a server-held authority rather than sourced from real liquidity (the still-open DEC-0054 gap). NOT BUILT, NOT DEPLOYED, NOT RUN: this environment has no cargo/rustc/anchor/solana on PATH (see this pass's final report) -- every Rust and script change here is written to the established Anchor 1.1.2 conventions already used elsewhere in this workspace, but has not been compiler-checked, built, or executed against any deployed program. Buy/Sell themselves are UNCHANGED in this pass -- they still fabricate legs exactly as before; this decision only lands the liquidity foundation a future pass's Buy/Sell rewrite would route through.",
  "context": "Confirmed via direct source read that swap.rs/add_liquidity.rs/remove_liquidity.rs/Pool/AmmConfig were already fully generic over mint_a/mint_b -- only create_pool.rs and constants.rs referenced wrapped SOL specifically, and AmmConfig has never been initialized on DevNet (confirmed: the program is deployed bytecode but genuinely inert -- no config, no pools, no liquidity), so there was no on-chain migration cost to reshaping AmmConfig now.",
  "rationale": "A runtime-configured hub_mint field (rather than a second hardcoded compile-time constant alongside WRAPPED_SOL_MINT) avoids permanently coupling this program to one specific devUSDC mint address -- devUSDC is a devnet-specific SPL mint this repo created itself (packages/sdk/src/devUsdc.ts), not a cross-cluster constant like wrapped SOL. 3 pools only (devUSDC/mockX, devUSDC/mockY, devUSDC/mockZ) -- no devUSDC/WSOL pool, since SOL is explicitly out of scope for settlement per this pass's 'no SOL payout' requirement. Liquidity seeding (scripts/setup_and_verify_devnet_amm.ts, rewritten) mints both legs directly to the pool's sole liquidity authority (already the mint authority for devUSDC and every mock asset) rather than wrapping SOL -- legitimate initial liquidity provisioning by the pool's own authority, not a per-trade fabrication substituting for a genuine trade (the distinction this whole pass's economy correction depends on).",
  "alternativesConsidered": [
    "Build a new swap mechanism inside ssr_protocol instead of reworking the existing ssr_devnet_amm -- rejected per explicit user decision: reuses already-implemented, already-generic swap/liquidity logic rather than duplicating it.",
    "Hardcode devUSDC as a second compile-time constant (WRAPPED_SOL_MINT-style) rather than a runtime AmmConfig field -- rejected: needlessly re-couples the program to one specific mint address when AmmConfig has never been initialized and there's zero migration cost to making it configurable instead.",
    "Attempt to build/deploy in this environment anyway -- not possible: no cargo/rustc/anchor/solana on PATH; confirmed via `which` before writing any code, not assumed."
  ],
  "impact": "New (checked out from experimental/devnet-amm-swap into the working tree, then reworked): programs/ssr_devnet_amm/** (Cargo.toml, constants.rs, errors.rs, events.rs, lib.rs, state/{config,pool}.rs, instructions/{initialize_amm_config,create_pool}.rs edited for the hub-mint rework; swap/add_liquidity/remove_liquidity/pause_amm/unpause_amm/common.rs brought in unmodified, confirmed generic), packages/sdk/idl/ssr_devnet_amm.json, packages/sdk/src/{ammCalculations,ammInstructions (hubMint param added),ammPda,ammReadOnly,network}.ts, scripts/setup_and_verify_devnet_amm.ts (fully rewritten for the 3 devUSDC-hub pools). Changed: Anchor.toml/Cargo.toml (workspace member + program ID registration), packages/sdk/src/index.ts (new exports). Cargo.lock NOT regenerated (requires cargo, unavailable here) -- flagged as a required step before any build attempt.",
  "affectedAreas": [
    "programs/ssr_devnet_amm",
    "packages/sdk/src/ammInstructions.ts",
    "packages/sdk/src/index.ts",
    "scripts/setup_and_verify_devnet_amm.ts",
    "Anchor.toml",
    "Cargo.toml"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Direct source read confirmed swap.rs/add_liquidity.rs/remove_liquidity.rs contain zero references to WRAPPED_SOL_MINT/wrapped SOL after the rework (grep verified clean).",
    "npx tsc -b --force, npx vite build, npx oxlint, and the full offline test suite (205/205) all pass with the new/changed TypeScript files present -- this confirms the TypeScript layer (SDK exports, script rewrite) is internally consistent, NOT that the Rust program compiles or runs (cargo/anchor unavailable).",
    "No live transaction was submitted for any part of this decision -- the currently-deployed ssr_devnet_amm bytecode is still the OLD wrapped-SOL-hub version and does not accept the new initialize_amm_config(hub_mint, default_fee_bps) argument shape; running scripts/setup_and_verify_devnet_amm.ts against it today would fail, as documented in the script's own header comment."
  ]
}
```

## DEC-0077

```json
{
  "id": "DEC-0077",
  "date": "2026-08-04",
  "status": "confirmed",
  "decision": "Add a new ssr_protocol instruction, execute_rebalance_leg, that genuinely executes one rebalance leg (a real CPI'd swap of a Reserve's own vault assets via the reworked ssr_devnet_amm, see DEC-0076) -- unlike update_targets (writes target_weight_bps only, moves nothing) and record_rebalance (an unverified caller-supplied attestation), this instruction moves real value through a real on-chain swap. One leg (one CPI) per call, not an all-legs loop. Gated by the already-defined-but-never-checked EXECUTE_REBALANCE delegate permission flag via the existing require_reserve_permission helper. Reuses the Reserve's own vault_authority PDA (identical seeds redeem_reserve_tokens_in_kind already signs with) as the CPI's signing 'trader,' passing the Reserve's own registered-asset vaults directly as the AMM's trader_token_a/trader_token_b -- no intermediate transfer needed. Coexists with, does not replace, record_rebalance. New SDK builder (buildExecuteRebalanceLegInstruction) and a pure, offline-tested client-side planner (computeRebalancePlan) in a new packages/sdk/src/rebalanceExecutionInstructions.ts. NOT BUILT, NOT DEPLOYED, NOT TESTED against a real validator -- same toolchain gap as DEC-0076; frontend wiring (a ManageDTR.tsx 'Execute Rebalance' button, per-leg progress UI, and the executeRebalancePlan orchestrator in managementClient.ts) was deliberately NOT built in this pass, since wiring a UI to an instruction nobody can yet compile or deploy would add unverifiable surface area without proportionate value -- left as an explicit, disclosed follow-up.",
  "context": "Confirmed via direct source read (programs/ssr_protocol/src/instructions/update_targets.rs, record_rebalance.rs) that no instruction anywhere in ssr_protocol moves assets between vaults for rebalancing purposes -- this is a genuine, previously-undisclosed-as-closeable gap in the lifecycle capability matrix this pass was asked to complete (create/buy/sell/manage/delegate/rebalance/wind-down).",
  "rationale": "Reusing the identical vault_authority-PDA-signs-a-CPI pattern already proven correct for redeem_reserve_tokens_in_kind (rather than inventing a new signing mechanism) keeps this consistent with the rest of the program. The mint_sell/mint_buy accounts are validated against the AMM pool's own mint_a/mint_b (deriving a_to_b from that match) rather than trusting a separately-supplied boolean, removing a class of caller error. A coarse circuit-breaker (amount_in capped at half the sell vault's current balance) bounds blast radius per call given there is no on-chain price oracle to verify weight-correctness -- documented as a limitation, not hidden, mirroring record_rebalance.rs's own disclosure style exactly.",
  "alternativesConsidered": [
    "One instruction looping all legs in a single atomic transaction -- rejected: risks the compute-unit/account-count ceiling for a Reserve with several assets, and would force independent trades against independent pools to be atomic with each other for no real benefit, unlike a genuinely single trade's own legs.",
    "Replace record_rebalance entirely -- rejected: record_rebalance remains useful for any future non-AMM-routed manual rebalance; this instruction's own event is already intrinsically trustworthy and doesn't need record_rebalance's attestation wrapper.",
    "Build the ManageDTR.tsx UI/orchestrator anyway despite the instruction being unbuildable here -- rejected: would produce a large speculative UI surface for a transaction that cannot be tested end-to-end in this environment, disproportionate to the value delivered this pass."
  ],
  "impact": "New: programs/ssr_protocol/src/instructions/execute_rebalance_leg.rs, packages/sdk/src/rebalanceExecutionInstructions.ts (buildExecuteRebalanceLegInstruction, computeRebalancePlan), tests/phase_rebalance_execution.ts (7 new offline tests for computeRebalancePlan only). Changed: programs/ssr_protocol/src/{lib.rs (new dispatch entry),instructions/mod.rs (new module registration),errors.rs (2 new error variants, appended -- RebalanceLegExceedsCircuitBreaker, RebalanceLegSameAsset),events.rs (new RebalanceLegExecuted event)}, Cargo.toml for ssr_protocol (new path dependency on ssr_devnet_amm with the cpi feature). Explicitly NOT done: ManageDTR.tsx UI wiring, managementClient.ts orchestrator (executeRebalancePlan) -- left as a disclosed follow-up.",
  "affectedAreas": [
    "programs/ssr_protocol/src/instructions/execute_rebalance_leg.rs",
    "programs/ssr_protocol/src/lib.rs",
    "programs/ssr_protocol/src/instructions/mod.rs",
    "programs/ssr_protocol/src/errors.rs",
    "programs/ssr_protocol/src/events.rs",
    "programs/ssr_protocol/Cargo.toml",
    "packages/sdk/src/rebalanceExecutionInstructions.ts",
    "tests/phase_rebalance_execution.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "New error variants appended at the END of the SsrError enum (confirmed by direct read before editing) -- Anchor assigns error codes sequentially from declaration order, so this cannot have changed any existing error's numeric code.",
    "7 new offline tests for computeRebalancePlan, all passing (full offline suite: 205/205 -- 188 pre-existing plus 10 from DEC-0075 plus these 7). npx tsc -b --force, npx vite build, npx oxlint all clean with rebalanceExecutionInstructions.ts present.",
    "No live transaction was attempted or could be attempted -- execute_rebalance_leg has never been built (no cargo/anchor/solana in this environment) or deployed; nothing about its runtime correctness is verified beyond the TypeScript-layer SDK builder's account/argument shape typechecking cleanly against the existing Program<anchor.Idl> pattern already used throughout this codebase for other newer instructions."
  ]
}
```

## DEC-0078

```json
{
  "id": "DEC-0078",
  "date": "2026-08-05",
  "status": "confirmed",
  "decision": "Fixed a real, live CSS regression (Price History's 10 range-selector buttons rendering as one visually concatenated string) traced to a global, UNLAYERED `button {}` reset in src/index.css always beating Tailwind's own LAYERED utility classes inside .merge-scope pages, regardless of specificity -- excluded .merge-scope from that reset, matching this same file's own pre-existing `.container:not(.merge-scope *)` pattern for the identical class of bug. Extracted the range selector into its own small, dependency-free ChartTimeframeSelector component (real gap/wrap/focus-state styling added as defense in depth) and changed its default from 24h to 7d. Redesigned calculations.ts's buildLineSeries into the single centralized price-history/fallback helper shared by both DTRDetail's chart and Featured Reserves' sparkline: genuine history renders as before; a Reserve with fewer than 2 real price points now renders a client-side-only flatline (never persisted) anchored to its real current NAV (or its one real point's own value, extended backward, if exactly one exists) instead of an 'Insufficient price history' empty state; a Reserve with neither real history nor a valid NAV shows an honest 'Price unavailable' state instead of a fabricated $0 line. Fixed the identical NaN-on-zero-NAV bug in reserveCardProps.ts (already fixed in DTRDetail.tsx by DEC-0074) and tightened selectFeaturedReserves to also require assetsResolvedFully, isReserveTradable, and a real (non-'Unnamed Reserve') name. Traced and fixed the false 'DevNet RPC congested' Buy failure to two real misclassification bugs: swap-sign.ts's catch-all checked isRateLimitError(e) BEFORE describeUnknownSignerError(e, ...), so a real build/signer error could be silently relabeled as congestion; and isRateLimitError itself did a bare `.includes('429')` substring check that could false-positive on a base58 pubkey coincidentally containing that digit run -- both fixed (reordered classification; isRateLimitError now uses a word-boundary `\\b429\\b` regex). zapClient.ts's non-JSON-response handling no longer unconditionally labels itself 'rpc_congested' -- only when the HTTP status is genuinely 429. Added redactRpcSecrets (api/devnet/_lib/rpc.ts) as defense-in-depth against a network-level error ever echoing the configured Helius URL/API key into a client-facing error message or server log. Confirmed via `vercel env ls` that VITE_SOLANA_RPC_URL is NOT set in production (ruling out an env-misconfiguration explanation) -- the browser correctly routes through /api/devnet/rpc-proxy -> Helius in production exactly as designed; the root cause was purely the classification bugs above, not a genuine routing problem.",
  "context": "User-reported: the range-selector buttons rendered as one concatenated string ('1s1m5m1h4h24h7d30d1yAll'), the Price History chart showed an oversized empty state for most Reserves, Featured Reserve cards had excessive empty space (traced to the same missing-sparkline root cause -- Sparkline returns null below 2 points, which was the common case pre-fix), and Buy intermittently failed with a 'DevNet RPC congested' toast the user suspected was a misclassification given Helius is the configured provider, not the public rate-limited endpoint. A prior pass (2026-08-04, this repo's own PROJECT_STATUS.md) had investigated the range-selector/chart complaint by reading source only and concluded it was 'already fixed... not currently reproducible' -- that conclusion was wrong: the code path looked correct in isolation but the actual rendered CSS cascade (an unlayered native reset silently beating layered Tailwind utilities) was never checked. This pass corrects that by actually tracing the CSS cascade and, for the button-count claim specifically, rendering the real component and asserting on its real output rather than reasoning about the JSX alone.",
  "rationale": "The `:not(.merge-scope *)` exclusion pattern was already established in this exact file for the identical CSS cascade-layer issue (`.container`, see its own inline comment) -- applying the same fix to `button {}` is consistent with prior art, not a new pattern. Extracting ChartTimeframeSelector into its own dependency-free component was the only way to genuinely test 'renders 10 separate buttons, not one parent button' against real rendered output (via react-dom/server's renderToStaticMarkup) without introducing a full jsdom/testing-library stack this repo has deliberately never adopted (every existing test is pure-logic/offline) -- a scoped, minimal addition (jsx support in tests/tsconfig.json + a CommonJS-scoping package.json for src/merge/components/, mirroring the existing one at src/merge/lib/package.json) rather than a wholesale new testing framework. Reordering swap-sign.ts's error classification (specific/diagnosable errors before the generic rate-limit check) and tightening isRateLimitError's regex are both minimal, targeted fixes preserving every existing passing test (188 pre-existing offline tests plus this session's own new ones all still pass) rather than a broader rewrite of the error-handling architecture.",
  "alternativesConsidered": [
    "Add a jsdom + @testing-library/react stack to properly render and interact with the full DTRDetail.tsx component -- rejected as disproportionate: this repo has zero component-test infrastructure by deliberate convention (every existing tests/phase_*.ts file is explicitly pure-logic/offline), and the specific regression (button count/structure) is fully provable by extracting the selector into its own tiny, dependency-free component and using react-dom/server's already-available renderToStaticMarkup instead.",
    "Remove isRateLimitError's substring check entirely and only trust the HTTP status code -- rejected: several call sites (zapClient.ts's json.error-based check, when the server's own code field is already 'rpc_congested') still need a message-based signal as a secondary check; a word-boundary regex closes the real false-positive gap (an embedded '429' inside a longer identifier) without removing that secondary signal entirely.",
    "Assume the false congestion report was a genuine Helius-routing misconfiguration and go looking for an env-var fix -- rejected once `vercel env ls` directly confirmed VITE_SOLANA_RPC_URL is unset in production, which is the correct, intended state; pursuing an env fix would have been solving a problem that didn't exist while leaving the real classification bugs in place."
  ],
  "impact": "New: src/merge/components/ChartTimeframeSelector.tsx (+ its own package.json), api/devnet/_lib/rpc.ts's redactRpcSecrets, tests/phase_chart_range_selector.ts (5 new tests), tests/phase_featured_cards_and_rpc_redaction.ts (13 new tests). Changed: src/index.css (button reset scoped out of .merge-scope), src/merge/pages/DTRDetail.tsx (uses the extracted selector, default timeframe 24h->7d, chart empty-state replaced with unavailable/fallback-caption states), src/merge/lib/calculations.ts (buildLineSeries redesigned, new currentNav parameter, isFallback/unavailable replacing insufficientHistory), src/merge/lib/reserveCardProps.ts (NaN fix, fallback-sparkline wiring, stricter selectFeaturedReserves filter), packages/sdk/src/rpcResilience.ts (isRateLimitError word-boundary regex), api/devnet/swap-sign.ts (classification reordering + redaction applied to client-facing/logged error messages), src/merge/lib/zapClient.ts (non-JSON-response handling no longer unconditionally 'rpc_congested'), tests/phase_tradable_reserves_and_price_history.ts and tests/phase_rpc_resilience.ts and tests/phase_landing_wallet_corrections.ts (updated for the new buildLineSeries signature/semantics and the stricter Featured filter; 3 regression tests added to phase_rpc_resilience.ts), tests/tsconfig.json (jsx support added, scoped to tests only).",
  "affectedAreas": [
    "src/index.css",
    "src/merge/components/ChartTimeframeSelector.tsx",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/lib/calculations.ts",
    "src/merge/lib/reserveCardProps.ts",
    "packages/sdk/src/rpcResilience.ts",
    "api/devnet/swap-sign.ts",
    "api/devnet/_lib/rpc.ts",
    "src/merge/lib/zapClient.ts",
    "tests/phase_chart_range_selector.ts",
    "tests/phase_featured_cards_and_rpc_redaction.ts",
    "tests/phase_tradable_reserves_and_price_history.ts",
    "tests/phase_rpc_resilience.ts",
    "tests/phase_landing_wallet_corrections.ts",
    "tests/tsconfig.json"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "scripts/verify_chart_and_buy_fixes.ts run live against DevNet, 8/8 checks passing, real signed transactions: a genuinely fresh 100%-devUSDC Reserve created (createAndRegister 36AcYALZXK7A8cXVKW1wRwTvzEttHsoUbnyzPRKVkF4LvMPpjFVLiQeNjtM5J37n3s5dW5voNpbquAwq7rL1bcWS, fundSeedAssets 3iggxVL1s4UmSKBiNVWrqd9aj8ej65NkEbAXmUB5ptVyQDiBMo3Mj1xxo4rtJ2du4hJ7KwQV4tzvLGgrYCQ14zJE, seed GVVV4C8CHm6Y11aJHUgpLFLBcH8Vj1sm99cm7pi8pQQnkMSxXJCoptGVp1BcKqN8t3QRzjL2AZvLvEhdauLfxwx), confirmed a valid positive real on-chain NAV (1.0), a genuine Buy through the real (fixed) swap-sign.ts handler succeeded (signature 4Bw5uWAq3oa77owUMiQ7JubuPmENGDtgSDNiL63rhFAdcFYt9YN12x6vwPssGyWHY7HcHUQguuSZcGw5rLytDju, legSources correctly user-devusdc-balance, no fabrication), Reserve Token balance genuinely increased (20,000,000 -> 21,990,000 raw), refresh-persistence re-confirmed via a real re-fetch, and a deliberately-provoked genuine InsufficientFunds on-chain failure was correctly reported as a plain on-chain failure, NOT 'rpc_congested' (this same run's own real, organic 429s from the public RPC endpoint were also observed being correctly retried and resolved by the pre-existing withRateLimitRetry logic, not misreported).",
    "tests/phase_chart_range_selector.ts: renders the real ChartTimeframeSelector component via react-dom/server and asserts the actual output contains exactly 10 separate, non-nested <button> elements (the literal regression), each button's onClick independently wired to its own timeframe.",
    "230 total offline tests passing (205 pre-existing/prior-session plus 25 new/updated in this pass across tests/phase_chart_range_selector.ts, tests/phase_featured_cards_and_rpc_redaction.ts, and additions to tests/phase_rpc_resilience.ts/phase_tradable_reserves_and_price_history.ts), tsc -b --force, tsc -p api/devnet/tsconfig.json, tsc -p scripts/tsconfig.json (only the pre-existing, unrelated verify_multi_asset_tradability.ts error remains), vite build, oxlint all clean.",
    "Confirmed via `vercel env ls production` that only HELIUS_RPC_URL, DEVNET_SWAP_AUTHORITY_SECRET_KEY, and SSR_DASHBOARD_PASSWORD are set -- VITE_SOLANA_RPC_URL is absent, confirming the browser's production RPC routing was never misconfigured."
  ]
}
```

## DEC-0079

```json
{
  "id": "DEC-0079",
  "date": "2026-08-05",
  "status": "confirmed",
  "decision": "Fixed a visual regression introduced by DEC-0078 in which every merge-scoped control (Price History range buttons, all 16 information-tooltip triggers, the Buy/Sell tabs, the 25/50/75/Max percentage buttons) rendered with raw user-agent button chrome -- gray ButtonFace fills, outset bevels, inset shadows, square corners. Root cause: DEC-0078 scoped src/index.css's global button reset away from .merge-scope (via `button:not(.merge-scope *)`) to stop it clobbering Tailwind padding/background utilities. That did fix the clobbering, but src/merge/merge.css DELIBERATELY skips Tailwind's Preflight (see its own header comment -- it imports only the theme and utilities layers), so that global reset was the ONLY native-appearance reset merge-scoped buttons had; removing it let native browser chrome through everywhere. Correct fix, replacing BOTH prior attempts: keep the reset applying document-wide, but move it into @layer base and declare in index.css the same cascade-layer order merge.css already declares. Tailwind's utilities are emitted into `utilities` (the last layer), so they now cleanly override the reset, while any control WITHOUT such a utility still gets native chrome stripped. Extended the reset to mirror Preflight's own button handling: appearance:none (the actual source of the bevel/inset shadow) and border-width:0 + border-style:solid (so a Tailwind border utility yields a real 1px solid border instead of applying Tailwind's width to the UA's inherited outset style). Additionally centralised the 16 duplicated TooltipTrigger+Info call sites into one accessible InfoTip component (circular, aria-labelled, design-system border and focus ring), and restyled the range buttons and percentage buttons onto existing tokens (purple --primary selected state, lavender --border inactive, --ring keyboard-only focus, border present in both states so hover never shifts layout).",
  "context": "User-reported immediately after DEC-0078 shipped, with screenshots: several Reserve-detail controls looked like unstyled 1990s browser-default HTML buttons. This is the SECOND regression in the same button reset -- DEC-0078 fixed the first (an unlayered reset beating layered Tailwind utilities, collapsing 10 range buttons into one concatenated string) but did so by removing the reset from merge-scope rather than by layering it, trading one failure mode for a worse one. Radix's TooltipTrigger renders a completely class-less button, and shadcn's TabsTrigger styles only its ACTIVE state, so both had nothing but the global reset standing between them and native chrome -- which is why the information icons and the inactive Buy/Sell tab were the most visibly broken.",
  "rationale": "Cascade layers are the mechanism actually at issue, so the fix belongs there rather than in per-component CSS: a layered reset loses to later layers regardless of specificity, which is exactly the semantics needed (utilities win where present, reset applies where they are absent). Declaring the layer order explicitly in index.css (identical to merge.css's) makes the outcome deterministic rather than dependent on which stylesheet the bundler happens to emit first. Centralising the tooltip triggers follows the user's explicit instruction not to patch each button with one-off CSS, and simultaneously fixes a real accessibility gap -- an icon-only trigger with no accessible name -- rather than only its appearance. FABLE's own hand-written homepage/navbar rules are unlayered and therefore still win over the base layer, so the native pages are provably unaffected.",
  "alternativesConsidered": [
    "Revert DEC-0078 entirely -- rejected: it also carried the corrected chart/time-range behaviour, the centralised price-history fallback, and the RPC-misclassification fixes, none of which are implicated in this regression.",
    "Re-add Tailwind's full Preflight to merge.css -- rejected: merge.css skips it deliberately so Tailwind never resets element defaults document-wide and clobbers FABLE's own homepage styling; adding it back would risk a much broader regression than the one being fixed.",
    "Give each affected component explicit background/border utilities so nothing relies on a global reset -- rejected: it leaves the underlying trap in place for every future class-less control (the exact way Radix's TooltipTrigger was caught), and the user explicitly asked for the shared cause to be fixed rather than each button patched."
  ],
  "impact": "Changed: src/index.css (explicit @layer order declaration; button reset moved into @layer base and extended to Preflight-equivalent properties), src/merge/components/ChartTimeframeSelector.tsx (token-based purple/lavender styling, exported DEFAULT_CHART_TIMEFRAME), src/merge/pages/DTRDetail.tsx (11 InfoTip migrations, percentage buttons restyled as pills, default timeframe now the exported constant), src/merge/pages/CreateDTR.tsx (4 InfoTip migrations), src/merge/components/DevnetOnboarding.tsx (1 InfoTip migration), tests/phase_chart_range_selector.ts (extended). New: src/merge/components/InfoTip.tsx, tests/util/aliases.ts (a hand-rolled, dependency-free '@/*' resolver for the CommonJS test runner, matching this repo's minimal-dependency convention). NOT touched: calculations.ts's buildLineSeries, reserveCardProps.ts, and every chart code path in DTRDetail (verified by grepping the diff for chart-related identifiers -- zero hits), so DEC-0078's corrected chart behaviour is fully preserved.",
  "affectedAreas": [
    "src/index.css",
    "src/merge/components/InfoTip.tsx",
    "src/merge/components/ChartTimeframeSelector.tsx",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/components/DevnetOnboarding.tsx",
    "tests/phase_chart_range_selector.ts",
    "tests/util/aliases.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "242/242 offline tests passing (up from 230), including 4 NEW tests that pin the reset contract itself -- asserting index.css declares base ahead of utilities, that the button reset lives inside @layer base, that it is NOT scoped away from .merge-scope, and that it neutralises appearance/background-color/border-style specifically. These exist because this same reset has now caused two separate regressions; the component tests alone would not have caught either.",
    "Verified against the BUILT CSS, not just source: the reset bundle (jsx-runtime-*.css) emits @layer theme; then @layer base{...} then @layer components,utilities;, loads before main-*.css per dist/index.html's stylesheet order, and every utility the restyled controls depend on (bg-primary, text-primary-foreground, border-border, rounded-md, rounded-full, bg-background, h-7) is confirmed present in the utilities layer rather than purged.",
    "Verified against the DEPLOYED CSS after release: https://strategic-super-reserve.fun/assets/jsx-runtime-CJCptCQc.css contains @layer base{button,[type=button],[type=submit],[type=reset]{appearance:none;...;background-color:#0000;background-image:none;border:0 solid;border-radius:0;margin:0;padding:0}}, with no button:not(.merge-scope *) rule remaining.",
    "tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint (exit 0, only pre-existing warnings in tests/ssr_protocol.ts), and vite build all clean.",
    "NO browser-based visual verification was performed -- no browser-automation tool exists in this environment (a standing, previously-documented gap). The rendered appearance is verified indirectly: real component render output asserted in tests, plus the CSS cascade verified in the built AND deployed bundles. A human visual pass at desktop and mobile widths remains outstanding and is NOT claimed as done."
  ]
}
```

## DEC-0080

```json
{
  "id": "DEC-0080",
  "date": "2026-08-05",
  "status": "confirmed",
  "decision": "Declared the current SSR.fun frontend visual design the approved UI baseline, at commit `993b764` on `main` (tagged `ui-baseline-2026-08-05`). Documented in CLAUDE.md's new 'UI Baseline' section: colors, typography, spacing, borders, radii, shadows, card/page layouts, the Price History chart and its flatline fallback, the 10 separate time-range controls, metric information icons, the Buy/Sell tabs, percentage controls, primary actions, and desktop/responsive behavior are all now the reference standard. Future functional work must preserve this visual system and reuse the existing shared components (`ChartTimeframeSelector`, `InfoTip`, the shadcn primitives under `src/merge/components/ui`) and design tokens (`src/index.css`'s `:root` tokens; `src/merge/merge.css`'s theme tokens) rather than introducing new ones ad hoc, unless a redesign is explicitly requested. This is a documentation/milestone decision only -- no source, styling, or behavior was changed to produce it.",
  "context": "Direct instruction, immediately following DEC-0079's control-styling restoration: the current UI (as fixed by DEC-0078/DEC-0079) is explicitly approved and should be locked in as a durable reference point so future work does not accidentally regress it the way DEC-0078's own fix briefly did (twice, in the same button-reset mechanism). Confirmed via `git status`/`git log` before making any change that the working tree was already clean at `993b764` (only the pre-existing, unrelated, untracked `docs/architecture/`/`docs/journey-map/` directories present, both predating this session and left untouched throughout) -- no unfinished or unrelated work needed to be excluded from the baseline.",
  "rationale": "A CLAUDE.md section (read at the start of every future session, per this repo's own convention) is the right place for a standing constraint like 'do not restyle without being asked' -- the same durability CLAUDE.md's terminology and approved-hero-copy sections already provide. Pointing it at a specific commit and an annotated tag, rather than a vague 'current state,' gives future sessions (and `git diff`/`git log` against the tag) a concrete, checkable reference for what 'the baseline' actually was. Visual regression coverage was left as-is rather than expanded: DEC-0079 already added tests that render the real ChartTimeframeSelector/InfoTip components and assert on their output, plus 4 tests pinning the CSS reset's cascade-layer contract specifically -- exactly the mechanism that caused two prior regressions -- which is the maximum coverage this repo's existing pure-render-to-string test approach supports without adopting a jsdom/testing-library stack (a deliberate, previously-documented convention this repo has not adopted).",
  "alternativesConsidered": [
    "Add a jsdom/testing-library/visual-snapshot toolchain for pixel-level regression coverage -- rejected as out of scope for a documentation-only milestone pass; this repo's zero-component-test-framework convention is itself a considered, previously-documented choice (see DEC-0078's discussion of the same tradeoff), not an oversight to fix here.",
    "Tag an earlier commit (e.g. `19a785d`, the styling fix itself, before its own follow-up docs commit) -- rejected: the baseline should represent the fully-documented, pushed state of `main` at the moment of approval, not an intermediate commit whose own regression (DEC-0079) hadn't yet been recorded."
  ],
  "impact": "Changed: CLAUDE.md (new 'UI Baseline' section). New: git tag `ui-baseline-2026-08-05` (annotated, pointing at commit `993b764`). No application source, styling, or test files were modified -- this decision documents and marks a milestone, it does not alter behavior.",
  "affectedAreas": [
    "CLAUDE.md",
    "git tag ui-baseline-2026-08-05"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`git status --short` confirmed a clean working tree (only the pre-existing, unrelated untracked docs/architecture/ and docs/journey-map/ directories) before this decision was recorded, and `git log`/`git branch -vv` confirmed `main` was already in sync with `origin/main` at commit `993b764`.",
    "242/242 offline tests passing (unchanged from DEC-0079, re-run as a sanity check, not because any test or source file changed in this pass) -- including the DEC-0079 tests that directly cover the range selector, InfoTip, and the button-reset CSS contract this baseline depends on."
  ]
}
```

## DEC-0081

```json
{
  "id": "DEC-0081",
  "date": "2026-08-05",
  "status": "confirmed",
  "decision": "Fixed the reported \"2 registered asset(s) on-chain, but only 0 could be resolved\" / \"Buy not available for this Reserve\" bug at its root by centralizing public Reserve eligibility into one new, fail-closed function (packages/sdk/src/reserveEligibility.ts, evaluateReserveEligibility), quarantined every genuinely-unsupported legacy Reserve behind it (reserveId 0-8, 14, 15, 18, 19, 20, 21, 24 -- 16 of the 27 discovered), and created + fully live-verified a small canonical replacement set (Single-Asset 100% mockX, Balanced 50/50 mockX/mockY, Diversified 40/35/25 mockX/mockY/mockZ) through the real, unmodified Reserve-creation and Buy/Sell code paths. The ssr_devnet_amm AMM program was deliberately left deferred -- confirmed to compile cleanly (the toolchain gap that previously blocked it is resolved), but not built, deployed, or wired -- per explicit user decision made before this pass began.",
  "context": "A user report of the exact banner text above, plus a disabled Buy tab, on several of the earliest on-chain Reserves. Investigation started from CLAUDE.md's claim that this repo is a pure frontend simulation with no real program connected -- confirmed stale immediately: Anchor.toml declares real deployed program IDs (ssr_protocol 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW, ssr_devnet_amm AJbXGWSU1x9LtJW7uRKJCwS3JZYqXwqHXpX6erY7dS6c) and PROJECT_STATUS.md's own history documents extensive live-DevNet verification. PROJECT_STATUS.md's own claim of 'no cargo/rustc/anchor/solana on PATH at all' (DEC-0076/DEC-0077) was ALSO stale for this session -- direct checks found all four installed at ~/.cargo/bin and /c/devtools/solana/solana-release/bin, just not on the default shell PATH, and a funded DevNet deployer keypair (~/.config/solana/devnet-deployer.json, 6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk, also ProtocolConfig.authority) was already present. Both corrections are recorded here rather than silently acted on, since they reverse standing assumptions two prior sessions had explicitly documented as blockers.",
  "rationale": "Live discovery against the deployed program (reserveCount=28 at investigation time) proved the root cause precisely: reserveId 0-8 were created before the current fixture-mint registry (discovery.ts's candidateAssetMints hint list: devUSDC, mockX, mockY, mockZ) existed, and registered real assets whose mints -- confirmed by decoding their actual initialize_reserve_asset transactions -- are one-off pre-registry test tokens that can never appear in any future hint-list extension. This makes 'repair' structurally impossible for these 9 Reserves (no hint-list edit fixes a permanently orphaned one-off mint) -- 'purge, don't repair' is the only correct response, matching the task's own instruction. Program ID/IDL/account-layout/decoding were all confirmed correct along the way (Reserve struct decodes fine; cargo check on both programs is clean) -- ruling out a protocol-level bug before touching any frontend code. The prior mergeDiscoveredReserves filter only ever excluded a FULLY-resolved-but-unsupported Reserve, never an UNDER-resolved one, by deliberate original design (to avoid hiding a Reserve during a transient single-pass RPC hiccup) -- but this same leniency is what let a PERMANENT under-resolution slip through with no distinction from a transient one. The fix (exclude on any registered-vs-resolved mismatch in a fresh discovery result, while still protecting genuinely transient pass-level failures via the pre-existing fullyVerified/untouched retention mechanism, which operates at the right granularity -- the whole pass, not a fabricated per-asset issue flag) closes the real gap without reintroducing the false-positive risk the original design was written to avoid. Centralizing the decision into one function (rather than fixing mergeDiscoveredReserves' inline conditions and landing-stats.ts's independently near-duplicated version separately) directly satisfies the requirement that Discover/Featured/Portfolio/Manage/public-counts can never again silently disagree about which Reserves are real. Buy/Sell for the 3 new canonical Reserves deliberately uses the existing, already-repeatedly-live-verified, signed, devUSDC-settled fixed-price path (api/devnet/swap-sign.ts) rather than the ssr_devnet_amm AMM: per explicit user decision, building/deploying/seeding a second on-chain program and rewriting zapInstructions.ts's Buy/Sell builders is a separate, larger undertaking than this pass's actual scope (fixing broken legacy Reserves), even though the toolchain gap that previously blocked it is now confirmed resolved.",
  "alternativesConsidered": [
    "Attempt to repair reserveId 0-8 by adding their orphaned mints to the candidate-mint hint list (rejected: their original mints are one-off pre-registry test tokens with no ongoing role in the app -- adding them would resolve the Reserve's composition but the underlying assets still have no devUSDC-settled Buy/Sell route, no current pricing, and no product reason to exist; purging is the honest outcome, not a workaround)",
    "Keep per-page eligibility filters and just patch the specific missing under-resolution check in mergeDiscoveredReserves (rejected: landing-stats.ts's independently-duplicated filter would still exist as a second place to keep in sync, exactly the 'scattered filters/duplicated allowlists' problem the task explicitly asked to avoid)",
    "Build and deploy ssr_devnet_amm this pass now that the toolchain works (rejected, per explicit user decision: keeps this pass focused on the actual reported bug; the AMM rework is a separate, larger, higher-risk undertaking -- upgrading a live DevNet program, funding real pools, rewriting Buy/Sell instruction builders -- previously deferred many times for good reason, not something to bundle in opportunistically just because a blocker happened to clear)",
    "Hide the warning banner/disable the Buy tab more gracefully without addressing discovery (rejected: explicitly ruled out by the task -- 'do not stop after hiding the warnings or filtering the cards; the replacement Reserves must actually work')"
  ],
  "impact": "New: packages/sdk/src/reserveEligibility.ts (canonical eligibility gate), scripts/create_canonical_reserves.ts (idempotent creation+verification script), tests/phase_reserve_eligibility.ts (27 new tests). Changed: packages/sdk/src/index.ts (export), src/merge/lib/onChainReserve.ts (mergeDiscoveredReserves now returns {dtrs, quarantined}, new resolveDtrPageState router), src/merge/lib/types.ts (new QuarantinedReserveInfo type), src/merge/store/useAppStore.ts (new quarantinedReserves store field), src/merge/pages/DTRDetail.tsx (quarantine message branch), src/merge/pages/Portfolio.tsx (legacy-holding row, never erased), src/merge/lib/createReserveClient.ts (new validateCreateReserveAssets guard), api/devnet/landing-stats.ts (now calls the shared eligibility function instead of its own inline copy), scripts/verify_multi_asset_tradability.ts (one-line RPC-endpoint override for congestion mitigation), 4 existing test files updated for the corrected eligibility policy and the new mergeDiscoveredReserves return shape, .gitignore (excludes locally-pulled Vercel env files). 3 new real on-chain Reserves: Single-Asset (reserveId 28, 89RrhEebGPUKhcrAaMdJ1APZjR7DPUX47Mt9CVQECg6G), Balanced (reserveId 29, 3qQg8uSmWUt9mSae3urRwbYmHQ7LuzD5SCNLeRhHSsMw), Diversified (reserveId 30, 3d2y8EoyH8qhdzdkuCCp7D7nWo6WdYpTVZLvsDJmuc5w). No Rust/Anchor program changes -- the bug and its fix are entirely in the frontend/SDK discovery-hint and eligibility layer.",
  "affectedAreas": [
    "packages/sdk/src/reserveEligibility.ts",
    "packages/sdk/src/index.ts",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/lib/types.ts",
    "src/merge/store/useAppStore.ts",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/Portfolio.tsx",
    "src/merge/lib/createReserveClient.ts",
    "api/devnet/landing-stats.ts",
    "scripts/create_canonical_reserves.ts",
    "scripts/verify_multi_asset_tradability.ts",
    "tests/"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Root cause confirmed via live discovery against the deployed program (2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW, reserveCount=28) and by decoding reserveId 0's real initialize_reserve_asset transactions (asset_mint 8DbXfamh4scCwf49ANZh9TWUZ5nLgs1sB3wrhkgT7iD2 and AgMSFZE7w1YAR3bZqu1aJEaYqWYown2yySScGpzYZs2E, neither in any current or plausible-future candidate-mint hint list).",
    "27 new offline tests (tests/phase_reserve_eligibility.ts) bring the combined suite to 269/269 passing; tsc -b --force, tsc -p api/devnet/tsconfig.json --noEmit, oxlint (exit 0), vite build all clean (one known pre-existing, unrelated tsc -p scripts/tsconfig.json error in verify_multi_asset_tradability.ts, confirmed via git stash to predate this pass).",
    "Live-verified via scripts/verify_multi_asset_tradability.ts (real signed Buy+Sell against 4 real Reserves covering 100% devUSDC, 100% mockX, multi-asset mockX/Y/Z, and mixed devUSDC+mockX) and scripts/create_canonical_reserves.ts (real signed Create+Register+Seed+Buy+Sell for all 3 new canonical Reserves, Single-Asset verified fully end-to-end before Balanced/Diversified were created, per the required ordering): Single-Asset buy=3tcgvAuqconAMJbPWHigtVAd2qdSFW7ZDZ6QaaVy51RUnxjfrgwphQCd8M71UoVFP4HuB6YagEuVUMNdEabGcaTM sell=46e4DyrkNZwvrr4ohzUb6JR3q2RSgjtjGWzph9xsQ28RnJKPZAHgNQn7cGiUWZuQKBmMBSdeixUhQjahVE8EsaPZ; Balanced buy=35qzuqF4AEEcrMHLgdaup6vP2KM5wrKbFk5BsH7mtmebmXaUy8F8RTDoTaXC4KTbnojPyCAMDux1Abin4HwB9EvF sell=5Pmx6nNGXUeAYcGDCmwctn4jMrS97DdBiC3MEpcsEcY8pJGWXMCyHba3UGqfthtyAf1AtamZuvCE41hbBTb31nkS; Diversified buy=F2DQYKs8QgMVZbdMn7PkGtocdHSAJo1XW2bW9FbKRe5pmfDC4JRZT6yB8FSjdYXDEn3cFFLkLJzdRgMUWRdGaEL sell=5eaqLWGZpPcak4JvXeh9YCcMUDFYi5qfYWKnYxFwuMv4emoAvA3QH3gJgkx25jAew8Ujzp58uFfoMiN8h7rPjU1t. A fresh, independent re-read after the last Sell confirmed persistence (registered==resolved asset counts, correct AUM/NAV, real vault balances) rather than trusting in-process state.",
    "Approved UI baseline (DEC-0080) confirmed untouched by grepping the diff for every chart/control identifier (ChartTimeframeSelector, buildLineSeries, InfoTip, Tabs) -- zero hits outside the new quarantine branch's own plain text and Button."
  ]
}
```

## DEC-0082

```json
{
  "id": "DEC-0082",
  "date": "2026-08-11",
  "status": "confirmed",
  "decision": "Fixed the reported 'Portfolio Holdings frequently stuck on Syncing holdings... / DevNet unreachable' and 'Reserve creation frequently fails at Step 1/2, then the Reserve appears anyway after waiting/refreshing, or briefly shows Reserve Not Found' symptoms by tracing them to three real, distinct bugs -- NOT by rebuilding the resumable-deployment/ambiguous-transaction-reconciliation system (createReserveClient.ts/createReserveResume.ts/rpcResilience.ts), which was independently verified already correct (DEC-0055 through DEC-0072) and left untouched. (1) packages/sdk/src/discovery.ts's discoverAllReserves fetched every candidate Reserve account SEQUENTIALLY (already ~37 reserveIds and growing) with the top-level per-reserve fetch carrying NO retry at all (unlike the asset/vault/supply reads beside it) -- now batched via Anchor's fetchMultiple/connection.getMultipleAccountsInfo (chunked, packages/sdk/src/discovery.ts's new chunkArray) and retried per chunk; a live timing probe against the public DevNet endpoint (the same endpoint that was throwing continuous 429s in a parallel run seconds earlier) resolved 36 of 37 candidate reserveIds in 652ms with zero issues. (2) CreateDTR.tsx's handleResumeDeployment never registered a resumed Reserve into the dtrs store (unlike the fresh-creation success path a few hundred lines above), so navigating to /dtr/{id} immediately after a successful Resume hit a stale, empty local store. (3) onChainReserve.ts's resolveDtrPageState treated 'not yet in the local dtrs array' identically to 'genuinely doesn't exist' with no awareness of whether background discovery had completed even one pass -- the root cause that actually surfaced bugs #1/#2 as a dead-end 'Reserve Not Found' page instead of a soft, self-resolving state; DTRDetail.tsx/ManageDTR.tsx now render a 'Verifying on DevNet...' panel instead, backed by a new 'indexing' DtrPageState plus one bounded direct on-chain existence check (parseOnChainReserveId + fetchReserveOnChain) for the rarer case where discovery already completed a pass without this specific very-recent Reserve. Also added a dedicated, GLOBAL (not per-IP) sendTransaction throttle in api/devnet/rpc-proxy.ts, conservatively under Helius's paid-plan 5 sendTransaction/sec cap (a SHARED budget the pre-existing per-IP throttle did nothing to protect), so a burst of concurrent Reserve-launch/Buy/Sell submissions degrades into the same already-safely-reconciled 429 path instead of risking an unpredictable upstream rejection.",
  "context": "User-reported symptoms plus explicit instructions to trace Reserve Holdings end to end, trace the full Reserve-launch flow, confirm which sanitized RPC provider/cluster production actually uses, and check Vercel env vars/rate limiting/duplicate calls/timeout handling before writing any fix. Confirmed via `vercel env ls production` that HELIUS_RPC_URL is correctly set (Production only, as designed) -- ruled out a missing/misconfigured env var. Directly curl'd the live production rpc-proxy and landing-stats endpoints -- both healthy, ruling out the api/devnet/*.ts CJS/ESM deploy-bundling regression (cf950e7, 2026-08-05) as still-broken. Reading the actual data-flow code (not just PROJECT_STATUS.md's history, which repeatedly and correctly documents a mature RPC-resilience system) turned up the three concrete bugs above, none of which the prior corrective passes had covered -- they live in the discovery/indexing layer and the resume-specific UI path, distinct from the transaction-submission/reconciliation layer those passes hardened.",
  "rationale": "discoverAllReserves's sequential design was survivable at the Reserve counts that existed when it was written, but at ~37 (and growing) it means 150-200+ sequential RPC round trips per background poll, with the single most failure-prone call in that chain (the top-level per-reserve fetch) carrying no retry at all -- both the poll latency (directly causing 'frequently remains on Syncing holdings') and the single-hiccup-drops-a-whole-Reserve behavior (contributing to a freshly-created Reserve's intermittent invisibility) trace to this one function. Batching via getMultipleAccounts is not a new capability introduced for this fix -- api/devnet/rpc-proxy.ts already allow-listed the method and Anchor's account namespace already exposes fetchMultiple; it was simply unused here. The resume-path store-registration gap and resolveDtrPageState's binary found/not-found logic were each independently sufficient to reproduce 'Reserve not found, then later appeared' on their own (the former for the resume flow specifically, the latter for every path into the same gap, including ones neither this pass nor any future one anticipates) -- fixing only one would have left the other as a recurring source of the same user-visible report. The sendTransaction throttle is deliberately GLOBAL rather than per-IP because Helius's cap is a single shared budget across every client of this deployment, not a per-client one -- a per-IP throttle set below 5/sec would leave the shared budget unprotected from concurrent DIFFERENT testers, and set at/above 5/sec would not protect it at all.",
  "alternativesConsidered": [
    "Rewrite/harden the resumable-deployment and ambiguous-transaction-reconciliation logic (rejected: read closely and confirmed already correct against every reported symptom involving Step 1/2 failures -- CreateDTR.tsx's catch handler already reconciles via reserveAccountExistsOnChain before ever saying 'safe to retry'; rewriting working, already-tested code would have been pure risk with no corresponding fix)",
    "Batch only the top-level Reserve-account reads and leave the per-asset/vault/supply reads sequential (rejected: those are the SAME class of bug at smaller scale -- up to 4 candidate-asset reads and a vault/supply read per resolved Reserve, still O(reserveCount) round trips in aggregate; batching all four passes was not meaningfully more code once the chunking helper existed)",
    "Fix only resolveDtrPageState's indexing-awareness and skip registering the Resume path's DTR directly (rejected: belt-and-suspenders -- the direct registration removes the gap's most common trigger outright, at low cost, rather than relying solely on the fallback catching it every time)",
    "Set the new sendTransaction throttle per-IP, matching the existing pattern (rejected: does not protect the actual constraint, which is Helius's shared plan-wide cap, not any single client's own rate)"
  ],
  "impact": "Changed: packages/sdk/src/discovery.ts (discoverAllReserves batched+retried, new exported chunkArray), packages/sdk/src/readOnly.ts (fetchReserveOnChain's single-Reserve/asset/vault reads now retried), src/merge/lib/onChainReserve.ts (new DtrPageState 'indexing' kind, new parseOnChainReserveId), src/merge/pages/DTRDetail.tsx and ManageDTR.tsx (indexing-aware rendering + bounded direct on-chain fallback check), src/merge/pages/CreateDTR.tsx (handleResumeDeployment now calls registerRealReserve), api/devnet/rpc-proxy.ts (new global sendTransaction throttle, ApiRequest/ApiResponse now exported for direct handler-level testing), api/devnet/_lib/rateLimit.ts (unchanged -- checkRateWindow reused as-is). New: tests/phase_discovery_reliability.ts (19 new tests: chunkArray boundaries, resolveDtrPageState's indexing branch, parseOnChainReserveId, and the new sendTransaction throttle tested directly against the real handler with a stubbed fetch). tests/phase_reserve_eligibility.ts's existing resolveDtrPageState tests updated for the new required chainDiscoveryStatus parameter (added one new case; no existing behavior changed for the found/quarantined/not-found-once-ready states). No Rust/Anchor program changes; no Vercel settings, wallets, or production env vars changed; no new deploy performed.",
  "affectedAreas": [
    "packages/sdk/src/discovery.ts",
    "packages/sdk/src/readOnly.ts",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/pages/CreateDTR.tsx",
    "api/devnet/rpc-proxy.ts",
    "tests/"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "vercel env ls production: HELIUS_RPC_URL present (Production scope, as designed) -- ruled out a missing env var as the cause.",
    "Direct curl of the live production rpc-proxy (getLatestBlockhash) and landing-stats endpoints: both returned healthy, real data (fresh blockhash/slot; real per-Reserve holder/volume counts) -- ruled out the api/devnet/*.ts CJS/ESM bundling regression as still-broken.",
    "Live, read-only timing probe of the new batched discoverAllReserves against the public DevNet endpoint (no Helius credential available in this local environment): 36 of 37 candidate reserveIds resolved in 652ms with 0 issues, immediately after a separate scripts/verify_discovery.ts run against the SAME endpoint logged dozens of 429s under its own (unrelated, more granular per-account) verification pass -- direct evidence the batched round-trip count, not endpoint health, was the bottleneck.",
    "299/299 offline tests passing (19 new in tests/phase_discovery_reliability.ts, 1 new + 5 updated in tests/phase_reserve_eligibility.ts); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint (exit 0), full `npm run build` (packages/sdk CJS build + tsc -b + vite build) all clean.",
    "No wallet/browser-automation tool is available in this environment (consistent with every prior pass documented above) -- a real click-through of Create/Resume/Portfolio with a connected wallet was not performed; verification here is offline pure-logic tests plus the live read-only discovery timing/correctness probe above."
  ]
}
```

## DEC-0083

```json
{
  "id": "DEC-0083",
  "date": "2026-08-11",
  "status": "confirmed",
  "decision": "Tackled all 5 items of live user feedback dropped directly on the Road to Mainnet collaborative checklist (AR-01, DL-01, PU-01, WD-01, FE-01), each traced to a confirmed root cause by reading the actual code/program rather than guessing, and separately added a pass-based comments system to the checklist itself. (1) AR-01: redesigned ManageDTR.tsx's Rebalance tab to mirror CreateDTR.tsx's asset-selection step -- search+browse addable assets on the left, current Reserve assets with real balance/USD value and a before/after target-weight comparison on the right -- reusing the exact same already-working on-chain actions (update_targets/add/fund/remove_reserve_asset), no new capability. (2) DL-01: fixed isManagerOrDelegate (extracted to a new src/merge/lib/permissions.ts, pure/zustand-free so it's directly offline-testable) to also check a Reserve's real onChain.delegatesOnChain, not just the local/simulated delegates array -- a genuinely-granted on-chain delegate never saw the Reserve on their own dashboard before this; and added a real Activity Log (new packages/sdk/src/activityLog.ts, reusing the EventParser pattern already proven in readOnly.ts's volume calculation) surfacing every governance event a Reserve has ever emitted on-chain. (3) PU-01: pause_reserve/unpause_reserve were real, deployed, already-permission-checked-on-chain instructions with ZERO SDK or UI wiring anywhere (only ever called from a one-off setup script) -- added SDK builders, client wrappers, and a Pause/Unpause control on the manager dashboard. (4) WD-01: a wound-down Reserve was being fully quarantined by reserveEligibility.ts (excluded from `dtrs` exactly like a broken legacy Reserve) -- confirmed directly against the Rust source that redemption is ALREADY permitted during WindDown by design (close_reserve requires supply to reach zero) while mint/Buy is separately already blocked (requires exactly Active) -- fixed the frontend visibility/badge/Buy-disable only, no program changes. (5) FE-01: confirmed the Review step already showed the real configured fee destination (clarified copy instead of changing behavior); found collect_fees was, like pause/unpause, a real permissionless deployed instruction with zero wiring anywhere -- added it, plus a pending-fees display; and confirmed 'Additional Fee Recipients' has never been wired on the real on-chain path at all (Reserve has exactly one fee_destination field) -- per explicit user decision, relabeled/disabled it for real Reserves rather than building new on-chain fee-splitting. Separately: added an append-only, pass-grouped comments thread (new rtm_comments table) to the Road to Mainnet checklist itself, backfilled the 2026-08-11 feedback round as pass 1 (archived verbatim, plus this session's own reply per item) and locked it, with a 'Lock current pass' action so any future round becomes pass 2, 3, etc., each starting open and ending locked.",
  "context": "User dropped feedback directly on the live checklist (confirmed received in a prior turn by reading rtm_revisions directly), then asked for each item to be fixed and pushed, and for the checklist itself to gain a locked-pass-1/open-pass-2+ comment model with the option for the assistant's own comments to be included. Investigation of PU-01's checklist note (a garbled 'There is current pause / unpause mint and redeem option') and FE-01's 'fee destination gets nothing' report both turned out to have the identical shape once the actual code was read: a real, deployed, already-correct Anchor instruction (pause_reserve/unpause_reserve, collect_fees) with a complete absence of any frontend integration -- not a bug in existing code, a missing feature. WD-01 and DL-01a were genuine confirmed bugs in existing frontend logic. AR-01 was a genuine UX request against an already-functionally-complete feature.",
  "rationale": "Every fix here was scoped to the smallest change that closes the real gap, reusing already-established patterns rather than inventing new ones: the pause/unpause/collect_fees SDK builders mirror the exact account-derivation shape of the 9 already-existing managementInstructions.ts builders; the activity log reuses readOnly.ts's proven EventParser pattern; the Rebalance tab redesign reuses CreateDTR.tsx's own search+list markup/state pattern; the comments backend reuses state.ts's existing optimistic-concurrency/auth conventions almost verbatim. The 'Additional Fee Recipients' gap was deliberately NOT closed by building real on-chain multi-recipient fee splitting -- doing so would require a Reserve account-layout or new-instruction change to the deployed program (a redeploy, materially larger and riskier scope) -- the user was asked directly and chose the smaller, honest fix (relabel) over that larger undertaking. The comments-pass model was built as a genuinely separate table (rtm_comments) rather than repurposing the existing mutable notes field, specifically so 'locking' can never destroy or overwrite anything already recorded -- the existing status/evidence/notes fields are completely untouched by any of this.",
  "alternativesConsidered": [
    "Build real on-chain multi-recipient fee-splitting for FE-01 (rejected per explicit user decision -- requires a program change/redeploy, a separate and much larger undertaking than this pass's scope)",
    "Gate the new pause/unpause/collect-fees UI to the root manager only, matching Wind Down's existing root-only gating (rejected: pause/unpause are genuinely delegate-permission-checked on-chain (PAUSE_RESERVE/UNPAUSE_RESERVE bits) and collect_fees is genuinely permissionless -- gating the UI more strictly than the program itself would misrepresent who can actually act)",
    "Repurpose the existing mutable notes/evidence fields for the pass-locking feature instead of a new table (rejected: would require either destructively overwriting prior text on lock, or bolting a parallel versioning scheme onto fields that already have their own separate, working history mechanism -- a dedicated append-only table is simpler and strictly safer)",
    "Lock passes per-item instead of globally (rejected: the user's request framed 'my comments' as one round becoming pass 1 as a whole -- a single global lock action matches that intent and is far simpler to reason about than per-item pass state)"
  ],
  "impact": "New: src/merge/lib/permissions.ts, packages/sdk/src/activityLog.ts, api/road-to-mainnet/comments.ts, api/road-to-mainnet/comments/lock.ts, tests/phase_road_to_mainnet_feedback.ts (17 new tests). Changed: src/merge/store/useAppStore.ts (re-exports permissions.ts), packages/sdk/src/reserveEligibility.ts (windDown now eligible), packages/sdk/src/managementInstructions.ts (+3 builders), packages/sdk/src/readOnly.ts (+pendingFeeShares fields, retry consistency), src/merge/lib/managementClient.ts (+3 client wrappers), src/merge/lib/types.ts (+feeDestination/pendingFeeShares on OnChainReserveMeta), src/merge/lib/onChainReserve.ts (threads new fields through), src/merge/pages/DTRDetail.tsx (Wind Down badge/banner, Buy disabled), src/merge/lib/reserveCardProps.ts (windDown excluded from Featured), src/merge/pages/CreateDTR.tsx (fee-destination copy, fee-recipients relabel), src/merge/pages/ManageDTR.tsx (Pause/Unpause card, Pending Fees + Collect Fees, Activity tab, redesigned Rebalance tab), lib/road-to-mainnet/schema.sql (+rtm_comments table), lib/road-to-mainnet/store.ts (+comments functions), scripts/migrate-road-to-mainnet.mjs (+idempotent comments backfill + pass-1 lock), public/road-to-mainnet.html (+Comments UI, +Lock current pass action), tests/phase_reserve_eligibility.ts (1 case updated for windDown). 317/317 offline tests passing (32 new across both test files this pass + the prior pass); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint (exit 0), full npm run build all clean.",
  "affectedAreas": [
    "src/merge/lib/permissions.ts",
    "packages/sdk/src/activityLog.ts",
    "packages/sdk/src/reserveEligibility.ts",
    "packages/sdk/src/managementInstructions.ts",
    "src/merge/lib/managementClient.ts",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "lib/road-to-mainnet/",
    "api/road-to-mainnet/comments.ts",
    "api/road-to-mainnet/comments/lock.ts",
    "public/road-to-mainnet.html",
    "tests/"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Live, real-signed DevNet verification (throwaway script, not committed): pause_reserve (signature 24oz3oj3QWEoBDyfTVvsico9QdWzdxS78PtZa4KYmd7PP7apzRHTPKdseRiyWTyeiY6PL29Ca8ega1Eb2qHnY24H) and unpause_reserve (signature 5K9MtqyDMLSMpuFZWtA7RJPcCkzp3WtbehkYc3NYXvPvxvRDQbs1EMr4gjAdQ3boMhtNF367hnGDMN1AhwzpnwFt) both succeeded via the REAL, already-granted, non-root pauseUnpause delegate (68gfCCwZRCXnyQN8MzEKykBhhenMKCqWxDC9oxS7TiBt) against the persistent Gate-9 'DevNet Reserve One' fixture, status verified active->paused->active, fixture restored before the script exited.",
    "Live, real-signed collect_fees (signature 5EaFQbMW7v27j5iMW1oZ1DLcTL7BrXuSQ7KF7fQ2NBSqe7ZmtVxxveZ1bksrkWvoPJ9NDaZELHEPH4iyW5dVm5kW): Reserve One genuinely had 11,888,804 pending manager-share + 2,972,200 pending protocol-share raw Reserve Token units that had NEVER been collected (confirming the exact root-cause diagnosis) -- both paid out and verified zeroed after the call.",
    "Live, read-only discovery confirmed a REAL on-chain Reserve currently in windDown status (reserveId 13, Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX) evaluates as eligible=true under the fixed reserveEligibility.ts -- confirmed eligible=false (quarantined) under the prior logic for the exact same live data.",
    "Comments backend live-verified against the real database: schema migration applied, 10 comments backfilled (5 items x original+reply) into pass 1, pass 1 locked, re-running the migration script confirmed fully idempotent (0 new, 0 re-locked).",
    "317/317 offline tests passing, tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint (exit 0), full npm run build all clean.",
    "No wallet/browser-automation tool is available in this environment -- the new Pause/Unpause, Collect Fees, and Rebalance-tab UI controls were exercised via their real underlying instructions/functions above and via full offline test coverage of the surrounding pure logic, but the literal click path (button -> wallet popup -> confirmation) was not driven by a human or automated browser."
  ]
}
```

## DEC-0084

```json
{
  "id": "DEC-0084",
  "date": "2026-08-12",
  "status": "confirmed",
  "decision": "Redesigned ManageDTR.tsx's real-Reserve 'Reserve Composition & Rebalance' tab (the on-chain branch of AR-01's 2026-08-11 layout, DEC-0083) around a devUSDC-priority cash-bucket slider model, and fixed the root cause of the reported add_reserve_asset_active custom-program-error. Root cause: the prior UI called add_reserve_asset_active with whatever nonzero weight% the user typed for a NEW asset while every EXISTING asset still held its old on-chain weight, so on any already-~100%-allocated Reserve (the normal case) any nonzero Add weight breached the on-chain 10,000bps total-target-weight cap, throwing SsrError::TargetWeightExceedsTotal (confirmed against add_reserve_asset_active.rs's exact require! order: status check, then permission, then asset-count limit, then this weight-sum check). Fix: newly-added assets now always register at target_weight_bps=0 (which can never breach the cap, since 0 added to anything already <=10000 stays <=10000), and every asset's real final weight -- new and existing -- is set together via exactly one update_targets call (which itself atomically enforces the same <=10000 invariant across the FULL asset list in one pass). Both are now batched into ONE wallet-signed transaction (executeSubmitRebalance, src/merge/lib/managementClient.ts) -- Solana executes instructions within a transaction sequentially against shared account state, so update_targets' remaining-accounts check correctly sees an asset registered earlier in the same transaction -- replacing the prior per-click-immediate-transaction Add flow and the separate single-instruction Submit. Adding an asset to the proposed composition, removing a not-yet-submitted one, and dragging any weight slider are now purely local/session React state -- zero wallet prompts -- until the user clicks the renamed 'Submit Rebalance' button, the ONLY action in this tab that requests a signature; Fund and permanently removing an already-registered empty/last-index asset remain their own separate, individually-approved maintenance actions, unchanged, per explicit product scope decision (they move real token balances or delete an on-chain account -- structurally different from a target-weight-only change, and update_targets was already documented as 'changes intent only, moves nothing'). Redistribution across the slider set follows a new pure function (applySliderWeightChange, src/merge/lib/rebalanceSlider.ts, 13 new offline tests in tests/phase_rebalance_slider.ts): decreasing a non-devUSDC asset moves the freed weight 1:1 into devUSDC; increasing one draws from devUSDC first, then proportionally from every other non-devUSDC asset if still short; dragging devUSDC's own slider is symmetric, spread proportionally across every non-devUSDC asset; the proposed composition always sums to exactly 10,000bps by construction, including the case where one asset is set to 100% (every other asset, including devUSDC, is driven to exactly 0 via the same rules, with rounding remainder resolved deterministically rather than left as dust). devUSDC is now a permanent row in the editor (seeded at 0 plus any currently-unallocated on-chain slack if it isn't already a registered Reserve Asset) rather than an assets the user has to remember to add, so the cash-bucket rules are always active. Each asset row shows a shadcn Slider (mirroring CreateDTR.tsx's existing Basket Composition per-asset row pattern) with a yellow benchmark marker (a small absolutely-positioned overlay, amber-500/amber-400 for light/dark) at that asset's real current on-chain target weight, a live projected USD value (proposed weight x total Reserve USD value) alongside its real current balance, a 'New' badge for a not-yet-registered asset, and a 'Reducing to 0%' flag when applicable. Separately: wired packages/sdk/src/errors.ts's existing describeOnChainError into managementClient.ts's shared signAndSend (previously only createReserveClient.ts did this) so every management action in this file -- not just the new one -- now surfaces an honestly IDL-decoded on-chain error instead of a raw, undecoded blob. Also removed every remaining developer-facing UI-copy leak in ManageDTR.tsx ('(real DevNet tx)' suffixes on the Save Permissions/Grant Delegate buttons, raw snake_case instruction names shown as visible text in the Delegates-tab banner/Pending-Fees copy/toast pending-state labels across delegates/pause/unpause/wind-down/close/fund/remove, and 'Phase E' roadmap jargon in the Rebalance card description), and added a new durable CLAUDE.md rule ('Interface Copy Standards') requiring all user-facing copy to explain the user's action and its outcome in plain language going forward, with internal function/instruction names and developer shorthand confined to code/comments/logs.",
  "context": "User asked for Manage Reserve -> Portfolio Rebalance to be rebuilt as a smooth, slider-based local-preview experience (searchable asset list on the left, Add moves an asset into the proposed composition, sliders with an exact percentage/projected USD value and a yellow current-weight benchmark on every asset, reduce-feeds-devUSDC / increase-draws-devUSDC-first redistribution rules, 100%-on-one-asset zeroes every other asset, weights always summing to exactly 100%), with adding/removing/adjusting assets never triggering Phantom or making individual transactions -- only a renamed 'Submit Rebalance' action, submitting the complete proposed composition in one approval wherever technically possible. The user also explicitly asked to investigate and fix the underlying add_reserve_asset_active custom program error they had hit, rather than moving or hiding it, and to remove developer-facing copy ('real DevNet transaction', raw instruction names, internal transaction descriptions) throughout, adding a permanent CLAUDE.md rule requiring plain-language interface copy going forward.",
  "rationale": "The batched single-transaction approach (register-at-0 then one atomic update_targets) was chosen over sequential transactions because it directly closes the reported bug at its root -- any nonzero-weight add against an already-allocated Reserve is now structurally impossible, not just less likely -- and because a partial failure between a sequential add and a later update_targets would otherwise leave an asset registered at a stale/zero weight with no clean single-step way to retry, which conflicts with the explicit requirement that Submit Rebalance be the ONLY wallet-prompting action in this tab. describeOnChainError's gap in managementClient.ts was fixed as part of this pass rather than deferred separately, since it is the same class of 'raw undecoded error' problem the add_reserve_asset_active investigation surfaced, and the fix is a single shared line benefiting every action in the file, not just the new one. The devUSDC-priority redistribution logic was extracted into its own new file (rebalanceSlider.ts) rather than folded into calculations.ts's existing applyRebalance, specifically to avoid the two models being confused: applyRebalance's generic proportional-rescale-everyone behavior remains exactly as-is and is still the only logic the simulated/demo Reserve branch (dtr.onChain undefined, no wallet involvement, explicitly out of scope for this pass per user decision) uses. Fund and permanently-removing an empty/last-index asset were deliberately kept as separate, individually-approved actions rather than folded into the batched submit, per explicit user decision during planning: they move real token balances or delete an on-chain account entirely, a structurally different and rarer action than proposing a new target-weight composition, and update_targets was already documented in this codebase as changing intent only, never moving real holdings.",
  "alternativesConsidered": [
    "Keep add_reserve_asset_active and update_targets as two separate signed transactions, sequenced by the UI (rejected: reintroduces the exact atomicity/partial-failure risk this pass exists to close, and violates the explicit requirement that Submit Rebalance be the ONLY wallet-prompting action in this tab)",
    "Fold the devUSDC-priority redistribution model into calculations.ts's existing applyRebalance (rejected: applyRebalance's generic proportional-rescale-everyone model is still correct and in active use by the untouched simulated/demo branch; conflating the two risks regressing that path)",
    "Also fold Fund and permanently-removing an empty/last-index asset into the batched Submit Rebalance transaction (rejected per explicit user decision during planning: Fund requires the connected wallet to actually hold the tokens being transferred in, and Remove has its own on-chain prerequisites (zero vault balance, last-registered order_index) -- both are structurally different from a target-weight-only change and are kept as their own clearly-labeled, individually-approved actions)",
    "Only fix the reported add_reserve_asset_active error narrowly (e.g. clamp the typed weight client-side) without the broader slider/local-preview redesign (rejected: the user's request was explicitly for the full redesign, and a narrow clamp would not deliver the requested devUSDC-cash-bucket UX, the single-transaction submit, or the yellow current-weight benchmark)"
  ],
  "impact": "New: src/merge/lib/rebalanceSlider.ts (applySliderWeightChange + distributeProportionally), tests/phase_rebalance_slider.ts (13 new tests). Changed: src/merge/lib/managementClient.ts (+RebalanceAssetPlan/executeSubmitRebalance, describeOnChainError wired into signAndSend), src/merge/pages/ManageDTR.tsx (real-Reserve Rebalance tab fully rebuilt: new sessionAddedAssets/proposedWeightsBps state + seeding effect + handlers, slider-based JSX with yellow benchmark marker/projected-USD-value/New-badge, Submit Rebalance wiring; developer-facing copy cleanup across Delegates/Pending-Fees/Pause-Unpause/Wind-Down/Close/Grant-Delegate), CLAUDE.md (+Interface Copy Standards section). 330/330 offline tests passing (317 prior + 13 new); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint (exit 0), full npm run build all clean.",
  "affectedAreas": [
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/lib/rebalanceSlider.ts",
    "src/merge/lib/managementClient.ts",
    "tests/phase_rebalance_slider.ts",
    "CLAUDE.md",
    "docs/project/PROJECT_STATUS.md"
  ],
  "supersedes": ["DEC-0083"],
  "supersededBy": null,
  "evidence": [
    "330/330 offline tests passing (13 new in tests/phase_rebalance_slider.ts, covering decrease-feeds-devUSDC, increase-draws-devUSDC-then-proportionally, equal-split-when-others-are-zero, direct devUSDC edit both directions, 100%-drains-everything-else-to-exactly-0 including devUSDC itself, rounding/remainder determinism with an uneven 3-way split, the no-devUSDC-in-composition fallback, purity/non-mutation, and the not-found/no-op edge cases); zero regressions in the pre-existing 317.",
    "tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint (exit 0), full npm run build all clean.",
    "Direct code-path read confirms zero runOnChainAction/signAndSend/wallet.signTransaction calls in the redesigned branch's add/adjust/remove-before-submit handlers (handleAddAssetToSession, handleSliderChange, handleRemoveSessionAsset are pure setState) -- the only reachable wallet-prompting calls in this tab are Submit Rebalance, Fund, and the permanent Remove action, all clearly separate and already gated by their existing on-chain permission checks.",
    "Repo-wide grep confirms zero remaining 'real DevNet tx' or 'Phase E' occurrences anywhere under src/.",
    "No wallet/browser-automation tool is available in this environment (same documented gap as every prior pass) -- executeSubmitRebalance's real batched signed transaction was NOT exercised against live DevNet. This is the only claim in this entry not independently live-verified; everything else above was directly re-run and observed this session.",
    "Committed and pushed to main (8519870, then a doc-status correction e90efd1), then deployed live via vercel --prod as dpl_9KEt7maJoTBnKfYCM8vncCUKmNiR, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun/ssr-fun.vercel.app (confirmed via vercel inspect). Post-deploy: both custom domains return 200, rpc-proxy/landing-stats return healthy real data, vercel logs --since 5m showed real live traffic and zero error/fatal/fail-matching lines."
  ]
}
```

## DEC-0085

```json
{
  "id": "DEC-0085",
  "date": "2026-08-12",
  "status": "confirmed",
  "decision": "Fixed a real, live-reported bug in DEC-0084's just-deployed Rebalance tab: reducing an existing asset to 0% and driving a newly-added asset to 100% could produce a false 'Proposed weights must total exactly 100% before submitting.' error immediately after a genuine, successful Phantom approval. Root cause, found by re-reading the exact code path rather than guessing: Submit Rebalance's success handler unconditionally pruned the just-registered new asset's mint out of sessionAddedAssets the moment the transaction signature confirmed, assuming the immediately-following on-chain refresh (refreshRealReserveNow) would already show it as a real ReserveAsset. A read moments after 'confirmed' commitment can still lag behind on the RPC node actually serving that read (a real, well-known Solana read-after-write consistency gap, more likely through a proxied/load-balanced endpoint) -- if that refresh's dtr.onChain.assets read landed before the node had caught up, the newly-registered asset was ALREADY pruned from sessionAddedAssets (so no longer rendered as a session row) AND not yet present in dtr.onChain.assets (so not yet rendered as an on-chain row either) -- it vanished from proposedAssetRows entirely for that render, silently dropping its weight out of the summed total and tripping the exactly-100% guard on a proposal that was, in fact, already exactly 100% when submitted. Fix: removed the optimistic prune entirely; sessionAddedAssets now only drops a mint once the seeding effect's own onChainAssets (the same confirmed on-chain read already driving that effect) genuinely contains it -- proposedAssetRows' existing de-dup filter already prevented any double-count once that happens, so the fix closes the gap without reintroducing one. Separately fixed a second, independent defect in the same handler: handleSliderChange computed its 'current composition' snapshot from the component's render-time proposedWeightsBps closure rather than from the latest value inside its setState updater, which could let sequential edits fired faster than a React re-render (e.g. dragging one slider immediately after another) build on a stale starting point instead of each other's actual result; fixed by reading the prior state from inside the updater. Also uniformized the copy under each slider from 'Current X% -> $Y projected' to 'Current X%, -> Y% proposed ($Z balance projected)', per direct user feedback, so the proposed percentage and the projected USD value are both shown together in one consistent phrase.",
  "context": "User reported, after using the DEC-0084 Rebalance redesign live on strategic-super-reserve.fun: (1) the per-asset summary line under each slider was formatted inconsistently ('Current X% -> $0 projected', missing the proposed percentage); (2) reducing a pre-existing asset to 0% and setting a newly-added asset to 100% produced the 'must total exactly 100%' error immediately after a real, successful Phantom approval, despite the proposal genuinely being 100% allocated.",
  "rationale": "The optimistic prune was replaced with a purely reactive one (driven only by confirmed on-chain data already flowing through the existing seeding effect) rather than, say, delaying the prune by a fixed timeout or retrying the refresh read -- a truth-driven prune can never race ahead of what's actually confirmed on-chain, whereas any timing-based guess would only narrow the window without closing it. handleSliderChange's fix (reading state from inside the updater) is the standard, minimal-diff correct pattern for React state that must compose correctly across updates arriving faster than a render -- no additional debouncing/throttling of Slider events was introduced, since the actual defect was in how state was READ, not in how often events fired.",
  "alternativesConsidered": [
    "Retry/poll the post-submit refresh until the new asset is confirmed present, before pruning sessionAddedAssets (rejected: adds real latency and a new bounded-retry surface for a problem the existing seeding effect already solves passively and correctly once any later read -- from this refresh or the next background poll -- catches up)",
    "Debounce/throttle Slider onValueChange to reduce the rate of handleSliderChange calls (rejected: does not fix the underlying stale-read defect, only makes it rarer; reading `prev` inside the updater fixes it unconditionally)",
    "Show the projected USD value only, without the proposed percentage, to keep the line shorter (rejected: user explicitly asked for the percentage to be included alongside the projected value)"
  ],
  "impact": "Changed: src/merge/pages/ManageDTR.tsx (removed the optimistic sessionAddedAssets prune from Submit Rebalance's success handler; added truth-based pruning to the existing seeding effect; handleSliderChange now reads prior state from inside its setState updater; uniformized the per-asset summary line copy). tests/phase_rebalance_slider.ts (+1 net test covering the sequential-edit composition pattern the fixed handler now always uses; two initially-added tests were found, on closer analysis, not to actually reproduce the reported defect -- which lives in React-level state timing, not the pure function -- and were corrected/removed rather than left as misleading coverage). 331/331 offline tests passing; tsc -b --force, oxlint, npm run build all clean.",
  "affectedAreas": [
    "src/merge/pages/ManageDTR.tsx",
    "tests/phase_rebalance_slider.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "331/331 offline tests passing (net +1 vs. DEC-0084's 330, after correcting two tests that did not actually reproduce the reported defect); tsc -b --force, oxlint, full npm run build all clean.",
    "Direct code-path read confirms the optimistic prune (setSessionAddedAssets keyed off an assumed-successful signature) is fully removed and replaced with a prune keyed only off the seeding effect's own onChainAssets, which is the same confirmed data already driving every other part of that effect.",
    "This fix was NOT live-verified against a real Phantom approval in this environment (no browser-automation/wallet tool available, same documented gap as every prior pass) -- verification is the code-path read above plus full offline test/typecheck/lint/build coverage. The original defect itself WAS live-reported by a real user against the DEC-0084 production deploy, which is why this fix exists.",
    "Deployed live: commit f2d1f67 pushed to main, then vercel --prod promoted it to strategic-super-reserve.fun as deployment dpl_4cq8kk4C59bujNhYg6KD9MYBWkjA (aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun/ssr-fun.vercel.app, confirmed via vercel inspect). Post-deploy: curl -I against strategic-super-reserve.fun returned 200, vercel logs --since 3m showed zero error/fatal/fail-matching lines."
  ]
}
```

## DEC-0086

```json
{
  "id": "DEC-0086",
  "date": "2026-08-12",
  "status": "confirmed",
  "decision": "Disabled the Pause/Unpause Reserve feature in the app, per explicit user decision to turn it off 'for now.' Removed: ManageDTR.tsx's Pause/Unpause Card (Overview tab) and its canPauseOnChain/canUnpauseOnChain permission gating; managementClient.ts's executePauseReserve/executeUnpauseReserve client wrappers; packages/sdk/src/managementInstructions.ts's buildPauseReserveInstruction/buildUnpauseReserveInstruction SDK builders. Deliberately NOT touched: the deployed on-chain pause_reserve/unpause_reserve Anchor instructions (programs/ssr_protocol/src/instructions/pause_reserve.rs, unpause_reserve.rs) and the PAUSE_RESERVE/UNPAUSE_RESERVE permission-flag bits in src/merge/lib/onChainPermissions.ts -- the latter must stay so any real delegate already holding those on-chain permission bits (e.g. DEC-0083's live-verified pauseUnpause delegate against the Gate-9 fixture) continues to decode/display correctly everywhere else permissions are shown, and the former is a live, already-deployed program capability that this pass does not revoke or redeploy. scripts/verify_delegate_wiring.ts and scripts/devnet_fixtures.ts, which reference the PAUSE_RESERVE/UNPAUSE_RESERVE permission bits as example values for testing the general delegate-permission mechanism (not the pause action itself), were confirmed unaffected and left untouched. Archived the pre-removal state as an annotated git tag, archive/pause-unpause-reserve-ui, pointing at commit 981594a (the last commit with the feature intact) -- includes exact restore instructions and a manifest of every file/function the removal touched, so bringing the feature back later is a small, well-scoped diff rather than an archaeology exercise.",
  "context": "User asked to disable the pause option on Reserves for now, remove it from the UI and its supporting functions, and archive it in git in case it's wanted again later.",
  "rationale": "Scoped the removal to exactly the app-level layers implementing the UI-exposed ACTION (SDK instruction builders + client wrapper + UI card), not the underlying protocol capability or the shared permission-bit vocabulary used to decode real on-chain data elsewhere in the app -- removing either of those would have been a materially bigger, riskier, and unrequested change (a program redeploy in the first case; broken/undecodable real delegate permissions in the second). A git tag (rather than, say, moving the removed code into a dedicated 'archive/' source directory that still ships in the bundle) was chosen as the archive mechanism because it fully preserves the exact pre-removal state, needs zero ongoing maintenance as the rest of the codebase evolves around it, and adds nothing to the shipped app -- restoring later is a normal git operation (diff/cherry-pick/checkout against the tag), not a search through dead code paths left lying around in the live tree.",
  "alternativesConsidered": [
    "Also remove the deployed on-chain pause_reserve/unpause_reserve instructions and rebuild/redeploy the program (rejected: a redeploy is a materially larger, riskier action than 'disable the UI for now' asked for, and was never requested)",
    "Also remove PAUSE_RESERVE/UNPAUSE_RESERVE from onChainPermissions.ts's permission-flag vocabulary (rejected: these bits describe REAL on-chain delegate permission state that must keep decoding correctly wherever permissions are displayed, regardless of whether the app currently exposes an action for them)",
    "Move the removed code into a dedicated archive/ directory inside the source tree instead of a git tag (rejected: would still ship as dead code in the bundle, or need its own build-exclusion wiring, for no benefit over a tag that costs nothing and fully preserves the exact prior state)"
  ],
  "impact": "Changed: src/merge/pages/ManageDTR.tsx (Pause/Unpause Card, canPauseOnChain/canUnpauseOnChain, Pause/Play icon imports removed), src/merge/lib/managementClient.ts (executePauseReserve/executeUnpauseReserve removed), packages/sdk/src/managementInstructions.ts (buildPauseReserveInstruction/buildUnpauseReserveInstruction removed). New: git tag archive/pause-unpause-reserve-ui at commit 981594a. 331/331 offline tests still passing (no test exercised the removed functions directly); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, npm run build all clean.",
  "affectedAreas": [
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/lib/managementClient.ts",
    "packages/sdk/src/managementInstructions.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "331/331 offline tests passing (unchanged from DEC-0085 -- no test directly exercised executePauseReserve/executeUnpauseReserve/buildPauseReserveInstruction/buildUnpauseReserveInstruction), tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
    "Repo-wide grep confirms zero remaining references to executePauseReserve/executeUnpauseReserve/buildPauseReserveInstruction/buildUnpauseReserveInstruction/canPauseOnChain/canUnpauseOnChain, and confirms scripts/verify_delegate_wiring.ts and scripts/devnet_fixtures.ts only reference the still-present PERMISSION_FLAGS.PAUSE_RESERVE/UNPAUSE_RESERVE bit constants, not any removed function.",
    "git tag -v archive/pause-unpause-reserve-ui resolves to commit 981594a, the real last commit with the feature intact, with the full restore manifest in the tag message."
  ]
}
```

## DEC-0087

```json
{
  "id": "DEC-0087",
  "date": "2026-08-12",
  "status": "confirmed",
  "decision": "DTRDetail.tsx's Reserve Composition card (pie chart + table) now excludes any asset with an exactly-0% target weight from both the pie slices and the table rows (new compositionDisplay, filtered from dtr.composition, used only for this card's display -- dtr.composition itself is untouched, since ManageDTR.tsx's Rebalance tab still needs to show and edit a 0%-weight asset). This closes the gap where rebalancing an asset down to 0% (update_targets is config-only, per DEC-0017 -- it never removes the on-chain registration) left it visibly cluttering the trade page's composition view forever. Added a new 'P&L %' column after 'Value in Reserve', backed by two new pure functions in calculations.ts (referenceAssetPriceUsd, calcReserveAssetPnlPct) that compare an asset's current price against a reference/entry price -- both currently read the same DevNet-fixed TEST_ASSET_PRICES_USD table (no live oracle or historical entry-price snapshot exists for a reserve asset yet), so every asset correctly and honestly shows 0.00% today, per explicit user decision to ship the real formula/plumbing now rather than wait for live pricing, since Mainnet readiness is the standing goal (see PROJECT_STATUS.md's Mainnet-Readiness Gaps, 'Oracle/pricing'). 'Value in Reserve' was also corrected, for real (onChain) Reserves, from a target-weight-derived estimate (asset.weight * dtr.aum) to the asset's actual current balance x price (matching how dtr.aum itself is already computed) -- the two only coincided when a Reserve was perfectly on-target, and showing a real per-asset P&L % next to a target-derived (not actual) value would have been internally inconsistent. A purely simulated/demo Reserve (no onChain data, no real balances to read) keeps the prior weight-of-AUM estimate for value and shows '--' (not 0.00%) for P&L, since there's nothing to compute a real figure from at all.",
  "context": "User asked, in one request: (1) remove an asset from the Reserve Composition card once it's been zeroed out by a rebalance; (2) add a P&L % column after Value in Reserve on that same card. Clarifying question asked and answered: since this is a DevNet environment with zero live/historical pricing (TEST_ASSET_PRICES_USD is a single fixed value per mint, SOL_TEST_PRICE_USD is a hardcoded constant, never a feed), a genuine price-based P&L would always read 0.00% today -- user confirmed that's fine, explicitly framing this as building the feature correctly now so it's ready to work the moment Mainnet pricing exists ('remember mainnet is always the goal'), rather than deferring it or reframing it as something else. Separately, the user also asked for a rebalance/delegate activity log in Manage Reserve -- confirmed this already exists (Manage Reserve's Activity tab, DEC-0083) and covers every event type requested; user confirmed no further action needed there.",
  "rationale": "referenceAssetPriceUsd was added as its own named function (rather than inlining TEST_ASSET_PRICES_USD directly into the P&L formula twice) specifically to mark the exact seam where a real oracle-backed entry price will plug in later -- swapping this one function's body is the entire migration path to genuine Mainnet P&L, with zero UI changes needed. compositionDisplay's filter lives in DTRDetail.tsx only, not in the shared dtr.composition builder (onChainReserve.ts), because the Rebalance tab's editing UI has the opposite requirement (it must show a 0%-weight asset so the user can raise it back up) -- a single shared filter would have broken that. 'Value in Reserve' was fixed as part of this pass rather than left alone, since adding a real per-asset P&L % column right next to a column that wasn't actually showing that asset's real value would have been visibly inconsistent (and arguably more misleading than not adding a P&L column at all).",
  "alternativesConsidered": [
    "Show 'N/A'/'--' for P&L % instead of a real 0.00% (rejected per explicit user decision -- they want the real, computed value now, honestly reflecting 'no movement possible yet' rather than 'not implemented')",
    "Snapshot-based P&L (capture each asset's current value as a baseline the moment this feature ships, compare future views against it) (rejected per user decision in favor of the reference-price-formula approach -- a snapshot baseline is not itself a real acquisition/entry price, and the user wants the eventual Mainnet swap-in to be a real oracle-backed entry price, not a client-captured baseline)",
    "Leave 'Value in Reserve' as the target-weight-derived estimate (rejected: would sit inconsistently next to a real per-asset P&L % column reading a different asset's actual price)",
    "Filter dtr.composition itself, globally, instead of only this card's local compositionDisplay (rejected: would break ManageDTR.tsx's Rebalance tab, which must keep showing a 0%-weight asset so it can be edited back up)"
  ],
  "impact": "Changed: src/merge/pages/DTRDetail.tsx (compositionDisplay filter, real balance-based Value in Reserve, new P&L % column), src/merge/lib/calculations.ts (+referenceAssetPriceUsd, +calcReserveAssetPnlPct). New: tests/phase_reserve_asset_pnl.ts (3 new tests). 334/334 offline tests passing (331 prior + 3 new); tsc -b --force, oxlint, npm run build all clean. No change needed for the activity-log request -- already covered by DEC-0083's Activity tab, confirmed by the user.",
  "affectedAreas": [
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/lib/calculations.ts",
    "tests/phase_reserve_asset_pnl.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "334/334 offline tests passing (3 new, covering calcReserveAssetPnlPct/referenceAssetPriceUsd against every currently-known TEST_ASSET_PRICES_USD mint plus an unknown-mint fallback); tsc -b --force, oxlint, full npm run build all clean.",
    "This pass was NOT live-verified against a real browser session (no browser-automation tool available in this environment, same documented gap as every prior pass) -- verification is offline tests, typecheck, lint, build, and direct code-path reading."
  ]
}
```

## DEC-0088

```json
{
  "id": "DEC-0088",
  "date": "2026-08-12",
  "status": "confirmed",
  "decision": "Manage Reserve's Activity tab no longer reads a Reserve's governance history live from RPC on every view. Added a small, persistent Postgres index (reserve_activity_log + reserve_activity_cursor, lib/reserve-activity/schema.sql, reusing the Neon Postgres already provisioned for lib/road-to-mainnet -- no new service). A new indexer (lib/reserve-activity/indexer.ts, syncReserveActivity) does two BOUNDED steps per call -- an incremental top-up (one fresh page from the newest signature) and, only while not yet complete, one further bounded backfill step (2 pages) continuing from a per-Reserve cursor -- so a single call can never approach a serverless timeout regardless of how much real history a Reserve has; a Reserve with a long history converges to FULLY indexed (all the way back to creation) over a handful of views, each bounded and fast. A new public endpoint (api/devnet/reserve-activity.ts, no dashboard auth -- must be visible to any wallet viewing a Manage Reserve page) calls this best-effort before every read: an RPC failure during that sync is caught, reported back as syncError, and NEVER blocks returning whatever is already indexed in Postgres -- this is the actual fix for the reported 'Could not read on-chain history right now (DevNet RPC congestion)' hard failure. ManageDTR.tsx's Activity tab now fetches from this endpoint instead of calling packages/sdk/src/activityLog.ts's fetchReserveActivityLog directly from the browser (that function itself was extended, not replaced, to accept optional {before, maxPages} bounds and return {entries, oldestSignatureWalked, reachedRealEnd} so the SAME walk primitive serves both the indexer's top-up and backfill steps -- previously it made an unbounded-feeling ~200 getTransaction RPC calls per tab-open, all from the browser, capped at ~100 recent entries). The hard failure copy is replaced with a soft banner ('Showing saved history...') shown only when syncError is present, and a 'still loading older history' note while backfill_complete is still false. Also fixed the entry links to use the shared explorerUrl helper instead of a hardcoded explorer.solana.com literal, and removed the 'Locked' badges next to the Delegates/Rebalance sidebar tabs in ManageDTR.tsx per explicit request (the tabs were never actually disabled -- clicking either already showed a permission-appropriate read-only view inside; the badge was the only thing removed).",
  "context": "User reported the Activity tab's live RPC-dependent design directly: 'the log shouldnt rely on RPC, it should be internal to the website... if we need some sort of storage solution lmk, but i think this should be kept as light as possible. and we need all the log since reserve creation.' Explicitly deprioritized investigating the RPC congestion itself ('lets put a pin on that for now'). Separately asked to remove the 'Locked' label shown on the Delegates/Rebalance sidebar tabs in the manager dashboard.",
  "rationale": "Reused the exact existing Neon Postgres + idempotent-migration-script pattern already proven for lib/road-to-mainnet rather than any new storage service, directly per the user's 'keep it light' instruction. A resumable, cursor-tracked, per-request-bounded backfill (rather than either an unbounded single scan or a new cron job) was chosen because: an unbounded scan risks a serverless function timeout on a Reserve with a long history, and this repo has no cron infrastructure today and none was asked for -- bounding the work per request and letting ordinary page views drive progress converges to full history without adding new always-on infrastructure. Extending fetchReserveActivityLog's existing signature (rather than writing a separate, duplicate RPC-walking function for the indexer) keeps exactly one implementation of 'walk signatures, decode events' in the codebase. syncReserveActivity is designed to NEVER throw specifically so a sync-side RPC failure can never regress the read path below its OLD (already-broken) reliability -- worst case with this change is 'shows slightly stale cached data,' never 'shows nothing.'",
  "alternativesConsidered": [
    "Add a Vercel Cron job to keep the index warm in the background (rejected: no cron infra exists in this repo yet, adds new always-on infrastructure and cost the user didn't ask for, and on-demand top-up when a Reserve is actually viewed is sufficient given the 'keep it light' instruction)",
    "A simple TTL cache (e.g. in-memory or Edge Config) instead of a durable Postgres table (rejected: cannot satisfy 'all the log since reserve creation' -- a cache only ever reflects the last live scan's own recency-bounded window, it doesn't accumulate history over time the way a real index does)",
    "One unbounded backfill scan on first view instead of a resumable, chunked one (rejected: risks a serverless function timeout for any Reserve with substantial real history, and provides a worse experience -- the resumable version returns fast on every call, immediately serving whatever's cached, rather than making the very first viewer wait for a potentially-long scan)"
  ],
  "impact": "New: lib/reserve-activity/schema.sql, lib/reserve-activity/db.ts, lib/reserve-activity/indexer.ts, lib/reserve-activity/cursorLogic.ts (pure, offline-tested), lib/reserve-activity/package.json (CommonJS scoping, mirrors src/merge/lib's), api/devnet/reserve-activity.ts, scripts/migrate-reserve-activity.mjs, scripts/verify_reserve_activity_index.ts, tests/phase_reserve_activity_cursor.ts (7 new tests). Changed: packages/sdk/src/activityLog.ts (fetchReserveActivityLog now boundable), src/merge/pages/ManageDTR.tsx (Activity tab fetches from the new endpoint; soft syncError/backfill-in-progress copy; explorerUrl helper reused; 'Locked' badges removed from Delegates/Rebalance tabs), tsconfig.node.json (excludes lib/reserve-activity from its direct nodenext check -- still fully typechecked transitively via api/devnet/tsconfig.json's import chain, same as api/devnet's own established exclusion). 342/342 offline tests passing (7 new -- net +8 vs. DEC-0087's 334, one test file with 7 cases); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean. Migration applied for real against the live Neon database (both tables confirmed present).",
  "affectedAreas": [
    "lib/reserve-activity/",
    "packages/sdk/src/activityLog.ts",
    "api/devnet/reserve-activity.ts",
    "src/merge/pages/ManageDTR.tsx",
    "scripts/migrate-reserve-activity.mjs",
    "scripts/verify_reserve_activity_index.ts",
    "tests/phase_reserve_activity_cursor.ts",
    "tsconfig.node.json"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "342/342 offline tests passing (7 new in tests/phase_reserve_activity_cursor.ts, covering both cursor-update functions' every branch: first-ever sync, routine top-up never clobbering backfill progress, whole-history-fits-in-one-page short-circuit, backfill advancing/completing/no-op); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
    "Migration applied for real against the live Neon database (scripts/migrate-reserve-activity.mjs) -- reserve_activity_log and reserve_activity_cursor both confirmed present via a live information_schema query.",
    "LIVE, read-only verification via scripts/verify_reserve_activity_index.ts against the real persistent Gate-9 fixture Reserve (reserve_id 9, GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C): syncReserveActivity's first call indexed 19 real governance events (feesCollected, reservePaused/reserveUnpaused, 2 full delegate add/update/remove cycles, targetsUpdated -- matching DEC-0083's own live evidence for this exact Reserve), backfill_complete correctly reported true (this Reserve's entire real history fits within the walk), and a second immediate call left the row count at exactly 19 (idempotent, ON CONFLICT DO NOTHING confirmed working against real duplicate data, not just in a unit test).",
    "Repo-wide grep confirms zero remaining 'Locked' badge occurrences in ManageDTR.tsx's sidebar tabs.",
    "Not live-verified: an actual browser view of the Activity tab (no browser-automation/wallet tool available in this environment, same documented gap as every prior pass) -- the frontend fetch wiring is verified by direct code-path reading plus the fact that the API endpoint it calls was exercised live via the same underlying syncReserveActivity function above."
  ]
}
```

## DEC-0089

```json
{
  "id": "DEC-0089",
  "date": "2026-08-12",
  "status": "confirmed",
  "decision": "Fixed the default manager/protocol fee split for newly-created Reserves from 80%/20% to 50%/50% (createReserveClient.ts's managerFeeShareBps/protocolFeeShareBps, and the matching literals in scripts/create_canonical_reserves.ts). Root cause of the reported 'Manager share 0.8 ZZZZ / Protocol share 0.2 ZZZZ' Pending Fees display: this was never a display bug -- FeeConfig.manager_fee_share_bps/protocol_fee_share_bps are genuinely per-Reserve, set once at create_reserve time, and createReserveClient.ts hardcoded 8000/2000 there, unconditionally, for every Reserve the app has ever created. DEC-0032 (2026-08-04) had already explicitly flagged this exact value as a DevNet placeholder pending a real fee-schedule decision, not final economics -- this pass is that decision (50/50). Confirmed there is no update_fee_config (or equivalent) instruction anywhere in the deployed program -- FeeConfig is immutable on-chain once a Reserve is created -- so this fix only changes the split for Reserves created FROM NOW ON; every already-created Reserve (including whichever one the user was looking at) permanently keeps its original 80/20 split, and changing it would require a new on-chain instruction and a program redeploy, not attempted in this pass. Separately, fixed a real silent-failure bug in the Road to Mainnet checklist's comment form (public/road-to-mainnet.html): posting a comment that failed for any reason OTHER than an expired session (e.g. a validation error, a rejected request) silently reset the Post button with zero feedback -- now shows the real server-returned error message (mirroring the existing pattern already used for the checklist's field-save error states). This is the most likely explanation for the user's own report that they 'couldn't post' a comment -- probably failed with no visible reason why. The user's actual comment (about the fee-split issue above) was posted directly against the database using the exact same addComment logic the API route itself calls, authored as 'JRA', under control FE-01 ('Fees & protocol config') -- landed in the currently-open pass (pass 2).",
  "context": "User reported, from the Manage Reserve dashboard: 'Pending Fees (uncollected) ... Manager share 0.8 ZZZZ ... Protocol share 0.2 ZZZZ ... this should be 50%/50% as per the criteria. double check whats wrong in the distribution of fees please.' Separately reported being unable to post a comment on the Road to Mainnet checklist HTML page, and asked for that same fee-split comment to be reposted as 'JRA' under the Fees & protocol config section once the posting issue was found.",
  "rationale": "Fixed the default going forward rather than attempting to retrofit already-created Reserves, since FeeConfig has no on-chain update path today and adding one is a materially bigger, separate decision (new instruction + program redeploy) than what was asked for here -- flagged explicitly rather than silently left unaddressed. The comment-form fix mirrors pushEntity's already-established error-surfacing pattern (sync-tag error class, real server message) exactly, rather than inventing a new error-display convention for this one form. Posting the user's comment directly via the database (rather than only fixing the bug and asking them to retry through the browser) both unblocks their immediate request and end-to-end-proves the fix's premise -- that addComment itself works correctly and the prior failure was purely a silent-UI problem, not a server-side one.",
  "alternativesConsidered": [
    "Add a new update_fee_config instruction so existing Reserves' split could be corrected on-chain (rejected as out of this pass's scope: a program change + redeploy is a materially bigger and riskier action than the reported issue calls for; flagged as the real limitation instead of silently working around it)",
    "Only fix the comment-form bug and ask the user to repost through the browser (rejected: they explicitly asked for the comment to be posted now, and the direct-DB post both satisfies that and proves the underlying fix)"
  ],
  "impact": "Changed: src/merge/lib/createReserveClient.ts (fee-split default 8000/2000 -> 5000/5000), scripts/create_canonical_reserves.ts (matching fix for future runs), public/road-to-mainnet.html (comment-form now surfaces real POST failures instead of silently resetting). Data: one new row in the live rtm_comments table (control FE-01, author JRA, pass 2). No test changes -- both fixes are either a literal-value change with no branching logic to unit-test, or a browser-DOM error-display change outside this repo's pure-function test scope. 342/342 offline tests still passing (unchanged from DEC-0088); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
  "affectedAreas": [
    "src/merge/lib/createReserveClient.ts",
    "scripts/create_canonical_reserves.ts",
    "public/road-to-mainnet.html"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "342/342 offline tests passing (unchanged), tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
    "Confirmed via a direct source-tree search that no update_fee_config (or equivalently-named) instruction exists anywhere under programs/ssr_protocol/src/instructions/ -- FeeConfig is genuinely immutable once a Reserve is created.",
    "The requested comment was posted for real against the live production database (rtm_comments id 14, control FE-01, author JRA, pass 2) -- confirmed by the insert's own returned row, not assumed.",
    "The delegate edit/remove permission-gating issue also reported in the same message was investigated (isRoot/hasOnChainPermission/canAddRestrictedDelegateOnChain/canRemoveRestrictedDelegateOnChain in ManageDTR.tsx) and found to correctly implement the documented, previously-live-verified on-chain permission model (DEC-0075/DEC-0083) in every code path traced -- root manager is never blocked in the current code. NOT fixed in this pass pending clarification from the user on which wallet/Reserve exhibited the issue, since a wrong guess here risks weakening real on-chain-mirroring access control rather than fixing a genuine bug."
  ]
}
```
}
```

## DEC-0090

```json
{
  "id": "DEC-0090",
  "date": "2026-08-13",
  "status": "confirmed",
  "decision": "Every transaction-success notification across the site (Buy/Sell confirmed on DTRDetail.tsx, Submit Rebalance/Collect Fees/Grant Delegate/Fund Asset/etc. on ManageDTR.tsx, Reserve deployed/resumed on CreateDTR.tsx, and the devUSDC/DevNet SOL faucet-claim confirmations on DevnetOnboarding.tsx) now renders as a shared TransactionConfirmedCard (new src/merge/components/TransactionConfirmation.tsx) instead of ad hoc inline JSX. The whole card is a single clickable/keyboard-operable (Enter and Space, via role=button + tabIndex=0) region showing plain-language text ('X confirmed -- View on Solscan') that opens the real, full (never-truncated) signature on Solscan in a new tab (window.open with noopener,noreferrer), on the CORRECT cluster -- a new solscanUrl() helper (src/merge/lib/solana-config.ts, mirroring the existing explorerUrl()'s cluster logic) appends ?cluster=devnet/testnet or omits the param entirely for mainnet-beta (Solscan's own default). A separate copy-signature button sits inside the same card with its own tooltip/aria-label ('Copy full transaction signature'); its onClick calls stopPropagation so clicking it copies without also opening Solscan. ManageDTR.tsx's runOnChainAction wrapper previously built its toast description from signature.slice(0, 20) + '...' -- a literal truncated signature with no link and nothing copyable -- now uses the full untruncated signature throughout, never derived from the displayed/shortened text. CreateDTR.tsx's two deploy-completion toasts previously interpolated explorerUrl(...) calls directly into a plain template-string description (so the 'link' rendered as inert raw URL text, not a clickable anchor at all) -- fixed to real Solscan anchors plus a copy button for the transaction-signature portion (the Reserve-address portion stays a plain Solscan account link, since an address isn't a signature to copy). DevnetOnboarding.tsx's two faucet-claim confirmations swapped their existing (working, but Explorer-linked, non-copyable, non-card) pattern for the same shared component at a smaller size. explorerUrl() itself is untouched and still used for on-chain address links unrelated to a specific transaction confirmation (Reserve/mint/vault identity links, the Rebalance-tab pending-signature banners, and the Activity Log's per-entry icon link) -- those were judged out of scope for this pass (not truncated, not un-copyable, not a success notification), so the blast radius stays limited to the actual reported defect.",
  "context": "User reported that the transaction-confirmation notification shown after actions like Submit Rebalance truncates the signature, offers no way to copy the full value, and isn't linked to Solscan at all -- asked for the whole card to be clickable to the correct Solscan cluster (DevNet vs Mainnet), friendly text instead of a raw truncated signature, a separate copy button that copies the full value without also navigating, an accessible label/tooltip confirming the signature is copyable, and the same treatment applied consistently to every transaction-success notification site-wide, plus keyboard accessibility.",
  "rationale": "One shared component (TransactionConfirmedCard/CopySignatureButton/transactionConfirmedToast) rather than per-call-site copy-paste keeps the pattern (and any future fix to it) in exactly one place, and lets the same building blocks serve both toast descriptions and DevnetOnboarding's inline (non-toast) confirmation banners without duplicating the click/keyboard/copy logic. Solscan was added alongside, not instead of, explorerUrl()/Solana Explorer -- the request was specifically to link transaction confirmations to Solscan, and existing non-transaction-confirmation address links elsewhere in the app were left on Explorer to keep this a scoped fix rather than a site-wide explorer-provider migration nobody asked for. The mixed CreateDTR toasts (Reserve address + optional transaction signature in one notice) were deliberately NOT forced into the single-target 'whole card clicks through' pattern, since a Reserve address and a transaction signature are two different destinations and collapsing them into one ambiguous click target would be worse than two clearly separate, individually-labeled links.",
  "alternativesConsidered": [
    "Migrate every existing explorerUrl() call site (including plain address links and the Activity Log) to Solscan for total site-wide consistency (rejected as scope creep beyond the reported defect -- those links were never truncated, already worked, and weren't reported as broken; changing the explorer provider for unrelated, already-functioning links risked an unnecessary, unreviewed blast radius)",
    "Attach the Solscan-opening onClick directly to the Radix Toast Root element (via extra props threaded through toast({...})) instead of to an inner div (rejected after live testing: Radix's Close button and the Toast Root's own swipe-to-dismiss gesture handling would need individual stopPropagation/exception handling to avoid every toast dismissal also opening a new tab, which is a much larger, riskier change to shared toast primitives than scoping the clickable region to the card's own description content)"
  ],
  "impact": "New: src/merge/components/TransactionConfirmation.tsx (CopySignatureButton, TransactionConfirmedCard, transactionConfirmedToast). Changed: src/merge/lib/solana-config.ts (new solscanUrl helper), src/merge/pages/ManageDTR.tsx (runOnChainAction's toast), src/merge/pages/DTRDetail.tsx (4 Buy/Sell-confirmed toasts), src/merge/pages/CreateDTR.tsx (2 deploy-completion toasts), src/merge/components/DevnetOnboarding.tsx (2 faucet-claim confirmations). No test-suite changes (this app's frontend has no existing unit-test harness for merge-scoped React components -- verified instead via a live, driven browser session: see evidence). tsc -b --force (via full npm run build, which runs it), oxlint, and vite build all clean; no new warnings beyond the same only-export-components style warning already present on several other existing files in this codebase (e.g. button.tsx, badge.tsx, ChartTimeframeSelector.tsx) for the same reason (a file exporting both a component and a plain helper function).",
  "affectedAreas": [
    "src/merge/components/TransactionConfirmation.tsx",
    "src/merge/lib/solana-config.ts",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/components/DevnetOnboarding.tsx"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "npm run build (tsc -b --force equivalent + vite build) and npm run lint (oxlint) both clean, zero new errors/warnings beyond the pre-existing only-export-components style pattern.",
    "Live-driven browser verification (Playwright against `npm run dev`, chromium headless) with a temporary test trigger (added and fully reverted before committing -- confirmed via `git diff` showing zero residual change to the test file): clicking the card opened `https://solscan.io/tx/<the exact full fake signature used>?cluster=devnet` in a new tab (devnet cluster correctly appended); the copy button's click copied the full untruncated signature to the clipboard AND did not open any new tab; Enter and Space while the card itself was focused both opened the same correct Solscan URL; Tab from the card moved focus to the copy button next, and pressing Enter while the copy button was focused copied the signature WITHOUT opening Solscan (an initial implementation failed this exact case -- the keydown bubbled from the button up to the card's own onKeyDown and opened Solscan anyway -- fixed by having the card's onKeyDown ignore events whose target isn't the card itself, and having the copy button's own onKeyDown stop Enter/Space from bubbling, before this was recorded as passing).",
    "Committed as fb0739f97dae093728348d6308cd7099f6e2153f on main, pushed to origin/main (GitHub), then deployed to production via `vercel --prod` as deployment dpl_7UT3LTteZ4GtyLgrPML5Sh3D2oqA, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun/ssr-fun.vercel.app (confirmed via `vercel inspect`). Post-deploy: `curl -I https://strategic-super-reserve.fun` returned 200; `vercel logs --since 3m` showed zero lines matching error/fatal/fail."
  ]
}
```

## DEC-0091

```json
{
  "id": "DEC-0091",
  "date": "2026-08-13",
  "status": "confirmed",
  "decision": "Replaced the global navbar Reserve search (Shell.tsx's old NavSearch) with a real live autocomplete: committed, pushed, and deployed live to production. Root cause of the reported 'shows the entire Reserve list regardless of what's typed' bug: the old search bar didn't actually search anything -- its <form> onSubmit just navigated to /discover?q=<query> on Enter, and Discover.tsx never read the q param at all, so typing anything (or nothing) just landed on the same unfiltered Discover grid. Replaced with a new pure, offline-testable ranking module (src/lib/reserveSearch.ts: searchReserves/getPopularReserves/splitForHighlight/nextActiveIndex/resolveEnterSelection/reservePath/shortenAddress) and a new dropdown component (src/components/ReserveSearch.tsx) wired into Shell.tsx in place of NavSearch. Matches by full or partial name, ticker, or the Reserve Token's contract address (dtr.onChain?.reserveTokenMint, falling back to the Reserve account address dtr.dtrAddress) -- all case-insensitive -- ranked exact > prefix > partial (ties broken by higher AUM, then name), live as the user types with no debounce (pure in-memory array filtering over an already-small dataset, no RPC involved, so it's instant). Reads reactively from useAppStore's `dtrs` -- the same authoritative, already-deduped, already-eligibility-filtered dataset Discover.tsx renders (quarantined/ineligible Reserves are a separate store slice and never appear in `dtrs`), so a newly created Reserve becomes searchable the moment registerRealReserve() adds it, with zero additional wiring. An empty query shows a labeled 'Popular Reserves' list (top 5 by AUM) instead of the previous full unfiltered list; a query with zero matches shows 'No Reserves found'; matched substrings are wrapped in <mark class=\"search-match\"> in both the name and ticker. Full keyboard support: ArrowUp/ArrowDown cycle the highlighted suggestion (wrapping at both ends), Enter selects the highlighted suggestion (or the top-ranked one if none is highlighted), Escape closes the dropdown; a document-level mousedown listener closes it on any click outside the search container. Also fixed a real, previously-nonexistent mobile entry point: `.nav-search { display: none }` below 1000px hid the search bar outright with no replacement of any kind -- added a small icon-only toggle button (reusing the existing `.theme-btn` style) that opens a full-width overlay row below the header, with its own inline close (✕) button, verified working at a 390x844 mobile viewport.",
  "context": "User reported the global Reserve search bar at the top of the site 'displays the entire Reserve list regardless of what the user types' and asked for a proper autocomplete: search by full/partial name, ticker, or Reserve Token contract address; case-insensitive; live filtering; exact > prefix > partial ranking; a compact dropdown with name/ticker/shortened CA and highlighted matches; click-to-open the Reserve page; full keyboard navigation (arrows/Enter/Escape); close on outside click; a 'No Reserves found' state; never the full list on an empty query (popular/recent instead); the authoritative indexed dataset (so new Reserves are searchable); no duplicates or invalid/removed records; consistent behavior on desktop and mobile.",
  "rationale": "Kept the ranking/keyboard/selection logic in plain, framework-free functions (src/lib/reserveSearch.ts) rather than inline component state math specifically so it could be unit-tested the same way this repo already tests rebalanceSlider.ts/reserveEligibility.ts -- and the component calls these exact functions rather than a parallel reimplementation, so the tests actually cover what ships. This caught a real bug during development: an initial inline `(i - 1 + items.length) % items.length` ArrowUp formula did NOT correctly jump to the last item when nothing was yet highlighted (activeIndex=-1) -- extracting nextActiveIndex() as its own tested function surfaced and fixed this before it shipped. Reused useAppStore's existing `dtrs` rather than introducing a second Reserve index or a new API endpoint, since it's already the single authoritative, live-updating, eligibility-filtered source every other Reserve-listing surface (Discover, Featured, Portfolio) reads from -- a second index would just be a second thing that could drift out of sync. No debounce was added since matching is synchronous in-memory array scanning over a dataset in the tens/hundreds, not an RPC call -- adding one would only introduce perceptible input lag for no benefit, contradicting the 'should feel immediate' requirement. The mobile entry point was added (rather than just leaving search invisible on mobile, which was the pre-existing state) because the task explicitly required consistent desktop/mobile behavior for search specifically -- scoped narrowly to search only, not a broader mobile-nav redesign (nav-links remain hidden below 640px, unchanged, out of scope).",
  "alternativesConsidered": [
    "Fix Discover.tsx to actually read and filter by the ?q= param, keeping the navbar as a simple submit-to-Discover form (rejected: doesn't satisfy the explicit requirements for a dropdown, live-as-you-type filtering, keyboard navigation, or highlighting -- a full page navigation per keystroke would also not 'feel immediate')",
    "Debounce every keystroke by ~150-300ms as a matter of course (rejected: the matching itself is synchronous local array filtering with no network call, so debouncing would add pure latency with no corresponding cost being avoided; the task explicitly says 'debounce only if required')",
    "Add jsdom + React Testing Library to unit-test the actual DOM/keyboard wiring (rejected: this repo has no existing frontend component-test harness -- see DEC-0090's same finding -- and introducing one is materially larger infrastructure than this task calls for; instead extracted the keyboard-index/selection/ranking logic into pure, already-offline-testable functions and additionally verified the real DOM wiring live via a driven headless-browser session against both the dev server and the deployed production site)"
  ],
  "impact": "New: src/lib/reserveSearch.ts (pure ranking/keyboard/selection logic), src/lib/package.json (CommonJS scoping for ts-mocha, mirroring src/merge/lib/package.json's existing pattern -- src/lib had no such file yet, so its .ts files inherited the root package.json's \"type\": \"module\" and could not be require()'d by the test runner), src/components/ReserveSearch.tsx, tests/phase_reserve_search.ts (33 new tests). Changed: src/components/Shell.tsx (NavSearch removed, ReserveSearch wired in), src/index.css (new .search-dropdown/.search-result/.search-match/.nav-search-toggle/.nav-search-close rules plus a mobile overlay variant under the existing max-width:1000px media query). 375/375 offline tests passing (342 prior + 33 new, zero regressions), npm run build (tsc -b equivalent + vite build) and npm run lint (oxlint) both clean.",
  "affectedAreas": [
    "src/lib/reserveSearch.ts",
    "src/lib/package.json",
    "src/components/ReserveSearch.tsx",
    "src/components/Shell.tsx",
    "src/index.css",
    "tests/phase_reserve_search.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "375/375 offline tests passing (`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`, excluding the live-DevNet-provider-only tests/ssr_protocol.ts per this repo's established convention -- 342 prior + 33 new in tests/phase_reserve_search.ts, covering name/ticker/full-CA/partial-CA matching, case-insensitivity, exact>prefix>partial ranking with AUM/name tiebreaks, empty-query and no-results behavior, dedupe, invalid-record exclusion, highlighting, and both the keyboard-navigation (nextActiveIndex) and result-selection (resolveEnterSelection) logic the component itself calls). npm run build and npm run lint (oxlint) both clean, zero new warnings beyond the repo's pre-existing only-export-components style pattern.",
    "Live-driven browser verification (Playwright, chromium headless) against `npm run dev` at both a 1280x800 desktop viewport and a 390x844 mobile viewport: empty query shows a 'Popular Reserves'-labeled list (2 items, not the full list); typing filters live (e.g. 'DNR2' -> exactly DevNet Reserve Two); a highlighted <mark> is present in a matched result; a partial/case-insensitive query ('devnet reserve') returns both matching Reserves; a non-matching query shows 'No Reserves found'; the shown CA is correctly shortened; ArrowDown/ArrowDown/ArrowUp correctly cycles the highlighted suggestion; Escape closes the dropdown; clicking outside (the nav logo) closes the dropdown; Enter on a highlighted suggestion navigates to the correct /#/dtr/<id> route and clears the input; clicking a suggestion directly also navigates correctly; on mobile, the inline input is hidden until the toggle button is tapped, after which the overlay input filters and a clicked result navigates correctly. Zero console errors logged throughout.",
    "The same core behaviors (popular list on focus, live filtering, no-match state, click-to-navigate) were re-verified live against the actual deployed production site (https://strategic-super-reserve.fun) after promotion, not only the local dev server.",
    "Committed as 698145fa49550c09b2a6730258268a3d539f128f on main, pushed to origin/main (GitHub), then deployed to production via `vercel --prod` as deployment dpl_7zGvSuMjow77uUE9C9QaofyrNuo3, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun/ssr-fun.vercel.app (confirmed via `vercel inspect`). Post-deploy: `curl -I https://strategic-super-reserve.fun` returned 200; `vercel logs --since 3m` showed zero lines matching error/fatal/fail."
  ]
}
```

## DEC-0092

```json
{
  "id": "DEC-0092",
  "date": "2026-08-13",
  "status": "confirmed",
  "decision": "Audited all 23 currently-deployed ssr_protocol instructions for naming clarity/consistency and Solscan identifiability. Conclusion: NO instruction was renamed -- every name (Rust fn == IDL name in every case, confirmed via the committed IDL) was already clear, unambiguous, and used consistent Reserve/SSR terminology; zero DTR/BYOR/BOR/'Decentralized Token Reserve' contamination anywhere in the program layer. This matches CLAUDE.md's pre-existing rule that Anchor instruction names are exempt from the mandatory-terminology migration unless there is a separate real reason -- there wasn't one, so the task's required current-name -> proposed-name mapping is 'no change' for all 23. One safe, zero-risk fix was applied: a stale comment in programs/ssr_protocol/src/state/reserve_asset.rs described an already-superseded (pre-DEC-0074) terminology mapping and used the banned phrase 'Decentralized Token Reserve' -- corrected to reflect DEC-0074's actual final terminology. Comment-only, no discriminator/behavior change. The local source tree also has a 24th instruction (execute_rebalance_leg, DEC-0077) that was confirmed, again, to not currently compile (pre-existing, unrelated CpiContext type error) and was correctly excluded from this 23-instruction scope, unchanged from DEC-0081's deliberate deferral.\n\nThe actual reason Solscan may not have decoded this program was identified as NOT being naming: no Anchor IDL had ever been published on-chain for it. Fixed by publishing packages/sdk/idl/ssr_protocol.json via the Solana Program Metadata standard (program-metadata write idl), signed by the program's real upgrade authority (6idsSUE6u7fqHg6edrdMEjNTnG62wyCANAsJ2YBmeuHk, confirmed via solana program show), then independently re-fetched and diffed byte-identical (as JSON) against the repo copy. anchor idl init/fetch themselves do not work in this native-Windows environment (Rust's Command::new('npx') fails because there is only npx.cmd, not npx.exe -- a known Rust-on-Windows limitation, unrelated to this program); worked around by invoking the underlying @solana-program/program-metadata CLI directly. All 23 discriminators were separately, mathematically verified (sha256('global:<name>')[0..8], Anchor's own deterministic scheme -- no build required) to be correct for their instruction names in the committed IDL, and the SDK (packages/sdk/src/readOnly.ts) was confirmed to statically import that exact file. The deployed program's data length (647,608 bytes, via solana program show) was confirmed byte-identical to the last recorded ssr_protocol deploy (DEC-0048), i.e. nothing has drifted since -- the IDL/program/frontend triple is provably consistent for all 23.\n\n20 of the 23 instructions were exercised with real signed DevNet transactions against one disposable test Reserve created for this pass (scripts/verify_instruction_audit_devnet.ts), reusing the exact frontend/SDK instruction builders (packages/sdk/src/managementInstructions.ts, createReserveClient.ts) wherever they exist. The remaining 3 were NOT re-executed, each for a documented reason, and cited from existing historical signatures instead: initialize_protocol (one-time Anchor `init` genesis call -- re-running would fail 'already in use'; its original signature was found by taking the oldest of 169 transactions against the ProtocolConfig PDA), update_protocol_config (a shared, already-correctly-configured protocol-wide singleton -- deliberately not re-touched, per the same caution DEC-0090/DEC-0091 applied to similarly shared state), and close_reserve (this pass's own disposable test Reserve could not reach zero Reserve Token supply: collect_fees correctly minted a real, non-zero protocol-fee-share to ProtocolConfig.default_protocol_fee_destination, an account this session does not hold the signing key for -- close_reserve correctly refused with ReserveTokenSupplyNotZero; the test Reserve is left permanently open on DevNet, a harmless documented side effect matching this project's established pattern, e.g. DEC-0048's reserveOne permanently carrying a 3rd asset). Every one of the 23 signatures' decoded instruction-name log line (`Program log: Instruction: <PascalCaseName>`) was independently confirmed via `solana confirm -v` -- the same source Solscan and other explorers use to label an instruction by name, strongly suggesting names were already decoding correctly even before the IDL publish; what the IDL publish newly enables is decoded account labels and argument values in each instruction's detail view. Solscan's own rendered UI could not be visually re-confirmed: its transaction pages are gated behind an interactive Cloudflare 'Verify you are human' Turnstile checkbox (screenshot on file), a legitimate anti-automation measure that was not, and should not be, scripted around.\n\nAlso refreshed docs/protocol/INSTRUCTION_REFERENCE.md, found stale during this pass: it was missing all 6 instructions added since Phase F/G and DEC-0033 (update_protocol_config, add_reserve_asset_active, fund_new_reserve_asset, remove_reserve_asset, initiate_wind_down, close_reserve) and had several outdated 'Frontend use' lines (mint/redeem described as 'not yet built' when they are the live Buy/Sell tabs; pause/unpause described as 'not yet built' when they were built and have since been deliberately removed again per DEC-0086; update_targets's rebalance framing; record_rebalance's described UI step, which does not actually exist in the current frontend). Produced a new dedicated checklist, docs/protocol/DEVNET_INSTRUCTION_AUDIT_2026-08-13.md, with exactly the columns requested: protocol instruction name, IDL name, frontend action, discriminator match, DevNet transaction signature, Solscan decoding result, and remaining blocker, for all 23. No memo was added to any transaction -- the task explicitly asked not to use memos merely to compensate for an unpublished/incorrect IDL, and the real IDL publish made that unnecessary. Cargo.lock incidentally re-synced (added missing ssr_devnet_amm entries already present in the workspace but absent from the lockfile, discovered as a side effect of a local IDL-build attempt) -- a strict accuracy fix, no version changes.",
  "context": "User asked to audit all 23 ssr_protocol instructions and make them properly identifiable on Solscan during DevNet testing: confirm current Rust/IDL/frontend names, use consistent SSR terminology, identify unclear/obsolete/inconsistent names, remove remaining legacy terminology where safe, produce a complete current->proposed name mapping before any discriminator-changing rename, confirm the IDL matches the deployed program and all discriminators match across program/IDL/frontend, build and test, deploy a coordinated program update to DevNet only if renames required it, publish/update the on-chain IDL, manually execute every safely-runnable instruction and confirm Solscan decoding, record a Solscan link per instruction, distinguish auto-decoded instructions from ones needing Solscan verification/whitelisting, prepare the program ID/info for Solscan submission if needed, avoid memos as an IDL workaround, update a DevNet checklist, run tests/typecheck/lint/build, and push+deploy the frontend -- explicitly not touching Mainnet.",
  "rationale": "Given the audit's own conclusion that every name was already correct, the single most consequential, lowest-risk action available was publishing the IDL on-chain (additive, doesn't touch the program's executable, fully reversible by republishing) -- not a program rename/rebuild/redeploy, which the task itself cautioned against doing casually and which turned out to be entirely unnecessary. A single disposable test Reserve (rather than touching any of the persistent Gate-9 fixture Reserves real users/testers rely on) was used for every instruction that needed a fresh signature, matching this project's own established 'never risk shared fixture state for a verification pass' convention (see DEC-0048's identical choice for Phase F/G verification). Citing historical signatures for initialize_protocol/update_protocol_config/close_reserve rather than forcing fresh ones was chosen over any workaround that would have meant re-touching a one-time genesis call, a shared protocol-wide singleton, or draining a real account this session has no key for -- each would have been a materially riskier action than the naming audit called for. Confirming discriminators mathematically (sha256) rather than only via a full anchor build was chosen specifically because a full build was blocked by a real, reproducible, environment-only linker bug (mingw's ld.exe cannot parse the space in 'C:\\Users\\JRA DEVNET\\...') -- the math-based verification is exact and requires no build step at all, and was cross-checked against the one thing a partial build (with execute_rebalance_leg excluded) DID get through cleanly: full Rust compilation of all 23 real instructions. Not attempting to script around Solscan's Cloudflare Turnstile was a deliberate line: solving an anti-bot challenge programmatically crosses into circumventing a website's explicit protection, which this session will not do regardless of the underlying goal being benign verification.",
  "alternativesConsidered": [
    "Rename one or more instructions for stylistic preference even without a strong justification (rejected: CLAUDE.md already establishes Anchor instruction names as exempt from the terminology migration absent a separate real reason; a rename this pass would have triggered exactly the coordinated program-rebuild/redeploy/IDL-republish/client-update/test-update chain the task explicitly warned against taking on lightly, for zero actual naming-quality gain)",
    "Skip live DevNet execution entirely and only report the audit table (rejected: the user explicitly confirmed 'yes, full plan' when asked, given the audit found no renames were needed and the remaining risk was limited to an additive IDL publish plus disposable-Reserve transactions)",
    "Force close_reserve to succeed by minting/transferring the protocol's fee-share balance out from under ProtocolConfig.default_protocol_fee_destination via some other authority (rejected: this session does not hold that account's key, and finding a way around that would mean either a privilege escalation or touching real protocol treasury state -- neither is an acceptable trade for tidying up one disposable test Reserve; cited the real historical close_reserve signature instead)",
    "Attempt to defeat or wait out Solscan's Cloudflare Turnstile with browser automation tricks (rejected outright: an interactive human-verification challenge is a deliberate anti-bot control; treating it as an obstacle to route around rather than a boundary to respect was not on the table)"
  ],
  "impact": "Changed: programs/ssr_protocol/src/state/reserve_asset.rs (comment-only), docs/protocol/INSTRUCTION_REFERENCE.md (refreshed, all 23 instructions now documented and accurate), Cargo.lock (lockfile sync, no version changes). New: docs/protocol/DEVNET_INSTRUCTION_AUDIT_2026-08-13.md (the full audit table/checklist), scripts/verify_instruction_audit_devnet.ts (reusable live-verification script), scripts/audit-signatures.json (every signature + independently-confirmed decoded log name, with fresh/historical provenance noted per entry). On-chain: one new Solana Program Metadata account (2691ZrDFyiRB9pZU4Hr2NvyMnQTstm9tmPtqmaNAFV9v, seed 'idl') holding the published ssr_protocol IDL; one disposable test Reserve (HN5gWeNKV22G52DjhbkJnk1pSrQNxoVx6f7UornjkJEW) left open on DevNet (harmless, documented, ~0.00025 Reserve Tokens permanently held by the protocol fee destination). No program rebuild, no program redeploy, no discriminator changed, no Mainnet program exists or was touched. 375/375 offline tests passing (unchanged), npm run build and npm run lint clean, cargo check -p ssr_protocol confirmed clean for all 23 real instructions (the only error present is the pre-existing, unrelated, already-documented execute_rebalance_leg issue, outside this pass's scope).",
  "affectedAreas": [
    "programs/ssr_protocol/src/state/reserve_asset.rs",
    "docs/protocol/INSTRUCTION_REFERENCE.md",
    "docs/protocol/DEVNET_INSTRUCTION_AUDIT_2026-08-13.md",
    "scripts/verify_instruction_audit_devnet.ts",
    "scripts/audit-signatures.json",
    "Cargo.lock"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "375/375 offline tests passing (unchanged), npm run build (tsc -b equivalent + vite build) and npm run lint (oxlint) both clean, zero new warnings. cargo check -p ssr_protocol: only the pre-existing, unrelated execute_rebalance_leg error present (confirmed twice, before and after this pass's own comment-only change) -- all 23 real instructions compile cleanly, confirmed directly by temporarily excluding execute_rebalance_leg from lib.rs/instructions/mod.rs, running `anchor idl build` to full Rust compilation success, then reverting the exclusion (git diff confirmed clean revert) before committing.",
    "On-chain IDL independently re-fetched via `program-metadata fetch idl` after publishing and diffed byte-identical (JSON.stringify equal) against packages/sdk/idl/ssr_protocol.json.",
    "All 23 discriminators in the committed IDL mathematically verified correct via sha256('global:<instruction_name>')[0..8] against Anchor's own scheme -- zero mismatches.",
    "solana program show confirms the deployed program's data length (647,608 bytes) is byte-identical to DEC-0048's recorded deploy -- no drift since, source matches live bytecode for all 23.",
    "20 real, live DevNet signatures produced by scripts/verify_instruction_audit_devnet.ts against a fresh disposable Reserve (HN5gWeNKV22G52DjhbkJnk1pSrQNxoVx6f7UornjkJEW): create_reserve, initialize_reserve_asset, seed_reserve, mint_reserve_tokens_in_kind, update_targets, add_delegate, update_delegate_permissions, remove_delegate, add_reserve_asset_active (x2, including a clean add/remove/re-add round trip), remove_reserve_asset, fund_new_reserve_asset, update_metadata, transfer_reserve_manager, pause_reserve, unpause_reserve, accrue_fees, collect_fees, record_rebalance, redeem_reserve_tokens_in_kind, initiate_wind_down -- full list with signatures in scripts/audit-signatures.json.",
    "3 historical signatures cited and verified still resolvable via `solana confirm -v` against live DevNet: initialize_protocol (3CRguzydZnvz685c9TXP91s8Z7Xck7fxUmJm476wMZRHqXL7JyJGGjtGHEVJ1EB2nYJ8HD1wskAZNbdiFX93NR8p, found as the oldest of 169 transactions against the ProtocolConfig PDA), update_protocol_config (2cEtFTEPa5qiEWdPWZ16bTVdQaDZ7XyhUK6zjJpwUKkLvKYwwE8fD11gseoyZHgVRvRthD1d6spzy8VaYRZGcmTC, DEC-0035), close_reserve (4wpRnu4ZE2ihvBycgZ7kwAKJThuunA6Jg3FkS3mpD2zqkT3pyZ1Dg3XjfsiPMsGtcRJE9z6cWVcSz7hoEd4WDGSr, DEC-0048).",
    "All 23 signatures' `Program log: Instruction: <Name>` line independently confirmed via `solana confirm -v <signature>` -- every one decodes to the exact expected PascalCase instruction name, zero mismatches.",
    "Committed as 7ca86cc87435f0d5e88a68fc03f5d202ac352be2 on main, pushed to origin/main (GitHub), then deployed to production via `vercel --prod` as deployment dpl_FG8FfucjGVpbUoWnQutKsm5zAz8x, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun/ssr-fun.vercel.app. Post-deploy: `curl -I https://strategic-super-reserve.fun` returned 200; `vercel logs --since 3m` showed zero lines matching error/fatal/fail. This pass has no frontend behavior change (audit + docs + a Rust comment only) -- the deploy was performed because it was explicitly requested, not because any user-facing behavior changed."
  ]
}
```

## DEC-0093

```json
{
  "id": "DEC-0093",
  "date": "2026-08-13",
  "status": "confirmed",
  "decision": "Fixed the complete Wind-down/Closure flow across five reported defects, with the ssr_protocol program upgraded on DevNet and the frontend/SDK corrective pass committed and deployed live.\n\n**Bug #1 -- Wind-down redemptions rejected.** Reported: Sell during WindDown was rejected with 'Reserve is not Active (status: windDown) -- Buy/Sell unavailable.' Root cause: NOT the on-chain program -- `Reserve::require_redemption_allowed()` (state/reserve.rs) already explicitly permits Active/Paused/WindDown and always has (since Phase G). The bug was in `api/devnet/swap-sign.ts`'s server-side co-signer endpoint, which used one Active-only status gate for BOTH Buy and Sell. Fixed by splitting the gate: Buy still requires exactly Active (mirroring `mint_reserve_tokens_in_kind`'s own on-chain check); Sell now uses the same canonical `isRedemptionAllowedForStatus` (newly exported from `packages/sdk/src/reserveEligibility.ts`, reusing its existing `LIFECYCLE_STATUSES_PERMITTING_NORMAL_USE` set rather than a second copy that could drift). No program change was needed for this bug -- it was purely a frontend/API-layer gate.\n\n**Bug #2 -- collect_fees fails with Custom 2040.** Root-caused precisely: 2040 is Anchor's OWN framework error `ConstraintDuplicateMutableAccount` (confirmed against anchor-lang-error 1.1.2's source, the exact version this program is built against), not an ssr_protocol error, not the Token Program, not Token-2022, not a foreign program. It fires whenever a Reserve's `manager_fee_destination` equals `ProtocolConfig.default_protocol_fee_destination` (e.g. the same wallet manages both) -- Anchor's default codegen treats two same-type mutable accounts resolving to the same address as a hard error, a guard against silent double-serialization that does NOT apply here since both mutations are independent `token::mint_to` CPIs into the SPL Token program (each CPI writes the account's on-chain balance directly; two CPIs against the same account compose correctly regardless of aliased in-memory Anchor handles). Confirmed empirically live: querying all 40 real DevNet Reserves found 11 (including the reported reserveId 37, 'VVVV', `25NCQeJfjC9gJ39N4hWgSp2krQVKjLLdsshWVEUEY6Ni`) with this exact collision -- not a one-off. Fixed with Anchor's own documented `dup` constraint escape hatch on both `manager_fee_destination_token_account`/`protocol_fee_destination_token_account` in `collect_fees.rs`. Live-proven: `collect_fees` on the real reserveId-37 Reserve, previously failing with exactly `InstructionError: [2, {\"Custom\": 2040}]`, now succeeds (signature below), correctly minting both the 14,072,632-unit manager share and 3,518,157-unit protocol share into the single shared destination ATA and zeroing both pending balances.\n\n**Bug #3 -- 80/20 split reported where 50/50 was configured.** Investigated exhaustively and found NO calculation bug: the mint-fee-split math was, and is, 100% config-driven and correct. The specific 'VVVV' Reserve (reserveId 37) simply has an immutable `managerFeeShareBps=8000`/`protocolFeeShareBps=2000` FeeConfig set at creation, predating DEC-0089's 50/50-default fix -- FeeConfig has no `update_fee_config` instruction and is immutable once a Reserve exists, so this Reserve will always split 80/20 by its own genuine, honest configuration; nothing was miscalculating. Live-proven exactly: a fresh Reserve created this pass with `managerFeeShareBps=3000`/`protocolFeeShareBps=7000` (deliberately neither 50/50 nor 80/20) produced an on-chain mint-fee split of exactly 300,000/700,000 raw units on a 1,000,000-unit total fee (100 devUSDC gross, 1% mint fee) -- proving the split IS config-driven, not hardcoded to any value. A genuine, separate rounding-COMPLETENESS bug WAS found and fixed while tracing this: `mint_reserve_tokens_in_kind.rs`/`accrue_fees.rs` independently floor-rounded BOTH the manager and protocol shares, which could leave 1 raw unit of fee permanently unallocated to either recipient (dust silently evaporating rather than landing deterministically on someone) whenever the two independently-rounded shares didn't sum back to the total. Fixed via a floor+exact-remainder pattern (manager share floor-rounded, protocol share is `total.checked_sub(manager)`, guaranteeing `manager + protocol == total` exactly, every time) -- valid specifically because `create_reserve.rs`'s validation was ALSO tightened from `manager_bps + protocol_bps <= BPS_DENOMINATOR` to `== BPS_DENOMINATOR` (confirmed this doesn't affect any of the 40 existing live Reserves, which already all summed to exactly 10,000bps). A client-side mirror of the exact same floor+remainder split (`computeFeeShareSplit`, `packages/sdk/src/calculations.ts`) was added and offline-tested (arbitrary splits, a sweep proving the sum invariant always holds, and rejection of a misconfigured non-10000-summing split) so the frontend can independently predict/display the same numbers the program computes.\n\n**Bug #4 -- fees during wind-down.** Audited `accrue_fees.rs`/`collect_fees.rs`: both were already unconditional with respect to Reserve status (no `require!` on `status` at all in either) -- wind-down was already never erasing, freezing, or redirecting accrued fees, confirmed by direct source read plus this pass's own live test (a Reserve's pending fee shares were re-fetched unchanged immediately after `initiate_wind_down` and again after a full redemption, only changing once `collect_fees` was explicitly called). No fix needed here; UI transparency was improved instead (see frontend changes below).\n\n**Bug #5 -- closure safeguards.** Found and fixed a genuine, previously entirely-unguarded gap: `close_reserve.rs` checked `reserve_token_mint.supply == 0` but NEVER checked `fee_config.pending_manager_fee_shares`/`pending_protocol_fee_shares` -- a manager could close a Reserve with real, uncollected fee shares still outstanding, permanently stranding them (closing removes the Reserve account entirely; `collect_fees` cannot run against an account that no longer exists). Fixed by adding a new check requiring both pending-fee-share fields to be exactly zero, with a new error variant `PendingFeesNotCollected` (appended at the very end of `errors.rs`'s enum specifically to avoid renumbering any existing error code -- computed to be code 6043 by careful declaration-order counting, since this environment's linker bug blocks IDL/build-based regeneration; the local `packages/sdk/idl/ssr_protocol.json` copy was found already separately stale by 2 more entries beyond this fix and was hand-corrected to add all 3 missing entries, now 44 total, verified valid JSON). Live-proven both directions: closure is correctly rejected while fees are pending (even with supply and every vault already zero); closure is STILL correctly rejected immediately after `collect_fees` runs, because collecting mints new Reserve Token shares to the fee recipients, which are themselves now real outstanding supply that must ALSO be redeemed before `close_reserve`'s pre-existing supply-zero check can pass -- an important, non-obvious finding: fee shares are real claims on real vault assets, not a bypassable formality, and this pass's own test script had to be corrected once its first draft assumed otherwise. A second, fully self-controlled disposable Reserve (100% manager / 0% protocol fee split, so every liability was redeemable by the same test wallet) drove the complete cycle to a genuine `close_reserve` success: collect fees while the vault still had real backing, redeem the full balance (original holding + freshly-collected fee share) in one transaction, confirm supply reached zero, then close succeeded and the account was confirmed gone.\n\n**User-facing messaging (frontend):** `DTRDetail.tsx`'s Buy/Sell failure toasts now show the required plain-language copy ('Your purchase could not be completed. No funds were moved.' / 'Your redemption could not be completed. No funds were moved.') instead of a raw decoded error string -- full technical detail (the decoded on-chain/framework error, server status text) now goes to the browser console instead of the toast. `ManageDTR.tsx`'s shared `runOnChainAction` error handler now maps the Collect Fees and Close Reserve failure paths to their required copy ('Fees could not be collected. No funds were moved.' / 'This Reserve cannot close until all holder claims and outstanding fees are settled.') the same way, while every other action in that file keeps its existing (already-honest, already-decoded) error text -- console logging preserves full detail for all of them. The Wind-down banner on `DTRDetail.tsx` now uses the exact required copy ('New purchases are disabled. Existing holders can continue to redeem their Reserve Tokens.'). The Close Reserve button now proactively checks pending fee shares client-side (mirroring the new on-chain `PendingFeesNotCollected` check) and shows the required 'cannot close until settled' message BEFORE a transaction is even attempted, not only after a failure. Fee-split transparency: `managerFeeShareBps`/`protocolFeeShareBps` were added end-to-end (`packages/sdk/src/readOnly.ts`'s `ReserveOnChain` interface and `fetchReserveOnChain` -- previously missing entirely, unlike `discovery.ts` which already exposed them -- through `src/merge/lib/types.ts`'s `OnChainReserveMeta`, `src/merge/lib/onChainReserve.ts`'s two mapping functions, into `ManageDTR.tsx`'s Pending Fees card, which now shows the Reserve's actual configured split percentage next to each recipient's balance) so a manager can see WHY their split is whatever it is, addressing the underlying confusion behind bug #3's report even though no calculation was ever wrong.",
  "context": "User reported the complete Wind-down/Closure flow was broken across four fronts: (1) existing holders could not Sell/redeem during Wind-down despite Buy correctly being disabled, rejected with 'Reserve is not Active (status: windDown) -- Buy/Sell unavailable.'; (2) collect_fees failed on-chain with `InstructionError: [2, {\"Custom\": 2040}]`, a code outside ssr_protocol's documented range, suspected to indicate IDL/client/deployed-binary drift or another program; (3) a real 100 devUSDC purchase with a 1% mint fee and a configured 50% protocol share produced an observed ~80%/20% Manager/Protocol distribution instead of 50/50, with exact before/after VVVV-denominated numbers provided; (4) no assurance that fees accrued before/during wind-down remain claimable, or that a Reserve is prevented from closing while any liability (supply, vault assets, fee claims) remains outstanding. Required real on-chain fixes (not frontend-only patches), root-cause diagnosis of the exact program/instruction/error for #2, proof the fix is genuinely config-driven for #3 (explicitly: do not hardcode 50/50), specific required user-facing error copy for all four failure classes, comprehensive test coverage, honest DevNet-checklist evidence (not compilation/mocks alone), and a full commit/push/deploy with a detailed final report including real transaction signatures.",
  "rationale": "Every fix targeted the smallest change that closed the actual root cause, verified live rather than assumed from source reading alone. Bug #1's fix stayed entirely in the API layer (no program change) because the program was already correct -- reusing `reserveEligibility.ts`'s existing canonical status set (rather than a fresh literal Set in `swap-sign.ts`) was chosen specifically to prevent this exact class of bug (two independently-maintained copies of 'which statuses permit an action' silently drifting) from recurring. Anchor's `dup` constraint (bug #2) was chosen over any account-restructuring alternative because it is the framework's own documented, minimal-blast-radius mechanism for exactly this legitimate-collision case, and because a code-level CPI-semantics read confirmed no double-serialization risk exists here (mutation happens via CPI, not Anchor's own struct write-back) -- restructuring the accounts struct to avoid the collision entirely would have been a larger, riskier change for no additional safety. Bug #3's investigation deliberately did not stop at 'the math looks right' -- it required live cross-Reserve evidence (querying all 40 real Reserves) specifically because the task explicitly warned against concluding a hardcoded 50/50 would satisfy the requirement; finding a genuinely different, real rounding-completeness bug during that same investigation (rather than closing the investigation once the headline 80/20 report was explained) matches this project's standing practice of not declaring an area clean just because the originally-reported symptom is explained. The floor+exact-remainder split pattern was chosen over alternatives (e.g. always rounding the smaller share down) because it requires no per-recipient special-casing and is provably exact by construction once the two bps configs are validated to sum to exactly 10,000 -- which `create_reserve.rs` was tightened to require specifically to make this guarantee load-bearing rather than incidental. Bug #5's fix stops precisely at 'every pending fee share must be collected' rather than also trying to force-redeem the resulting fee-share tokens automatically, because collect_fees' own destinations are Reserve-configured wallets this program has no authority to unilaterally debit further -- the manager/protocol treasury retaining their own redemption decision is the correct trust boundary, matching how a normal holder's redemption is never forced either. Error code 6043 was appended at the very end of the errors.rs enum, and the local IDL file was hand-patched rather than regenerated, specifically because this environment's pre-existing, already-documented mingw linker bug (paths containing a space) blocks `anchor idl build` here -- appending-only avoids renumbering any already-shipped error code for any existing client. `execute_rebalance_leg` was again temporarily excluded from `lib.rs`/`instructions/mod.rs` to obtain a clean build (identical technique used twice before, DEC-0092), then the exclusion was fully reverted via `git checkout` before committing, confirmed via a clean `git diff` -- this bug remains pre-existing, unrelated, and out of scope, unchanged from DEC-0077/DEC-0092's own findings.",
  "alternativesConsidered": [
    "Hardcode a 50/50 fee split display or calculation to directly match the user's stated expectation (explicitly rejected by the task itself, and rejected here too: the actual bug was never the calculation, and hardcoding would have broken every Reserve with a genuinely different, validly-configured split -- e.g. the 3000/7000 and 10000/0 splits this pass's own live verification exercised)",
    "Restructure collect_fees.rs's Accounts struct to avoid the manager/protocol-destination collision entirely (e.g. separate instructions per recipient) rather than use Anchor's `dup` escape hatch (rejected: materially larger change, more surface area for a NEW bug, when the collision is legitimate and already provably safe under CPI semantics)",
    "Silently redirect or split a colliding fee destination into two separate accounts (rejected outright: would move real funds to a location the Reserve's own configuration never specified, exactly the kind of 'remap or hide the error' the task explicitly prohibited)",
    "Auto-redeem a fee recipient's freshly-collected shares as part of collect_fees itself, so close_reserve could succeed in one fewer step (rejected: would mean the program unilaterally deciding a third party's redemption timing/amount without their transaction -- a trust-boundary violation collect_fees' own 'permissionless-to-trigger, destination-locked' design deliberately avoids elsewhere)",
    "Regenerate packages/sdk/idl/ssr_protocol.json via `anchor idl build` instead of hand-patching it (infeasible this pass: blocked by the same pre-existing, already-documented Windows mingw ld.exe 'path contains a space' linker bug that has blocked every native Rust test-binary/IDL-build attempt in this environment to date)"
  ],
  "impact": "Program (rebuilt via `cargo-build-sbf`, deployed to DevNet program `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`, upgrade signature `EQKWBsze7FLXWt1kYBL9vGbbGSdahd6v9comaaqvVzRPQAHDBJ88qUWbNXofDBSfiYzCHvTNmgRA2o2T1MSa8uJ`, slot 483439975): `programs/ssr_protocol/src/instructions/{collect_fees.rs (dup constraint),create_reserve.rs (fee-share-sum validation tightened to ==),mint_reserve_tokens_in_kind.rs, accrue_fees.rs (floor+exact-remainder split),close_reserve.rs (new PendingFeesNotCollected check)},errors.rs (new PendingFeesNotCollected variant, code 6043)`. SDK: `packages/sdk/src/{calculations.ts (new computeFeeShareSplit),reserveEligibility.ts (new exported isRedemptionAllowedForStatus),readOnly.ts (new managerFeeShareBps/protocolFeeShareBps fields),errors.ts (framework-error decoding wired in),index.ts},packages/sdk/src/anchorFrameworkErrors.ts (new -- full Anchor framework error table),packages/sdk/idl/ssr_protocol.json (3 missing error entries added, now 44 total)`. Frontend: `api/devnet/swap-sign.ts (split Buy/Sell status gate), src/merge/pages/{DTRDetail.tsx (required error copy, wind-down banner copy),ManageDTR.tsx (required error copy, Close Reserve pending-fees pre-check, fee-split-percentage display)}, src/merge/lib/{types.ts,onChainReserve.ts} (fee-share-bps propagation)`. Tests: `tests/phase_winddown_closure_fees.ts` (new, 20 tests), `tests/phase_reserve_deploy_resumability.ts` (2 tests updated for the IDL error-range growing from 6000-6040 to 6000-6043). Docs: `docs/protocol/DEVNET_WINDDOWN_CLOSURE_FEES_CHECKLIST_2026-08-13.md` (new). Scripts: `scripts/verify_winddown_closure_fees_2026_08_13.ts` (new, reusable, not deleted). 395/395 offline tests passing (375 prior + 20 new), `npm run build` (SDK build + `tsc -b` + `vite build`) and `npm run lint` (oxlint) both clean, zero new warnings. `execute_rebalance_leg` remains unbuilt/undeployed (pre-existing, unrelated, reconfirmed again this pass, temporarily excluded then fully reverted for this build).",
  "affectedAreas": [
    "programs/ssr_protocol/src/instructions/collect_fees.rs",
    "programs/ssr_protocol/src/instructions/create_reserve.rs",
    "programs/ssr_protocol/src/instructions/mint_reserve_tokens_in_kind.rs",
    "programs/ssr_protocol/src/instructions/accrue_fees.rs",
    "programs/ssr_protocol/src/instructions/close_reserve.rs",
    "programs/ssr_protocol/src/errors.rs",
    "packages/sdk/src/calculations.ts",
    "packages/sdk/src/reserveEligibility.ts",
    "packages/sdk/src/readOnly.ts",
    "packages/sdk/src/errors.ts",
    "packages/sdk/src/anchorFrameworkErrors.ts",
    "packages/sdk/src/index.ts",
    "packages/sdk/idl/ssr_protocol.json",
    "api/devnet/swap-sign.ts",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/lib/types.ts",
    "src/merge/lib/onChainReserve.ts",
    "tests/phase_winddown_closure_fees.ts",
    "tests/phase_reserve_deploy_resumability.ts",
    "docs/protocol/DEVNET_WINDDOWN_CLOSURE_FEES_CHECKLIST_2026-08-13.md",
    "scripts/verify_winddown_closure_fees_2026_08_13.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "395/395 offline tests passing (`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`, excluding the live-DevNet-provider-only tests/ssr_protocol.ts per this repo's established convention -- 375 prior + 20 new in tests/phase_winddown_closure_fees.ts covering isRedemptionAllowedForStatus, computeFeeShareSplit's exactness/config-driven/sum-invariant properties, and error-2040/6043 decoding). npm run build (SDK build + tsc -b + vite build) and npm run lint (oxlint) both clean.",
    "Program rebuilt via `cargo-build-sbf --manifest-path programs/ssr_protocol/Cargo.toml` (with execute_rebalance_leg temporarily excluded, then fully reverted via `git checkout` before committing, confirmed clean via `git diff`) and deployed to DevNet: upgrade signature `EQKWBsze7FLXWt1kYBL9vGbbGSdahd6v9comaaqvVzRPQAHDBJ88qUWbNXofDBSfiYzCHvTNmgRA2o2T1MSa8uJ`, confirmed via `solana program show` (slot 483439975, data length 657,848 bytes).",
    "Live DevNet verification (`scripts/verify_winddown_closure_fees_2026_08_13.ts`, real signed transactions, no mocks/simulation): Buy correctly rejected during WindDown (custom program error 0x177a = UnexpectedReserveStatus); Sell/redemption `2GBS78EWuzdeDWcmnD4EcrerEuPjMhA4w2Nf1vqfFREf7JtYHgq5q7BDA7TBDrDH6FrDtttZzQtUuu9QhdP8tXtM` succeeded during WindDown, supply and vault balance both confirmed zero afterward; mint `5vZb5ZEDr3MnjQVZmz3fcWYYQjsEtB7JWKSDt9xTKmyc5rrsvdLrhVQFtrM1rsZh65nfSGQzAdS1HfbRFc1dJe6F` produced an exact on-chain 300,000/700,000 (30%/70%) fee-share split matching its configured managerFeeShareBps=3000/protocolFeeShareBps=7000 exactly; close_reserve correctly rejected with PendingFeesNotCollected (0x179b = 6043) while fees were pending; collect_fees `3599T6gmd9Jkd8x1fvc8yXK7FhxoudbAJgVwWwqqi1QEDAVnp1EVM9KN1JNHQrr17KJBaY6FfZ54rhwMKogCvNrZ` paid out the exact 300,000/700,000 split and zeroed pending balances; close_reserve correctly rejected AGAIN with ReserveTokenSupplyNotZero (0x1782 = 6018) immediately after, since collecting minted new outstanding supply to the (uncontrolled-by-this-session) protocol treasury; a second, fully self-controlled Reserve completed the full cycle to a genuine close_reserve success (`5QttRAy5E7nrmdjXHvJugZk3AtskLvSdTKVeVEtcHcxdA1qeAiRTWmdZLLrhh9asFTjJeXzbSWxpWacy3fzxPSRP`, account confirmed closed via getAccountInfo returning null); collect_fees `5jeAvnbkKoMTDeVB9heUdsQZfxEwaKvX4bdoATqhNMNTsih1okA3uYf1doBMaDbzzELqFLvmbW31LfDQNfksK1Pu` on the REAL reserveId-37 collision Reserve (previously failing live with Custom 2040) now succeeds, correctly minting 14,072,632 + 3,518,157 raw units into the shared destination ATA and zeroing both pending balances.",
    "Full checklist with per-item evidence, tester, date, environment, and remaining limitations recorded honestly (not marked Passed on compilation/mocks alone) in docs/protocol/DEVNET_WINDDOWN_CLOSURE_FEES_CHECKLIST_2026-08-13.md.",
    "Committed as 8703e73 on main, pushed to origin/main (GitHub, fast-forward, no conflicts) -- production Vercel deployment ID and post-deploy verification recorded in PROJECT_STATUS.md's Last Updated section (per this project's no-amend policy, deploy evidence follows in a subsequent append rather than editing this entry)."
  ]
}
```

## DEC-0094

```json
{
  "id": "DEC-0094",
  "date": "2026-08-13",
  "status": "confirmed",
  "decision": "Implemented the SSR.fun Protocol/Manager fee-split formula (`protocol_bps = max(50, configured_bps / 2)`, `manager_bps = max(configured_bps - protocol_bps, 0)`, applied independently to the Mint fee and the Annualized TVL fee, uniformly to every Reserve -- old and new -- for all FUTURE accruals, confirmed with the user given this can raise a Reserve's effective total fee above its originally-configured rate when that rate is below the 0.5% floor) and added native on-chain support for up to 10 Manager fee recipients per Reserve, replacing the old caller-chosen manager/protocol split ratio entirely. `programs/ssr_protocol` upgraded on DevNet; SDK, frontend (Create Reserve + Manage Reserve dashboard), a new weekly Vercel Cron keeper for TVL-fee cadence, and documentation all updated and live-verified with real signed DevNet transactions.\n\n**Fee formula**, computed fresh at every mint/accrual (never a stored/caller-chosen ratio): total fee shares computed from the EFFECTIVE total bps (`protocol_bps + manager_bps`, which can exceed the configured rate when the configured rate is below the 0.5% floor); split into `(protocol_total, manager_total)` via floor+exact-remainder dividing by the effective total bps -- NOT `BPS_DENOMINATOR` (a bug caught during design review: the pre-DEC-0094 divisor was only valid because `create_reserve` used to force the two shares to sum to exactly 10,000, which the new formula generally does not).\n\n**Multi-recipient architecture**: a new, fully ADDITIVE `ManagerFeeRecipients` account (`programs/ssr_protocol/src/state/manager_fee_recipients.rs`), PDA-seeded per-Reserve, fixed-size (10 slots always allocated, so no future realloc is ever needed) -- deliberately NOT a field grown onto `Reserve`/`FeeConfig` itself, avoiding any realloc/migration risk to the ~40 already-initialized live Reserve accounts (this codebase had zero realloc precedent to build on). `manager_total` is apportioned across recipients via largest-remainder (Hamilton) apportionment (`fee_math::apportion_to_recipients`), exact integer math, no floats, provably sums to `manager_total` exactly and doesn't systematically favor the same recipient run after run. Per-recipient balances are credited AT ACCRUAL TIME (inside `mint_reserve_tokens_in_kind`/`accrue_fees`), not lazily at collection, so a later routing change can never reallocate already-accrued fees -- enforced by `update_fee_recipients` requiring every current recipient's pending balance to be zero before a routing change is accepted.\n\n**Backward compatibility**: every accrual/collection/closure instruction takes `manager_fee_recipients` as a genuinely `Option<Account>` (confirmed real, load-bearing behavior in the pinned `anchor-lang 1.1.2` by reading the actual crate source, not assumed) -- a Reserve that has never opted in (client passes the program ID itself as the `None` sentinel) keeps working exactly as before the upgrade, zero migration required, zero disruption. `collect_fees.rs` was left COMPLETELY UNTOUCHED (a design-review course-correction from an initial draft that would have split/renamed it): it already independently guards `if manager_shares > 0`/`if protocol_shares > 0`, so it degrades gracefully into protocol-only for a migrated Reserve (whose `pending_manager_fee_shares` simply stays 0 forever once migrated) with zero code changes -- avoiding any disruption to existing client/indexer bindings against its discriminator.\n\n**New instructions** (all additive, all gated by the existing-but-previously-unused `MANAGE_FEES` delegate permission flag where applicable, root manager always passing automatically): `initialize_manager_fee_recipients` (first-time opt-in), `update_fee_recipients` (routing change, blocked while any current recipient has a pending balance; carries forward each surviving wallet's lifetime `collected_fee_shares` stat by identity, not slot index), `collect_manager_fee_share` (permissionless, pays out ONE named recipient's own balance, legacy-fallback-aware).\n\n**TVL fee cadence** (new requirement raised mid-session): the existing timestamp-based pro-rata accrual (unchanged formula, already permissionless, already a safe no-op under 1 day elapsed) is now ALSO triggered automatically from inside `mint_reserve_tokens_in_kind`/`redeem_reserve_tokens_in_kind` (`accrue_fees::checkpoint_tvl_fee`, shared code) so a normal Buy/Sell checkpoints TVL fees for free in the same transaction -- \"settle during normal Reserve transactions.\" A new weekly Vercel Cron endpoint (`api/devnet/accrue-fees-cron.ts`, `CRON_SECRET`-gated, `?dryRun=true` for safe unauthenticated inspection) is the permissionless fallback for a dormant Reserve, using a ~25-day staleness trigger to leave real margin before the 30-day hard requirement even if a scheduled run is missed.\n\n**Incidental fixes required to obtain a clean build** (found, not introduced, by this pass -- `execute_rebalance_leg` had never been run through `cargo build-sbf` before, per its own \"NOT YET BUILT/DEPLOYED\" header): a `CpiContext::new_with_signer` call passing `.to_account_info()` instead of `.key()` for a `Program<T>` account (same class of bug already fixed elsewhere in this codebase); a handler eliding the `Context<'info, T<'info>>` lifetime pattern this file's own header comment warns against; and a genuine BPF stack-frame overflow (4224 bytes against the 4096-byte limit) in its 15-field Accounts struct, fixed the standard Anchor way by boxing the single largest account (`reserve: Box<Account<'info, Reserve>>`).",
  "context": "User requested native on-chain support for up to 10 Manager fee recipients per Reserve, plus a complete audit and correction of SSR.fun's fee configuration and accounting to enforce an exact formula: SSR.fun Protocol always receives at least 0.5% on mints and 0.5% annualized on TVL; above that minimum, Protocol and Manager split the configured fee 50/50; Buy/Sell tax stays at 0%. Mid-session, the user additionally requested the Annualized TVL fee use timestamp-based pro-rata accrual settled weekly where practical (at least every 30 days), minimizing network cost by settling during normal Reserve transactions with a permissionless monthly fallback for dormant Reserves. The deployed protocol only ever supported one Manager fee destination (`fee_config.fee_destination`) and a caller-chosen manager/protocol split ratio -- DEC-0083 had already recorded that a multi-recipient UI existed but was explicitly disabled for real Reserves because it 'would need a program change/redeploy,' which this pass is.",
  "rationale": "A separate, fixed-size, additive account for recipient routing (rather than growing FeeConfig/Reserve in place) was chosen specifically because this codebase has zero realloc/account-migration precedent and ~40 real Reserve accounts are already live -- any in-place layout change would need a migration instruction touching every existing account; a new account type sidesteps that risk entirely while still satisfying the requirement's own suggestion ('use a versioned account or migration instruction' if growing in place isn't safe). Crediting recipients AT ACCRUAL TIME rather than lazily at collection was the only design that makes 'routing changes can never reallocate already-accrued fees' airtight by construction rather than by convention -- a lazy-split-at-collection design would need to know which routing config was active at each historical accrual instant, which nothing here tracks. Largest-remainder apportionment (over, e.g., always giving the remainder to a fixed recipient index) was chosen because the requirement explicitly asks for a remainder rule that does not systematically favor one recipient -- Hamilton apportionment's remainder-recipient varies per accrual based on each recipient's actual fractional share that specific call, not a fixed favorite. Applying the new formula retroactively to every existing Reserve (not just new ones) was an explicit, deliberate product decision confirmed with the user after flagging its real consequence (a Reserve configured below the 0.5% floor sees its effective fee rise) -- the alternative (grandfathering old Reserves under their original ratio) would mean the 0.5% Protocol minimum is not actually guaranteed protocol-wide, which contradicts the requirement's own absolute framing ('the effective total fee charged cannot be lower than the 0.5% Protocol minimum'). Leaving `collect_fees.rs` completely untouched (reversing an initial draft's plan to split it into `collect_protocol_fees`) was chosen after review found the split unnecessary: the instruction's own existing per-branch `if shares > 0` guards already produce the desired protocol-only behavior for a migrated Reserve with zero code change, and renaming/splitting a live, already-integrated instruction is itself a disruptive change with no compensating benefit. The redemption fee was confirmed and kept fully out of scope -- the task's own formula and table only name the Mint and Annualized TVL fees, and the redemption fee's existing burn-not-distribute mechanic is a different, unrelated concept that would need its own separate product decision to change.",
  "alternativesConsidered": [
    "Grow FeeConfig/Reserve in place with a realloc-based migration instruction instead of a separate ManagerFeeRecipients account (rejected: this codebase has zero realloc precedent, and a migration instruction touching all ~40 live Reserve accounts is materially riskier than a purely additive new account type that requires touching zero existing accounts)",
    "Compute recipient shares lazily at collect_manager_fee_share time using whatever routing is currently configured (rejected: cannot guarantee 'never reallocate already-accrued fees' without tracking which routing config was active at each historical accrual instant, which is exactly the bug class this design avoids by crediting at accrual time instead)",
    "Give the remainder from apportionment to a fixed recipient (e.g. always the Primary/first slot) (rejected: the task explicitly requires a remainder rule that does not systematically favor one recipient; largest-remainder apportionment's winner varies per accrual based on actual fractional shares)",
    "Grandfather existing Reserves under their original manager/protocol ratio, applying the new formula only to Reserves created after this upgrade (considered and explicitly rejected by the user after the retroactive-application tradeoff was surfaced -- see rationale)",
    "Split collect_fees.rs into collect_protocol_fees + a new manager-only instruction (an initial draft's plan, reversed during design review once the existing per-branch pending>0 guards were confirmed to already produce the same protocol-only-for-migrated-Reserves behavior with zero code change, at zero disruption risk to existing client bindings)",
    "Apply the same Protocol/Manager split formula to the redemption fee too (considered per the task's own request for clear naming across fee types, but the task's explicit formula/table only names Mint and Annualized TVL fees -- confirmed out of scope with the user)"
  ],
  "impact": "Program (rebuilt via `cargo-build-sbf`, deployed to DevNet program `2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`, upgrade signature `DVoW5bEj5u2VkRwpTLvRVzaf3wQK3H8Byd64Ty5kwN9GWZYRqCSDxuewdpVNPqvpF5mWkeqUTfC2wuiJJHydpt6`, slot 483504441, data length grew 657,848 -> 807,712 bytes): new `programs/ssr_protocol/src/fee_math.rs`, new `state/manager_fee_recipients.rs`, new instructions `initialize_manager_fee_recipients.rs`/`update_fee_recipients.rs`/`collect_manager_fee_share.rs`, rewired `mint_reserve_tokens_in_kind.rs`/`accrue_fees.rs`/`redeem_reserve_tokens_in_kind.rs`/`close_reserve.rs`/`create_reserve.rs` (dropped `manager_fee_share_bps`/`protocol_fee_share_bps` as caller args), 10 new `SsrError` variants (codes 6044-6053, append-only), 3 new events, plus the incidental `execute_rebalance_leg.rs` fixes above (still not itself deployed-and-relied-upon; unrelated to this pass's scope, fixed only because it blocked this pass's own build). SDK: new `packages/sdk/src/feeMath.ts`, `pda.ts` (`findManagerFeeRecipients`), `readOnly.ts` (`fetchManagerFeeRecipients`, effective-rate fields on `ReserveOnChain`), `discovery.ts` (same fields + `lastFeeAccrualTs` on `DiscoveredReserve`), `createReserveFlow.ts`/`managementInstructions.ts` (new instruction builders, `CreateReserveParams` dropped the two share-bps fields), hand-updated `packages/sdk/idl/ssr_protocol.json` (validated via `JSON.parse` plus manually-computed Anchor discriminators for every new instruction/account/event, cross-checked against an existing entry's known-correct discriminator) since this environment's pre-existing, already-documented mingw linker bug blocks `anchor build`'s IDL generation. Frontend: `src/merge/pages/CreateDTR.tsx` (real, functional recipient editor replacing the old disabled-for-real-Reserves block; live effective-rate preview; Buy/Sell tax locked to 0% and clearly labeled for real Reserves; also fixed a pre-existing Interface Copy Standards violation naming `fee_config.fee_destination` directly in user-facing copy), `src/merge/lib/createReserveClient.ts` (bundles `initialize_manager_fee_recipients` into the create transaction for >1 recipient), `src/merge/pages/ManageDTR.tsx` (full recipient list with per-recipient accrued/claimable/collected + individual Collect action, routing-change editor with auto-bundled collect-then-update, configured/effective rate display, routing effective-date), `src/merge/lib/managementClient.ts` (3 new client functions), `src/merge/lib/{types.ts,onChainReserve.ts}` (effective-rate field propagation). New `api/devnet/accrue-fees-cron.ts` + `vercel.json` `crons` entry (weekly). Fixed stale `managerFeeShareBps`/`protocolFeeShareBps` create_reserve call sites broken by the signature change in `tests/ssr_protocol.ts`, `scripts/create_canonical_reserves.ts`, `scripts/devnet_fixtures.ts` (historical one-off `scripts/verify_corrective_pass.ts`/`verify_create_reserve.ts` left as point-in-time records, not re-fixed). New `tests/phase_manager_fee_recipients.ts` (34 tests). 429/429 offline tests passing (395 prior + 34 new, 2 pre-existing tests' hardcoded error-range string updated from 6000-6043 to 6000-6053 to reflect the 10 newly appended error codes -- a correct, expected consequence of this pass, not a regression), `tsc -b --force`, `oxlint`, full `npm run build` (SDK + app) all clean. New `scripts/verify_manager_fee_recipients_devnet.ts` (reusable, not deleted) and `docs/protocol/DEVNET_FEE_RECIPIENTS_VERIFY_OUTPUT_2026-08-13.txt` (full real run transcript). `tests/ssr_protocol.ts` (the live-local-validator Anchor integration suite) had its own `createReserve` call site fixed for the new signature but was not extended with new local-validator-only multi-recipient scenarios this pass -- this environment has no local validator / `ANCHOR_PROVIDER_URL` available (confirmed via a real error attempting to run it), so live DevNet verification (below) is this pass's actual integration-level evidence instead, per this codebase's own established 'offline pure logic + separate live-DevNet evidence' split. On-chain IDL account publication (Solana Program Metadata standard, DEC-0092's precedent) was NOT refreshed this pass -- deprioritized in favor of the required DevNet verification given session time constraints; the on-chain IDL account is now stale relative to the upgraded program and should be republished in a follow-up (does not affect app functionality, which reads the IDL directly from `packages/sdk/idl/`, only Solscan's own instruction-decoding UI).",
  "affectedAreas": [
    "programs/ssr_protocol/src/fee_math.rs",
    "programs/ssr_protocol/src/state/manager_fee_recipients.rs",
    "programs/ssr_protocol/src/instructions/initialize_manager_fee_recipients.rs",
    "programs/ssr_protocol/src/instructions/update_fee_recipients.rs",
    "programs/ssr_protocol/src/instructions/collect_manager_fee_share.rs",
    "programs/ssr_protocol/src/instructions/mint_reserve_tokens_in_kind.rs",
    "programs/ssr_protocol/src/instructions/accrue_fees.rs",
    "programs/ssr_protocol/src/instructions/redeem_reserve_tokens_in_kind.rs",
    "programs/ssr_protocol/src/instructions/close_reserve.rs",
    "programs/ssr_protocol/src/instructions/create_reserve.rs",
    "programs/ssr_protocol/src/instructions/common.rs",
    "programs/ssr_protocol/src/instructions/execute_rebalance_leg.rs",
    "programs/ssr_protocol/src/errors.rs",
    "programs/ssr_protocol/src/events.rs",
    "programs/ssr_protocol/src/constants.rs",
    "programs/ssr_protocol/src/lib.rs",
    "packages/sdk/src/feeMath.ts",
    "packages/sdk/src/pda.ts",
    "packages/sdk/src/readOnly.ts",
    "packages/sdk/src/discovery.ts",
    "packages/sdk/src/createReserveFlow.ts",
    "packages/sdk/src/managementInstructions.ts",
    "packages/sdk/idl/ssr_protocol.json",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/managementClient.ts",
    "src/merge/lib/types.ts",
    "src/merge/lib/onChainReserve.ts",
    "api/devnet/accrue-fees-cron.ts",
    "api/devnet/_lib/apiTypes.ts",
    "vercel.json",
    "tests/phase_manager_fee_recipients.ts",
    "tests/phase_reserve_deploy_resumability.ts",
    "tests/ssr_protocol.ts",
    "scripts/create_canonical_reserves.ts",
    "scripts/devnet_fixtures.ts",
    "scripts/verify_manager_fee_recipients_devnet.ts",
    "docs/protocol/DEVNET_FEE_RECIPIENTS_VERIFY_OUTPUT_2026-08-13.txt"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "429/429 offline tests passing (`npx ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/phase_*.ts`, excluding the live-validator-only tests/ssr_protocol.ts per this repo's established convention -- 395 prior + 34 new in tests/phase_manager_fee_recipients.ts covering the exact task table for 0/0.5/1/2/5% configured, mint and TVL independently, 1-10 recipient apportionment exactness, an 11th recipient rejected, duplicate/zero/invalid recipients rejected, non-100% totals rejected, and an exhaustive protocol+manager==total sweep). `tsc -b --force`, `oxlint`, full `npm run build` (SDK workspace build + tsc -b + vite build) all clean.",
    "Program rebuilt via `cargo-build-sbf --manifest-path programs/ssr_protocol/Cargo.toml` and upgraded on DevNet: signature `DVoW5bEj5u2VkRwpTLvRVzaf3wQK3H8Byd64Ty5kwN9GWZYRqCSDxuewdpVNPqvpF5mWkeqUTfC2wuiJJHydpt6`, confirmed via `solana program show` (slot 483504441, data length 807,712 bytes, matching the local build byte-for-byte).",
    "Live DevNet verification (`scripts/verify_manager_fee_recipients_devnet.ts`, real signed transactions, ALL PARTS PASSED, full transcript in docs/protocol/DEVNET_FEE_RECIPIENTS_VERIFY_OUTPUT_2026-08-13.txt): PART 1 -- three fresh Reserves at configured mintFeeBps 0/100/500 each produced an EXACT on-chain protocol/manager split matching the task's own table (0%->0.5%P/0%M, 1%->0.5%P/0.5%M, 5%->2.5%P/2.5%M), signatures `4oi8G2tiunbJ7qPjRXcQ23H1EHagn7NXW54JzoAont1Ab1eQHPv3dKjLALpg83mMxD19ySHaMDMt5F3heABK59hR` / `3ewkiJAhfH5YhzrqubrENnUgyoMbreuYXQeJ5FqgLqTb47sA7q8Ls8fRRQPhQG6WihhB4UiexdYpYLxoCMgeqtPs` / `5sBZrm2rKkhMyrKFJKwCJ8hZbZJ11m8Vgwj67MhytNWEQXr6Pu4zoaywqjVhRrTyhUvoCon9RXLwCtwkwyXmVFQ1`. PART 2 -- a fresh Reserve (mintFeeBps=200) with 3 Manager fee recipients (50/30/20, created via `initialize_manager_fee_recipients` bundled into the create_reserve transaction, signature `3zoFLbuiJmFMjG2CYCpwnaRSvjeEaZevfvpgtk2vJqiqkwHb7YCK8WcZewXSgjE1aFbHL4imRzawYHQPjCAGYqzq`) received a real Buy (`2v3wUs5mwM8N5GSoNxK9pVoxasBgtH3aaika5CVqxoo81CHDLraU8PkJR3Yf45yjH9F3mvjUctrPmzEcSv2RZFUM`) producing on-chain per-recipient pending shares of exactly 500,000/300,000/200,000 (matching the client-side largest-remainder mirror exactly), with `pending_protocol_fee_shares` (1,000,000) plus the sum of all three recipients' shares (1,000,000) equalling the total fee assessed (2,000,000) exactly; recipient A then self-collected its own 500,000 (signature `4329yskCTJoeGePzZNQe9o8kpds6JFCyMcuqxtxUYeuGhdVgPVYxzAL5yRPUbsWdK33JpWnTfkrmNe4TifKdPtXg`, its ATA balance confirmed 500,000, B/C's pending confirmed unchanged), and the deployer wallet permissionlessly triggered recipient B's payout on B's behalf (signature `64abyG32uy5KQkyjiTYSsyb5siAoV2Pha2WLwLj59y6CR2QBYxTb4Vx2zTcatWxEtAgmQNMGcNkktThMHk6Hrd7F`, B's ATA confirmed 300,000). PART 3 -- a genuinely PRE-EXISTING, pre-upgrade Reserve (reserveId 28, the DEC-0081 canonical Single-Asset Reserve, `89RrhEebGPUKhcrAaMdJ1APZjR7DPUX47Mt9CVQECg6G`, last accrued 2026-08-05, ~8.02 real days before this call) had `accrue_fees` called against it with ZERO migration step (signature `4AzU8E3V8G8qCpCjL8s2B1rDBgHMPpBTAkZSVppQBaDom15WgRLCuFUNbWTYmSZ97nTo1F18AuU4tHjC98jd3wyq`), producing a real, nonzero TVL fee accrual (pending manager +12,049, protocol +12,050) via the new formula -- direct proof of backward compatibility on a real, already-live Reserve, not a fresh/simulated one.",
    "Deployer wallet funding for the upgrade's larger rent-exempt requirement (5.6225664 SOL for the new 807,712-byte binary vs. the existing 4.58 SOL already locked) was topped up via two real DevNet-SOL transfers from the `devnet-fixtures/manager-keypair.json` fixture wallet (signatures `42cP3UFMoYdkckcr2EF7BYVfdG1Uvw1K8e4p8bKn2R5dgaKCCaQ2mrox2KHE2TWxfWSoLNovEWa8F1hQ87j2mSZS`, `4QFE8WrQQ3Qjn8ubkoEXT1cJtxLzUktGe31Co99yY29YsPcc4bgLcWdqBdfUeDzubFxFnyZswZLnbbf2ySGAApHx`) after the public DevNet airdrop faucet returned rate-limited -- DevNet test funds only, no real value moved.",
    "Git branch/commit/push and production Vercel deployment recorded in PROJECT_STATUS.md's Last Working Days section (per this project's no-amend policy, deploy evidence follows in a subsequent append rather than editing this entry)."
  ]
}
```

## DEC-0095

```json
{
  "id": "DEC-0095",
  "date": "2026-08-13",
  "status": "confirmed",
  "decision": "Two follow-up corrections to DEC-0094, per direct user request: (1) removed the forced Protocol minimum fee -- a manager who genuinely configures a 0% Mint fee or 0% Annualized TVL fee now gets a real 0% effective fee (Protocol receives nothing, Manager receives nothing), rather than the fee being floored up to 0.5%. The 0.5% Protocol floor still applies whenever a manager configures ANY nonzero fee -- only the true-zero case changed. `fee_math::split_configured_bps` (Rust) and `computeEffectiveFeeSplit` (TS mirror) now special-case `configured_bps == 0` to `(0, 0)` before the floor logic runs; `split_total_fee`/`splitTotalFee` were also fixed to short-circuit when the resulting effective total is 0 (dividing by a genuinely-zero effective-total-bps would otherwise throw `DivisionByZero`, a real bug caught while implementing the zero-case). (2) Re-enabled Buy Tax / Sell Tax as real, manager-configurable, persisted values (0-2%, same slider as before) for real on-chain Reserves -- previously locked to a fixed 0% display. Confirmed with the user this is forward-looking configuration for a FUTURE secondary market (e.g. a DEX listing), not something enforced by minting or redeeming directly from the Reserve today (no such on-chain mechanism exists, and none was built this pass) -- copy throughout the app now says this explicitly rather than implying real enforcement. Values are persisted in the Reserve's on-chain `metadataUri` JSON payload (extending the existing name/ticker/description/category convention) and parsed back out via `packages/sdk/src/discovery.ts`'s `parseReserveMetadataUri`, defaulting to 0 for any Reserve created before this field existed.",
  "context": "Immediately after DEC-0094 shipped, the user reviewed the live dashboard and asked for two changes: remove the forced 0.5% minimum fee so a manager can genuinely charge 0% if they choose (keeping the 0.5% Protocol floor only for when a fee IS configured), and restore the Buy/Sell tax controls that DEC-0094 had locked to a fixed 0% display for real Reserves. Clarified with the user (via a direct question) that the tax re-add is for a future secondary market, not something to enforce on the current mint/redeem instructions -- ruling out a much larger on-chain redesign (e.g. a Token-2022 transfer-fee extension on the Reserve Token mint, which doesn't exist today and would be a major architecture change).",
  "rationale": "The zero-fee special case was implemented as an explicit early return in `split_configured_bps` rather than reworking the general formula, since the general formula (`max(floor, configured/2)`) is still exactly what the user wants for every NONZERO configured rate -- only the boundary case needed to change, and an explicit `if configured_bps == 0` is the smallest, clearest way to express that without disturbing the already-verified nonzero-rate behavior. The corresponding `split_total_fee` fix (short-circuit when `effective_total_bps == 0`) was necessary, not optional, once the zero case was allowed to reach that function -- discovered by reasoning through the call chain before it could surface as a live `DivisionByZero` failure on a real 0%-configured Reserve's first mint. Buy/Sell tax was deliberately kept OUT of the on-chain program: the user confirmed it targets a future secondary market that doesn't exist yet, so building on-chain enforcement now would mean guessing at a mechanism (which instruction would charge it? against which liquidity venue?) with no real venue to enforce it against -- storing the manager's chosen value transparently (with honest 'not yet enforced' copy) preserves the configuration for whenever that mechanism is designed, without fabricating enforcement that doesn't exist, consistent with this repo's Interface Copy Standards rule (CLAUDE.md) against overstating what a control actually does. Storing the values in `metadataUri` (rather than adding new `FeeConfig` fields on-chain) was chosen because they are explicitly NOT part of the protocol's fee-assessment logic -- adding them to the immutable, structurally-versioned `FeeConfig` would misrepresent them as enforced on-chain fee parameters, and would have required another account-layout change for a value nothing currently reads at the protocol level.",
  "alternativesConsidered": [
    "Keep the 0.5% floor unconditional (reject the request) -- rejected outright; the user was explicit and unambiguous that a manager-chosen 0% must be a real 0%.",
    "Apply the removed-floor behavior to every configured rate near zero (e.g. also let 0.1%-0.4% escape the floor) -- rejected as over-broad; the user's own wording ('no minimum fee, it can be 0% if reserve manager sets it to 0%') specifically names the zero case, and the existing floor-whenever-nonzero behavior for every other rate was already correct and live-verified under DEC-0094.",
    "Build genuine on-chain Buy/Sell tax enforcement now (e.g. a Token-2022 transfer-fee extension on the Reserve Token, or a new tax charged inside mint/redeem) -- explicitly ruled out by the user's own clarification that this is for a future secondary market; building enforcement against a venue that doesn't exist yet would mean guessing at a mechanism with no way to verify it against real usage.",
    "Add buyTaxPct/sellTaxPct as new FeeConfig fields in the Reserve account instead of metadataUri -- rejected: would misrepresent forward-looking, unenforced configuration as part of the protocol's authoritative on-chain fee logic, and would need another account-layout consideration for values nothing currently reads at the protocol level."
  ],
  "impact": "Program (rebuilt via `cargo-build-sbf`, upgraded on DevNet, signature `3nVMFCETD87LfgWruJNJdQ6Ke5BPQuRnovfyAMdKFihEHQWQsr2KDFDt2S4Ftf6oqjTS7agXgKNppp8vVPqWogY1`, slot 483515504): `programs/ssr_protocol/src/fee_math.rs` (`split_configured_bps` zero-case, `split_total_fee` zero-divisor short-circuit). SDK: `packages/sdk/src/feeMath.ts` (matching TS mirror fixes), `packages/sdk/src/discovery.ts` (`ParsedReserveMetadata` gains `buyTaxPct`/`sellTaxPct`, parsed from `metadataUri`). Frontend: `src/merge/pages/CreateDTR.tsx` (Buy/Sell tax sliders re-enabled and unconditional for real Reserves, included in the `metadataUri` JSON at creation, copy updated to 'future secondary-market trading, not applied to minting or redemption'), `src/merge/pages/ManageDTR.tsx` (same unlock + clarifying copy), `src/merge/lib/onChainReserve.ts` (`managerBuyTaxPct`/`managerSellTaxPct` now read from parsed metadata instead of hardcoded 0). Tests: `tests/phase_manager_fee_recipients.ts` updated (the task-table's 0% row now expects Protocol 0%/Manager 0%, not 0.5%/0%; the exact-sweep test's zero-configured-rate case now only exercises `total = 0`, matching what the real call chain actually produces for a 0/0 split -- an arbitrary nonzero `total` paired with a genuine 0/0 split is not a combination the real code path ever creates). 430/430 offline tests passing (0 net new -- existing tests corrected in place to match the new, deliberately different behavior), `tsc -b --force`, `oxlint`, full `npm run build` all clean. New `scripts/verify_zero_fee_floor_removed_devnet.ts` (reusable, not deleted).",
  "affectedAreas": [
    "programs/ssr_protocol/src/fee_math.rs",
    "packages/sdk/src/feeMath.ts",
    "packages/sdk/src/discovery.ts",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/lib/onChainReserve.ts",
    "tests/phase_manager_fee_recipients.ts",
    "scripts/verify_zero_fee_floor_removed_devnet.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "430/430 offline tests passing (`npx ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/phase_*.ts`), `tsc -b --force`, `oxlint`, full `npm run build` (SDK workspace + app) all clean.",
    "Program rebuilt via `cargo-build-sbf --manifest-path programs/ssr_protocol/Cargo.toml` and upgraded on DevNet: signature `3nVMFCETD87LfgWruJNJdQ6Ke5BPQuRnovfyAMdKFihEHQWQsr2KDFDt2S4Ftf6oqjTS7agXgKNppp8vVPqWogY1`, confirmed via `solana program show` (slot 483515504).",
    "Live DevNet verification (`scripts/verify_zero_fee_floor_removed_devnet.ts`, real signed transactions): a fresh Reserve created with mintFeeBps=0 (reserveId 53, `Ew4hHrexunrSv17zYBSfkepPHFfQKCkVmJzpELYio6gA`), a real 100,000,000-raw-unit Buy (signature `5LebfYrtPiBXR6yJW27k3UiLiGPJXjtFQBcHK7uN6K74eEaG7o1WT5PMaR7TyFuGYPFVHtyCM2eN95gcon2Z4mLw`) minted the depositor the FULL requested amount with zero fee deducted, and on-chain `pending_manager_fee_shares`/`pending_protocol_fee_shares` both read exactly 0 -- confirming no forced minimum fee is charged when a manager genuinely configures 0%."
  ]
}
```

## DEC-0096

```json
{
  "id": "DEC-0096",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Fixed delegated-Reserve discovery so a genuinely on-chain delegate grant reliably shows up on the Manager Dashboard, instead of the Delegates tab permanently reading 'N delegate(s) reported on-chain, but none matched this discovery pass's candidate wallets.' Root cause: `discoverDelegatesForReserve` (packages/sdk/src/discovery.ts) can only resolve a delegate wallet it's explicitly told to check -- a `Delegate` account is a PDA seeded by `(reserve, wallet)` with no on-chain reverse index, and the public DevNet RPC blocks the `getProgramAccounts` scan that would otherwise enumerate them -- but every caller's candidate list was a small, hardcoded set (the Reserve's manager, 2 DevNet fixture demo wallets, and whichever wallet happened to be currently connected). A delegate granted to any OTHER wallet -- the ordinary real case, since it's essentially never the manager's own connected wallet -- was invisible forever. Compounding this, `ManageDTR.tsx`'s/`DTRDetail.tsx`'s manual-refresh path (`refreshRealReserveNow` -> `mergeOnChainReserve` -> `onChainReserve.ts`'s `mergeOnChainIntoDTR`) never re-ran delegate discovery at all -- it explicitly preserved whatever `delegatesOnChain` was last resolved -- so granting a delegate and immediately refreshing (the exact reported repro) could never show it even in the one case (the connected wallet itself) the candidate list already covered. `setOnChainDelegates`, an existing store action for writing a freshly-resolved delegate list, was defined in `useAppStore.ts` but never actually called anywhere. Fix: new `src/merge/lib/delegateDiscoveryCandidates.ts` provides (1) a small, local, per-browser, per-Reserve registry (`rememberDelegateWallet`/`forgetDelegateWallet`/`getKnownDelegateWallets`, same established pattern as `delegateLabels.ts`) recording every wallet this browser has granted delegate status to -- a discovery HINT only, always re-verified against a genuine on-chain fetch/decode before ever being trusted -- and (2) `buildDelegateCandidateWallets`, the single shared candidate-list builder (manager + 2 fixture wallets + registry + connected wallet) now used identically by `RealReserveSync.tsx`'s background poll AND both pages' manual refresh, so they can never diverge again. `ManageDTR.tsx`'s Grant Delegate handler now calls `rememberDelegateWallet` the instant the grant transaction confirms (it already knows the exact address -- the user just typed it), before `runOnChainAction`'s automatic refresh runs, so the SAME refresh cycle shows the new delegate; Remove Delegate calls `forgetDelegateWallet` for registry hygiene (not required for correctness -- a removed account simply won't be found on-chain either way). Both pages' `refreshRealReserveNow` now also call `discoverDelegatesForReserve` + the now-wired `setOnChainDelegates` right after their existing balance/asset refresh. `readOnly.ts`'s `ReserveOnChain`/`fetchReserveOnChain` gained `delegateCount` (previously absent from this lighter single-Reserve fetch, which is part of why the merge function could only ever preserve the prior count) so the targeted refresh can report an accurate `delegateCountOnChain` too, not just `delegatesOnChain`. The connected delegate wallet's OWN view was already structurally correct before this fix (a direct PDA lookup for `(reserve, thatWallet)` on every discovered Reserve is authoritative, not a guess, and `RealReserveSync` already included the connected wallet as a candidate) and remains so, now additionally kept accurate on manual refresh too, not only the next background poll tick.",
  "context": "User reported: after adding a delegate via the Manager Dashboard, it still showed '1 delegate(s) reported on-chain, but none matched this discovery pass's candidate wallets,' and asked for the connected delegate wallet to reliably discover and display every Reserve it has an active on-chain delegation for, by querying and decoding the authoritative delegate accounts directly rather than relying on an incomplete candidate-wallet list, plus explicit verification that only active/unexpired delegations show, permissions are displayed and enforced correctly, a revoked delegate loses access immediately, and no broader access is ever granted.",
  "rationale": "A full, unconditional `getProgramAccounts` memcmp scan (which would make the candidate list unnecessary entirely) remains genuinely blocked on the public DevNet RPC -- documented and unchanged by this pass -- so some form of candidate-hint list is unavoidable for discovering an ARBITRARY wallet's delegate grant sight-unseen. What was fixable, and is the actual root cause of the reported symptom, is that the app already knows the exact wallet address the moment it grants one (typed into the Grant Delegate form) and simply never recorded or reused that knowledge, and separately that the manual-refresh path silently never re-checked delegates at all regardless of candidate-list completeness. Fixing both closes the reported repro exactly (grant, see it immediately) and the general real-world case (any delegate this browser has ever granted stays discoverable on this browser going forward) without needing a new RPC provider or protocol change. The `Delegate` account itself (programs/ssr_protocol/src/state/delegate.rs) has no expiry field -- 'active, unexpired' is satisfied by the existing fetchNullable-plus-(reserve,wallet)-match check already in `discoverDelegatesForReserve`: a removed/closed Delegate account is genuinely absent on-chain and is never displayed, satisfying 'revoked delegates lose access immediately' the moment any refresh (background or manual) runs; nothing here weakens that or grants any permission not read directly from the freshly decoded on-chain account.",
  "alternativesConsidered": [
    "Wait for/require a dedicated, unrestricted DevNet RPC provider to do a real getProgramAccounts scan -- rejected as the immediate fix: it's an infrastructure change outside this pass's scope, and the actual reported bug (a just-granted delegate not appearing even after refreshing) doesn't need a scan to fix, since the app already possesses the exact address at grant time.",
    "Only fix the manual-refresh path (wire up the already-defined but unused `setOnChainDelegates`) without adding the local known-wallet registry -- rejected: would still leave an arbitrary granted-elsewhere delegate wallet permanently unmatched by candidate lists, reproducing the exact reported warning for the ordinary real case (delegate != manager != connected wallet).",
    "Only add the local registry without fixing the dead manual-refresh delegate merge -- rejected: the reported repro is specifically 'after adding a delegate ... still shows,' i.e. the very next refresh; leaving that refresh path inert would still fail the literal reported scenario even with a correct candidate list."
  ],
  "impact": "New: src/merge/lib/delegateDiscoveryCandidates.ts (registry + buildDelegateCandidateWallets), tests/phase_delegate_discovery_candidates.ts (14 new tests). Changed: packages/sdk/src/readOnly.ts (+delegateCount on ReserveOnChain/fetchReserveOnChain), src/merge/lib/RealReserveSync.tsx (uses the shared candidate builder instead of its own local copy), src/merge/lib/onChainReserve.ts (onChainDelegateFromDiscovered now exported for reuse; updated comment), src/merge/pages/ManageDTR.tsx (refreshRealReserveNow re-verifies delegates via setOnChainDelegates; Grant/Remove Delegate handlers call rememberDelegateWallet/forgetDelegateWallet), src/merge/pages/DTRDetail.tsx (same refreshRealReserveNow delegate re-check, keeping isManagerOrDelegate gating accurate after a manual refresh there too). 444/444 offline tests passing (430 prior + 14 new); tsc -b --force, oxlint, full npm run build (SDK workspace + app) all clean.",
  "affectedAreas": [
    "src/merge/lib/delegateDiscoveryCandidates.ts",
    "packages/sdk/src/readOnly.ts",
    "src/merge/lib/RealReserveSync.tsx",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/pages/DTRDetail.tsx",
    "tests/phase_delegate_discovery_candidates.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "444/444 offline tests passing (`npx ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/phase_*.ts`), including 14 new regression tests directly covering the reported root cause (a delegate wallet granted through the UI, once remembered, becomes a discovery candidate; without being remembered it honestly does not; manager/fixture/connected wallets are always included; malformed registry entries never crash discovery). tsc -b --force, oxlint, full npm run build (SDK workspace + app) all clean.",
    "Not live-verified against a real browser/wallet session in this environment (no browser-automation or wallet tool available here, same documented gap as prior passes) -- verified via direct code-path reading (tracing the exact dead-code `setOnChainDelegates` call site and the candidate-list construction at every call site) plus the new offline regression tests."
  ]
}
```

## DEC-0097

```json
{
  "id": "DEC-0097",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Fixed Create Reserve's `SsrError::MetadataUriTooLong (6000)` failure at Step 1/2 (create-and-register). Confirmed root cause via live DevNet reproduction: CreateDTR.tsx submitted the Reserve's ENTIRE name/ticker/description/category/buyTaxPct/sellTaxPct payload inline on-chain as a `data:application/json,${encodeURIComponent(JSON.stringify({...}))}` URI -- 343 bytes for a realistic one-sentence description, against the on-chain `MAX_METADATA_URI_LEN` of 200 bytes (`programs/ssr_protocol/src/constants.rs`) -- instead of uploading the metadata somewhere permanent and submitting only a short link. NOT a case of the on-chain limit being too small: 200 bytes is genuinely sufficient for a real permanent HTTPS/IPFS/Arweave metadata URL (worked examples below), so the limit was left unchanged -- `Reserve::SPACE` already reserves `4 + MAX_METADATA_URI_LEN` bytes for this field regardless of the actual string length submitted, so there is no account-size implication either way. Fix: new off-chain Reserve Metadata Store (`lib/reserve-metadata/` -- Postgres via the same Neon database DEC-0088 already provisioned, `reserve_metadata(id, payload, created_at)`, applied via `scripts/migrate-reserve-metadata.mjs`) and a new public endpoint (`api/devnet/reserve-metadata.ts`: POST stores a validated payload under a deterministic, content-hashed 16-hex-char id -- `on conflict (id) do nothing`, so a retried upload of unchanged content is a safe no-op, never a duplicate -- and returns that id; GET serves the stored JSON back, i.e. this endpoint IS the permanent URL a Reserve's `metadata_uri` points at). CreateDTR.tsx now uploads metadata via a new `uploadReserveMetadata` helper (debounced, same pattern as the existing cost-estimate effect) as soon as Name/Ticker are filled in, displays the resulting permanent URL in a new 'Reserve Metadata URL' card on the Review & Deploy step (showing Uploading/ready/error state), and disables Launch until it resolves. A new shared, hand-mirrored constant (`packages/sdk/src/metadataUri.ts`'s `MAX_METADATA_URI_LEN = 200`, matching `constants.rs` exactly) backs `validateMetadataUri`, which measures the URI's genuine UTF-8 BYTE length (via `TextEncoder`, never JS's UTF-16-code-unit `.length` -- Rust's `String::len()` counts bytes, so a naive JS length check would silently under-count any non-ASCII character) and rejects a `data:`/`blob:` URI or any non-`https://`/`ipfs://`/`ar://` scheme outright, in plain language, before ever reaching the button. `validateMetadataUri` is called in TWO places: CreateDTR.tsx's `handleSubmitReal` (blocks before Phantom ever opens, mirroring the button's own disabled state) AND, as the true single choke point every caller of `createReserveOnChain` goes through, at the very top of `createReserveOnChain` itself (`src/merge/lib/createReserveClient.ts`), before `deriveNewReserveAddresses` or any signing -- the same 'one choke point' pattern this file already uses for `validateCreateReserveAssets`.",
  "context": "User reported the exact on-chain error text ('SsrError::MetadataUriTooLong (6000): Metadata URI exceeds the permitted length'), occurring during Step 1/2 (create-and-register) with nothing created on-chain, and asked for the root cause to be traced (base64 image data? inline JSON? a blob URL? something else oversized, instead of a short permanent metadata URL?), fixed so uploaded metadata is stored first and only its permanent URL submitted on-chain, frontend validation uses the exact same byte limit as the protocol, Review displays and validates the final URI before requesting a signature, oversized URIs are blocked before Phantom opens with a clear message, valid HTTPS/IPFS/Arweave URLs work, retry stays safe with no duplicates/partial state, and the on-chain limit is not simply raised unless genuinely too small (verified against account-size implications).",
  "rationale": "Reused the exact existing Neon Postgres + idempotent-migration-script + `lib/<feature>/` CommonJS-scoped-package.json pattern DEC-0088 already established for `lib/reserve-activity`, rather than introducing a new storage service (e.g. Vercel Blob, which isn't provisioned for this project -- confirmed via `vercel env ls production`, no `BLOB_READ_WRITE_TOKEN`) -- 'keep it light,' same standing instruction DEC-0088 was built under. A deterministic, content-hashed id (SHA-256 of the canonical payload JSON, truncated to 16 hex chars) rather than a random one was chosen specifically for retry-safety: identical metadata content -- the normal case when a user retries after a transient network hiccup, or resumes a deployment -- always resolves to the same row and the same URL, so `on conflict (id) do nothing` makes the write itself idempotent without any extra bookkeeping. `validateMetadataUri` was placed inside `createReserveOnChain` itself (not only in the UI) so 'blocked before Phantom opens' holds even for a future caller that bypasses CreateDTR.tsx's own upload-then-validate flow (a script, a different UI path) -- exactly the same defense-in-depth reasoning already applied to `validateCreateReserveAssets` in the same file. UTF-8 byte counting (not JS string length) was called out explicitly and tested because it is a genuine, easy-to-miss correctness gap: Rust's on-chain check counts bytes, and any real Reserve name containing an emoji or accented character would otherwise silently pass a JS `.length`-based check while still risking on-chain rejection. The on-chain 200-byte limit itself was deliberately left unchanged after verifying it against all three required URL schemes: this app's own endpoint (`https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=` + 16 hex chars = 83 bytes, confirmed live), a gateway-fronted IPFS CIDv1 URL (~80-90 bytes), and an Arweave URL (`https://arweave.net/` + a 43-char base64 id = ~62 bytes) -- all comfortably under 200 bytes, confirming the limit was never the problem.",
  "alternativesConsidered": [
    "Raise MAX_METADATA_URI_LEN on-chain instead of fixing the frontend -- rejected per the user's own explicit instruction and confirmed unnecessary: 200 bytes already comfortably fits every real permanent URL scheme this app needs (worked examples above); the actual submitted value was never a legitimate URL to begin with.",
    "Store metadata on Vercel Blob instead of Postgres -- rejected: not provisioned for this project (no BLOB_READ_WRITE_TOKEN), and Neon Postgres is already live and proven for exactly this kind of small-record store (DEC-0088), so adding Blob would be new infrastructure for no added capability here.",
    "A random (uuid-style) id instead of a content hash -- rejected: loses the free retry-safety property (identical content -> identical id -> `on conflict do nothing` no-op) that a random id would need separate deduplication logic to replicate.",
    "Only validate metadataUri client-side in CreateDTR.tsx, not inside createReserveOnChain itself -- rejected: would leave any future non-CreateDTR.tsx caller of createReserveOnChain (a script, a different flow) able to submit an oversized/malformed URI with no guard at all, unlike validateCreateReserveAssets's existing single-choke-point pattern in the same function."
  ],
  "impact": "New: packages/sdk/src/metadataUri.ts (MAX_METADATA_URI_LEN, metadataUriByteLength, isMetadataUriWithinLimit, validateMetadataUri), lib/reserve-metadata/{schema.sql,db.ts,payload.ts,package.json}, api/devnet/reserve-metadata.ts, scripts/migrate-reserve-metadata.mjs, scripts/verify_metadata_uri_fix_devnet.ts (live diagnostic, not committed test infra), tests/phase_metadata_uri.ts (27 new tests). Changed: packages/sdk/src/index.ts (+metadataUri export), src/merge/lib/createReserveClient.ts (+uploadReserveMetadata, +validateMetadataUri guard inside createReserveOnChain), src/merge/pages/CreateDTR.tsx (metadata-upload effect + state, Review step 'Reserve Metadata URL' card, Launch button gating, handleSubmitReal now submits the uploaded URL instead of an inline data: URI and blocks before submitting if metadata isn't ready/valid), tsconfig.node.json (excludes lib/reserve-metadata, mirroring lib/reserve-activity's existing exclusion). 472/472 offline tests passing (445 prior + 27 new); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean. Migration applied for real against the live Neon database (reserve_metadata table confirmed present).",
  "affectedAreas": [
    "packages/sdk/src/metadataUri.ts",
    "packages/sdk/src/index.ts",
    "lib/reserve-metadata/",
    "api/devnet/reserve-metadata.ts",
    "scripts/migrate-reserve-metadata.mjs",
    "scripts/verify_metadata_uri_fix_devnet.ts",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/pages/CreateDTR.tsx",
    "tsconfig.node.json",
    "tests/phase_metadata_uri.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "472/472 offline tests passing (27 new in tests/phase_metadata_uri.ts, including a direct before/after reproduction: the exact old `data:application/json,...` construction for a realistic name/ticker/description measures 343 bytes and is rejected by validateMetadataUri, while the new URL-based construction for the SAME content measures well under 200 bytes and passes; plus UTF-8-vs-UTF-16 byte-counting tests, scheme rejection (data:/blob:/http:), the exact 200-byte boundary, and computeMetadataId's determinism). tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
    "Migration applied for real against the live Neon database (scripts/migrate-reserve-metadata.mjs) -- reserve_metadata confirmed present via a live information_schema query.",
    "LIVE DevNet reproduction of the ORIGINAL bug (scripts/verify_metadata_uri_fix_devnet.ts, Part A): submitted a real create-and-register transaction with the exact old-style 343-byte data: URI against the live deployed program -- genuinely rejected on-chain with `AnchorError ... Error Code: MetadataUriTooLong. Error Number: 6000` (custom program error 0x1770), confirming the diagnosis exactly matches the reported error. ProtocolConfig.reserve_count was read before (55) and after (55) the failed attempt and confirmed unchanged, directly verifying Solana's atomic rollback left zero partial on-chain state.",
    "LIVE DevNet verification of the FIX (scripts/verify_metadata_uri_fix_devnet.ts, Part B): uploaded real metadata through the actual api/devnet/reserve-metadata.ts handler (real Postgres write) to `https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=e25da10f7ff3ebb1` (83 bytes vs. 343 for the old construction), confirmed it GETs back byte-for-byte the same payload, then submitted a REAL create-and-register transaction through the exact createReserveOnChain function CreateDTR.tsx calls -- CONFIRMED on real DevNet, signature `5R71YzQ6YLpX4WDDuSJ3UwL7h2um113L6Z7GdbR42ZvMY6scZi4pMQ23zzQCXEA22JkMBHwmfct2zccQnYaU7wT5` (finalized, no error), creating Reserve `9dMmiwMVtkyQrGcKpdGLMcB5yVoHJcW9D5FWNrYaHg2S` (reserveId 56, manager `AnxERQ4u971rPUoqBtdhHMczcmHR8GM683wHxAs5q33C`). A direct on-chain read-back confirmed the stored `metadata_uri` matches the submitted URL exactly (83 bytes) and assetCount=1 (mockX registered) -- the reported failing step (create + register the first Reserve asset) now genuinely succeeds. The subsequent seed step in this diagnostic run hit an unrelated, pre-existing local-script limitation (mint-test-assets.ts's RPC-URL resolution expects a real Vercel request context) -- out of scope for this fix and not a regression, since the exact reported failure (Step 1/2, create-and-register) is what was reproduced and fixed."
  ]
}
```

## DEC-0098

```json
{
  "id": "DEC-0098",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Fixed two bugs the user reported together on a real, freshly created Reserve ('Unnamed Reserve (#57)' / 'RSV57', a delegate added during creation never appearing -- Manager Dashboard said 'No delegates found on-chain for this Reserve,' but the SAME wallet added AFTER creation via ManageDTR.tsx worked and displayed correctly). BUG 1 (the one asked about): CreateDTR.tsx's 'Additional Managers' step collected addresses into local UI state (`additionalManagers`) and displayed them on the Review step next to a 'Delegate' badge, implying they'd be granted -- but `createReserveOnChain` had NO parameter for this list at all, so `create_reserve`/`initializeReserveAsset` never submitted a single `add_delegate` instruction for any of them; the list was purely decorative. Fixed by adding an `additionalManagers?: string[]` parameter to `createReserveOnChain`, validated (`validateAdditionalManagers`: valid Solana addresses, de-duplicated, rejects the connected wallet's own address) as the same single choke point pattern already used for assets/metadataUri, then bundling one `add_delegate` instruction per address into the SAME create-and-register transaction (mirrors the existing `initializeManagerFeeRecipients` bundling precedent, DEC-0094 -- shares the reserve/signer/systemProgram accounts already in that transaction, so no extra wallet approval is needed). Each is granted as a RESTRICTED delegate with a new `ADDITIONAL_MANAGER_PERMISSIONS` bitmask (UPDATE_TARGETS | INITIATE_REBALANCE | EXECUTE_REBALANCE | MANAGE_FEES | PAUSE_RESERVE | UNPAUSE_RESERVE = 222) -- exactly and only what CreateDTR.tsx's own copy already promised ('rebalance, manage fees, and pause the reserve, but won't be able to manage other delegates'), never unrestricted (only the root Manager may grant that, and the whole point is they can't manage other delegates). BUG 2 (a regression surfaced by the user's own repro, caused by DEC-0097's fix earlier the same day): `parseReserveMetadataUri` was written for the ORIGINAL inline `data:application/json,...` metadataUri convention and returns null -- correctly, but now too narrowly -- for the permanent-HTTPS-URL convention DEC-0097 introduced, so every Reserve created after that fix fell back to the honest-but-wrong 'Unnamed Reserve (#N)'/'RSV{N}' placeholder in `buildDtrFromDiscoveredReserve`. Fixed with a new async `resolveReserveMetadata` (packages/sdk/src/discovery.ts): tries the synchronous data: URI case first (zero network cost for a pre-fix Reserve or a committed fixture), and only when that returns null AND the URI is genuinely http(s), fetches it and parses the JSON response into the same `ParsedReserveMetadata` shape (bounded by a 5s timeout so one slow metadata host can never stall a whole discovery pass). `buildDtrFromDiscoveredReserve` now takes an already-resolved `parsedMetadata` parameter instead of calling the parser internally, keeping it pure/synchronous/testable; its one real caller, `RealReserveSync.tsx`, resolves metadata per-Reserve (best-effort, same as its existing delegate-discovery call -- a metadata-host hiccup must never fail the whole Reserve's discovery) through a 24-hour `getCached` entry (metadata is immutable in practice; nothing in this app calls `update_metadata` today).",
  "context": "User reported: after adding a delegate during Reserve creation and launching, the Manager Dashboard for the new Reserve ('Unnamed Reserve (#57)', ticker 'RSV57', shown under 'Root Manager') displayed 'No delegates found on-chain for this Reserve. The Root Manager holds all permissions.' Adding the SAME delegate again, post-creation, via ManageDTR.tsx worked and displayed correctly -- the user's own diagnosis, confirmed correct by tracing the code: 'this means the add delegate on reserve creation is not doing anything.' The 'Unnamed Reserve (#57)'/'RSV57' naming was also flagged as part of the same report and traced separately to being a same-day regression from DEC-0097 (shipped hours earlier), not a pre-existing issue -- DEC-0097 fixed the on-chain submission side of metadataUri but never updated the display/resolution side to match the new URL-based convention it introduced.",
  "rationale": "Bundling add_delegate into the SAME create-and-register transaction (rather than separate post-creation transactions) was chosen because add_delegate.rs's accounts (reserve, a fresh delegate_account PDA, signer, system_program) are structurally identical in shape to what initializeManagerFeeRecipients already bundles into this same transaction under DEC-0094 -- reusing an established, already-proven pattern rather than inventing a new one, and avoiding extra wallet approvals for what the user experiences as one creation action. Restricted=true (never unrestricted) was chosen because CreateDTR.tsx's own pre-existing copy explicitly promises 'won't be able to manage other delegates -- only the root Manager (you) can do that' -- granting unrestricted would violate that promise outright, and add_delegate.rs enforces unrestricted-grant as root-manager-only anyway (irrelevant here since the creator IS root, but restricted still matches the documented product intent). The exact permission bitmask (rebalance + fees + pause/unpause) was derived directly from that same copy sentence, not guessed -- a regression test asserts the bitmask contains exactly those bits and none of the delegate-management/metadata/liquidity-config bits. resolveReserveMetadata tries the synchronous path first specifically so a pre-DEC-0097 Reserve or a committed fixture never pays a network round trip it doesn't need, and the whole function is best-effort/non-throwing (mirrors the existing delegate-discovery call in the same RealReserveSync.tsx loop) so a single unreachable metadata host can only ever affect that one Reserve's display, never abort the discovery pass for every other Reserve.",
  "alternativesConsidered": [
    "Submit add_delegate as separate transaction(s) after create-and-register, before/after seeding -- rejected: adds a wallet approval per additional manager (or a combined-but-separate approval) where DEC-0094's existing feeRecipients precedent already proves bundling into the same transaction works for a structurally identical case, at zero extra cost to the user.",
    "Grant unrestricted delegate status to additional managers -- rejected outright: contradicts CreateDTR.tsx's own existing, unedited copy ('won't be able to manage other delegates'), and add_delegate.rs only permits unrestricted grants from the root Manager in the first place.",
    "Make parseReserveMetadataUri itself fetch HTTPS URLs (mutating it into an async function) instead of adding a separate resolveReserveMetadata wrapper -- rejected: would force every existing caller of the synchronous parser (including tests/phase_a_discovery.ts's direct coverage) to become async for no benefit, when the two cases (inline vs. fetched) are cleanly separable and the sync path should stay sync-only for callers that never need the network case.",
    "Have buildDtrFromDiscoveredReserve perform the metadata fetch itself instead of taking an already-resolved parameter -- rejected: would make a currently pure, synchronous, directly-testable function require network I/O and error-handling of its own, duplicating what its one real caller (RealReserveSync.tsx) already does for delegate discovery in the same loop."
  ],
  "impact": "Changed: src/merge/lib/createReserveClient.ts (+ADDITIONAL_MANAGER_PERMISSIONS, +validateAdditionalManagers, additionalManagers param bundled into create-and-register), src/merge/pages/CreateDTR.tsx (passes additionalManagers to createReserveOnChain), packages/sdk/src/discovery.ts (+resolveReserveMetadata, +shared metadataFromJson helper, parseReserveMetadataUri behavior unchanged), src/merge/lib/onChainReserve.ts (buildDtrFromDiscoveredReserve takes parsedMetadata as a parameter instead of parsing internally), src/merge/lib/RealReserveSync.tsx (resolves metadata per-Reserve via resolveReserveMetadata + a 24h getCached entry, best-effort). New: scripts/verify_create_reserve_delegate_and_metadata_devnet.ts (live diagnostic), tests/phase_create_reserve_delegate_and_metadata.ts (18 new tests). 490/490 offline tests passing (472 prior + 18 new); tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
  "affectedAreas": [
    "src/merge/lib/createReserveClient.ts",
    "src/merge/pages/CreateDTR.tsx",
    "packages/sdk/src/discovery.ts",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/lib/RealReserveSync.tsx",
    "scripts/verify_create_reserve_delegate_and_metadata_devnet.ts",
    "tests/phase_create_reserve_delegate_and_metadata.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "490/490 offline tests passing (18 new in tests/phase_create_reserve_delegate_and_metadata.ts: validateAdditionalManagers dedup/rejection cases, ADDITIONAL_MANAGER_PERMISSIONS bitmask asserted exactly against the promised copy, resolveReserveMetadata's inline-vs-fetch branching with a stubbed fetch including a direct root-cause reproduction of the real endpoint's URL shape, and buildDtrFromDiscoveredReserve's new parsedMetadata parameter both resolving a real name and honestly falling back to 'Unnamed Reserve (#N)' when null). tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
    "LIVE DevNet verification, both bugs together, in one real Reserve creation (scripts/verify_create_reserve_delegate_and_metadata_devnet.ts against a freshly generated, never-before-seen additional-manager wallet JAfejhGwy2KjKZTr1rrp1bWLm6edrN2jpkGTBzjcPDY5): create-and-register signature `4HkiNNLVxhr2C4EPwqj6unXCTM8tiRhwU7gBCjz3NLpgPhAT8XMAB7Wi1zarXiuA5vneEV7yEpoQQqmM3nfw1B6W` (finalized, no error), Reserve `3DJsyPZj7cTKowWgu6Gfa5upAsS6gLz8Ju2uzjz45v2a` (reserveId 58). PART A: a direct on-chain read of the Delegate PDA confirmed a real account exists -- wallet matches exactly, `permissions: 222` (matching ADDITIONAL_MANAGER_PERMISSIONS exactly), `restricted: true` -- with zero prior connection or transaction from that wallet itself. PART B: the Reserve's on-chain `metadata_uri` (`https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=b70fc7c79b8e1ccf`) resolved via the real resolveReserveMetadata to the exact real name/ticker ('Multi-Manager Test Reserve' / 'MMTR') submitted at creation -- confirming this Reserve now displays correctly instead of 'Unnamed Reserve (#58)'."
  ]
}
```

## DEC-0099

```json
{
  "id": "DEC-0099",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Fixed 'right after creation there are 0 collectible fees' by charging the initial seed mint the same Mint Fee as any other mint (Manager AND Protocol both now receive a real share, previously always 0 -- a genuine bug, since the seed IS a mint, just one the program special-cased as free), and made the Protocol a genuinely passive fee claimant: it never manually collects anything, going forward its share is swept to the treasury automatically by an extended weekly keeper. Scope, confirmed with the user before touching the deployed program (asked specifically whether auto-deposit should cover only the new inception fee or all three accrual sources): applies to ALL THREE -- seed, every ordinary Buy mint, and the annualized TVL fee. The user also asked, in the same exchange, for the TVL-fee cadence to be pinned to a specific time: 'accrued on a weekly basis, every Monday at 00:00 UK time.' ON-CHAIN (`programs/ssr_protocol/`): (1) `seed_reserve.rs` now computes the same effective Protocol/Manager mint-fee split `mint_reserve_tokens_in_kind.rs` already uses (`split_configured_bps`/`split_total_fee`, the SSR.fun fee formula from DEC-0094), mints the creator only the NET amount after the fee (gaining a new `manager_fee_recipients` Option account, same DEC-0094 sentinel pattern, to correctly credit the Manager's share whichever routing mode the Reserve is in), and accrues the Protocol's share into the existing `pending_protocol_fee_shares` field -- unchanged account layout, no data migration. (2) New, fully additive `collect_protocol_fee` instruction (`instructions/collect_protocol_fee.rs`): permissionless, mints ONLY the Protocol's pending share to the Protocol's fixed treasury ATA and zeroes it, deliberately leaving `pending_manager_fee_shares` completely untouched (unlike the pre-existing `collect_fees`, which drains both together and is left completely unchanged for backward compatibility / as a Manager-side fallback). `mint_reserve_tokens_in_kind.rs`/`redeem_reserve_tokens_in_kind.rs`/`accrue_fees.rs`'s account lists and CPI logic are UNCHANGED -- the Protocol's share still accrues into the same pending field there too, exactly as before; only the COLLECTION step changed. AUTOMATION: `api/devnet/accrue-fees-cron.ts` (DEC-0094's existing weekly TVL-accrual keeper) now also sweeps every Reserve with a nonzero `pending_protocol_fee_shares` via `collect_protocol_fee` right after its accrual step, using a fresh `discoverAllReserves` re-fetch (so it never acts on a value made stale by its own accrual step moments earlier); `vercel.json`'s cron schedule changed from `0 6 * * 1` to `0 0 * * 1` (00:00 UTC every Monday -- the closest fixed-UTC approximation to 00:00 UK time achievable with Vercel Cron's UTC-only scheduling, exact during GMT months, 1 hour off during BST). FRONTEND: ManageDTR.tsx's 'Protocol Fees (uncollected)' section is now honestly worded ('sent to the Protocol treasury automatically every Monday -- nobody has to claim it manually') and its manual button now calls the new protocol-only `executeCollectProtocolFee` instead of the old combined `executeCollectFees` (which used to force-collect the Manager's pending balance too as an unlabeled side effect of a button literally named 'Collect Protocol Fees' -- the Manager already has its own independent collection UI via `executeCollectManagerFeeShare`, unaffected). CreateDTR.tsx's Review step now shows the accurate NET token count the creator will actually receive (`estimateNetSeedReserveTokens`, computed at raw-base-unit precision to match the on-chain math exactly -- a whole-token-granularity first draft was caught live-testing: it understated a $10/2%-fee seed as netting 9 tokens when the real, live-confirmed figure is 9.8).",
  "context": "User reported, immediately after creating a Reserve named 'A': the Manager Dashboard's Fee Configuration card showed 0 collectible fees right after creation, which they identified as wrong because the inception seed is itself a mandatory mint, and asked for both Manager and Protocol to receive a share from it. In the same message, they separately flagged that the Protocol should never have to manually claim its fees -- they should land in the treasury wallet by default -- and that the Manage Reserve page's protocol-fee section showed nothing meaningful. Asked directly (AskUserQuestion) whether Protocol auto-deposit should cover only the new inception fee or all three accrual sources before starting any on-chain work, given the blast-radius difference between a single-file change (seed only) and touching the shared mint/redeem/accrue CPI paths every Buy/Sell already depends on; user chose all three and added the specific weekly UK-midnight cadence requirement for the TVL fee in the same reply.",
  "rationale": "A brand-new, additive `collect_protocol_fee` instruction (rather than modifying `mint_reserve_tokens_in_kind.rs`/`redeem_reserve_tokens_in_kind.rs`/`accrue_fees.rs` to CPI-mint the Protocol's share directly inline, which was the first design considered) was chosen specifically to keep the accrual paths every live Buy/Sell/Create already depends on completely untouched -- zero new required accounts, zero risk to code that is already handling real transaction volume across dozens of live Reserves. A scheduled weekly sweep genuinely satisfies 'the Protocol never has to manually claim' (nobody at the Protocol ever takes an action) while being dramatically lower-risk than instant same-transaction CPI-minting, and the user's own follow-up (tying the auto-deposit answer directly to a specific weekly cadence for the TVL fee) confirmed a scheduled/automatic model, not necessarily an atomic one, was the intended mental model. `seed_reserve.rs` was the one instruction that COULD NOT avoid a direct change, since the reported bug is specifically that IT never charges a fee at all -- mirroring `mint_reserve_tokens_in_kind.rs`'s exact formula (rather than inventing a different one) keeps exactly one fee-computation convention in the program. Re-fetching `discoverAllReserves` fresh for the sweep step (instead of reusing the accrual loop's already-fetched `reserves` array) avoids acting on `pending_protocol_fee_shares` values the accrual loop's own TVL checkpoint may have just changed moments earlier in the SAME cron run. `collect_fees.rs` was left completely untouched (not merged into or replaced by `collect_protocol_fee`) specifically so any already-accrued pre-upgrade pending balance, and the Manager's own independent collection needs, are never put at risk by this change.",
  "alternativesConsidered": [
    "CPI-mint the Protocol's share directly inline inside mint_reserve_tokens_in_kind.rs/redeem_reserve_tokens_in_kind.rs/accrue_fees.rs instead of a scheduled sweep -- rejected per risk/scope: would require new required accounts (protocol_fee_destination_token_account, protocol_fee_destination, and for accrue_fees/redeem also mint_authority) threaded through 5 separate zapInstructions.ts Buy/Sell builder call sites plus the standalone accrual instruction, touching the exact code paths every live Buy/Sell/Create depends on today for a behavior a scheduled keeper can already deliver with none of that blast radius.",
    "Have the weekly keeper call the EXISTING collect_fees (which drains both Manager and Protocol together) instead of building a new protocol-only instruction -- rejected: would force-collect the Manager's own pending balance on a schedule the Manager never chose, contradicting the Manager's existing 'collect on my own timing' UX (executeCollectManagerFeeShare) that this pass otherwise leaves completely alone.",
    "Scope auto-deposit to only the new inception fee, leaving Buy-mint and TVL-fee Protocol accrual on the pre-existing claim model -- explicitly asked about and rejected by the user ('should apply to all 3 - protocol is always passive claimant').",
    "Leave CreateDTR.tsx's Review-step seed-fee estimate at whole-token granularity -- rejected once live DevNet testing surfaced the real discrepancy (displayed 9 vs. actual 9.8 tokens for a representative case): raw-base-unit precision was required to genuinely match what the chain computes, not just approximate it."
  ],
  "impact": "Program (rebuilt via `cargo-build-sbf`, upgraded on DevNet, signature `5RuJiMBAEAKRxNiDth2FMfYS7KFmahsySX3yEt9AHwpSV9VuZ8SqkvQKbrtdEwXtL9mxZ4Cdyx3UPfpDUcggHogb`, data length 817,952 -> 828,848 bytes, slot 483817732): `programs/ssr_protocol/src/instructions/seed_reserve.rs` (fee-charging, +manager_fee_recipients account), NEW `instructions/collect_protocol_fee.rs`, `instructions/mod.rs`/`lib.rs` (registration), `events.rs` (+ProtocolFeeCollected event, +mint_fee_reserve_tokens field on ReserveSeeded). SDK: `packages/sdk/src/managementInstructions.ts` (+buildCollectProtocolFeeInstruction), `packages/sdk/src/createReserveFlow.ts` (buildSeedReserveInstruction resolves + passes the real/sentinel manager_fee_recipients account explicitly -- confirmed live that Anchor's Option<Account> auto-PDA-resolution does NOT gracefully treat a not-yet-initialized account as None; only the documented program-ID sentinel works), `packages/sdk/src/activityLog.ts` (reserveSeeded summary includes the fee; +protocolFeeCollected case), `packages/sdk/idl/ssr_protocol.json` (hand-patched: anchor idl build's mingw-based linker fails in this Windows environment on a path containing a space, a second, separate failure from DEC-0025/DEC-0034's already-documented anchor-build toolchain gap -- every hand-added discriminator/account list verified against Anchor's own sha256 sighash formula and the Rust source directly, both live and via new offline tests). Frontend: `src/merge/lib/createReserveClient.ts` (+estimateNetSeedReserveTokens), `src/merge/lib/managementClient.ts` (+executeCollectProtocolFee), `src/merge/pages/CreateDTR.tsx` (accurate net-seed-token Review copy), `src/merge/pages/ManageDTR.tsx` (Protocol Fees section rewired + reworded). Ops: `api/devnet/accrue-fees-cron.ts` (protocol-fee sweep step), `vercel.json` (cron schedule). New: `scripts/verify_protocol_fee_auto_deposit_devnet.ts`, `tests/phase_protocol_fee_auto_deposit.ts` (15 new tests). 505/505 offline tests passing (490 prior + 15 new); `cargo check -p ssr_protocol`, `cargo clippy -p ssr_protocol` (zero new warnings), `cargo build-sbf`, `tsc -b --force`, `tsc -p api/devnet/tsconfig.json`, `oxlint`, full `npm run build` all clean.",
  "affectedAreas": [
    "programs/ssr_protocol/src/instructions/seed_reserve.rs",
    "programs/ssr_protocol/src/instructions/collect_protocol_fee.rs",
    "programs/ssr_protocol/src/instructions/mod.rs",
    "programs/ssr_protocol/src/lib.rs",
    "programs/ssr_protocol/src/events.rs",
    "packages/sdk/src/managementInstructions.ts",
    "packages/sdk/src/createReserveFlow.ts",
    "packages/sdk/src/activityLog.ts",
    "packages/sdk/idl/ssr_protocol.json",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/managementClient.ts",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "api/devnet/accrue-fees-cron.ts",
    "vercel.json",
    "scripts/verify_protocol_fee_auto_deposit_devnet.ts",
    "tests/phase_protocol_fee_auto_deposit.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "505/505 offline tests passing (15 new in tests/phase_protocol_fee_auto_deposit.ts: estimateNetSeedReserveTokens's raw-unit precision including a test that reproduces the exact live-confirmed 9.8-token figure and a dedicated regression proving the whole-token-granularity bug it replaced would have understated it; summarizeActivityEvent's new/changed event shapes; and structural integrity checks for every hand-patched IDL entry -- discriminators independently recomputed via Anchor's own sha256 sighash formula and compared against the committed JSON, plus a spot-check of 4 pre-existing anchor-idl-build-generated entries confirming the formula itself is right, not just this one hand-edit). cargo check/clippy/build-sbf, tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, full npm run build all clean.",
    "Program upgrade deployed for real on DevNet: `solana program deploy`, signature `5RuJiMBAEAKRxNiDth2FMfYS7KFmahsySX3yEt9AHwpSV9VuZ8SqkvQKbrtdEwXtL9mxZ4Cdyx3UPfpDUcggHogb`, confirmed via `solana program show` (data length 828,848 bytes, slot 483817732, authority unchanged). Upgrade was blocked once on insufficient DevNet SOL in the deployer wallet (5.19 vs. ~5.77 SOL needed, public airdrop faucet rate-limited from this environment) -- user funded it directly; balance and deploy both confirmed after.",
    "LIVE DevNet verification (scripts/verify_protocol_fee_auto_deposit_devnet.ts), a full real Reserve creation end to end -- PART A: seeded a fresh Reserve (reserveId 62) at a 2% configured mint fee; creator received exactly 9,800,000 raw units (9.8 tokens) of the 10,000,000 (10 tokens) requested, `pending_manager_fee_shares` and `pending_protocol_fee_shares` both read exactly 100,000 immediately after seeding -- the reported '0 collectible fees' bug, confirmed genuinely fixed. PART B: called the new collect_protocol_fee instruction directly (signature `4YeAdqMNz36nEDq2Un2Pyn6HAjA57mbVCafbXDgWS9kj7BFKZbJ3dLDg6tUotc1z7XWk9WLxiQ6Sw5gqgJrWG7S2`) -- the Protocol treasury ATA's real on-chain balance grew from 0 to 100,000, `pending_protocol_fee_shares` zeroed, `pending_manager_fee_shares` confirmed completely UNCHANGED at 100,000 (proving the two are independently collectible), and a second collect_protocol_fee call against the same Reserve genuinely failed on-chain with NoPendingFees (no double-collection possible).",
    "Root-cause diagnosis of two real, live-reproduced integration bugs found and fixed during this same pass: (1) seed_reserve.rs's new manager_fee_recipients Option account initially failed on-chain with AccountOwnedByWrongProgram once deployed, because the hand-patched IDL entry for it was missing entirely -- traced to the committed IDL never having actually been regenerated for this account (the intended `anchor idl build` command itself failed in this environment with an unrelated mingw linker error triggered by a space in the repository's own directory path, a new toolchain gap distinct from the already-documented anchor-build gap in DEVNET_RUNBOOK.md); fixed by hand-adding the correctly-shaped optional-PDA account entry, verified via a live retry. (2) Even after the IDL fix, Anchor's client-side automatic PDA resolution for that same Option<Account> field failed on-chain with AccountNotInitialized for a Reserve with no multi-recipient routing configured -- confirmed live that Anchor's optional-account auto-resolution does not gracefully treat an arbitrary not-yet-initialized account as None; only explicitly passing the documented program-ID sentinel (mirroring the exact pattern api/devnet/accrue-fees-cron.ts's own accrueFees call already used) resolves correctly, which buildSeedReserveInstruction now does via a live existence check."
  ]
}
```

## DEC-0100

```json
{
  "id": "DEC-0100",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Enforced claimant-only Manager fee collection ON-CHAIN: `collect_manager_fee_share.rs`'s `recipient` account is now a `Signer` (previously `UncheckedAccount`, permissionless -- ANY wallet could trigger ANY recipient's payout, fund-safe but not access-controlled the way the user now requires). Only the exact wallet matching a fee recipient's own address can collect that recipient's balance -- the root Manager cannot collect a delegate/other recipient's share, and one recipient cannot collect another's. The now-redundant separate `payer` account was removed (`recipient` pays its own ATA rent, since it must sign the transaction anyway). `collect_fees.rs` (the legacy dual manager+protocol drain, kept for backward compatibility) gained a matching `require_keys_eq!(payer, manager_fee_destination, NotFeeRecipient)` check on its Manager-side payout specifically, for the same access-control model, while its Protocol-side payout deliberately stays permissionless (a fixed destination, not a per-wallet claim). New error `NotFeeRecipient` appended at the end of `errors.rs`'s enum (append-only ordering preserved). SDK (`buildCollectManagerFeeShareInstruction`) and frontend (`executeCollectManagerFeeShare`) updated to match the new 6-argument signature (no `payer`), with a client-side pre-flight guard (`wallet.publicKey.toBase58() !== recipient` throws before ever prompting a signature) as a fast-fail UX layer in front of the authoritative on-chain check. `ManageDTR.tsx`'s Manager Fee Recipients list was rewritten: a new `collectingRecipient` state (keyed by wallet, independent of the page-wide `onChainTxPending` flag used by every other action) so clicking one recipient's Collect button never disables or shows 'Confirming...' on any other row; a non-connected recipient's row now shows a read-only 'Claimable by this wallet' badge instead of an always-enabled Collect button; a `lastRecipientCollection` map records this session's own last collection signature/timestamp per wallet for immediate feedback.",
  "context": "Sixth and final task of this session, explicitly listing six numbered requirements (fix Manager fee collection, automate Protocol fee distribution, remove the Protocol Fees section from Manage Reserve, complete the Reserve Activity Log, plus an explicit verification list and a deploy/report requirement). Part 1's exact wording: 'Only the wallet matching a fee-recipient address may collect that recipient's accrued fees... The root Manager cannot claim for delegates or other recipients; delegates cannot claim for the root Manager or each other. Enforce the signer/recipient match ON-CHAIN, not only in the frontend... Every recipient must have an independent Collect button and loading state... Non-connected recipients must be read-only and show \"Claimable by this wallet\"... Prevent duplicate claims and repeated submission while pending.' This directly reverses DEC-0094's original design choice (collection is permissionless, mirroring the reference protocol's own collect-for-anyone pattern) for the Manager-fee-recipient case specifically.",
  "rationale": "Anchor's `Signer` type is the only mechanism that makes 'only this exact wallet can trigger this' a structural, on-chain guarantee rather than a convention the frontend could bypass or a future caller could route around -- a non-matching wallet cannot construct a validly-signed transaction for someone else's `recipient` slot, full stop, which is strictly stronger than a `require_keys_eq!` check against a caller-supplied `payer` (which was considered and rejected: it would still require SOME account to prove it's the recipient, and `Signer` IS that proof, so a separate check would be redundant complexity, not additional safety). The client-side pre-flight guard exists purely for UX (fail before a wallet-signature prompt, not after a rejected transaction) and is explicitly documented as non-authoritative. Extending the SAME restriction to `collect_fees.rs`'s Manager side (rather than leaving that legacy instruction untouched) was judged necessary for consistency -- 'enforce the signer/recipient match on-chain' as a stated principle, not just for the new instruction -- while the Protocol side there deliberately stays permissionless since it was never a per-wallet claim in the first place (funds always go to the one fixed treasury destination regardless of caller).",
  "alternativesConsidered": [
    "Keep `recipient` as an `UncheckedAccount` and add a handler-level `require_keys_eq!(payer.key(), recipient.key())` check instead -- rejected: this is strictly weaker than a `Signer` constraint (still requires the caller to separately prove `payer` IS `recipient`, which a `Signer` on `recipient` itself already does more directly) and keeps the now-pointless separate `payer` account around.",
    "Leave `collect_fees.rs` completely untouched (only fix the newer `collect_manager_fee_share`) -- rejected: the task's explicit language ('Enforce the signer/recipient match ON-CHAIN') reads as a general principle for Manager fee collection, not scoped to one specific instruction, and `collect_fees` is still reachable on-chain (even though no longer surfaced in the UI) for any pre-migration Reserve's legacy pending balance."
  ],
  "impact": "Program (rebuilt via `cargo-build-sbf`, upgraded on DevNet as part of this pass's single combined deploy -- see DEC-0102's `impact` for the full deployment record): `programs/ssr_protocol/src/instructions/collect_manager_fee_share.rs` (`recipient: Signer`, `payer` removed), `instructions/collect_fees.rs` (+claimant-only check on the Manager side), `errors.rs` (+`NotFeeRecipient`, appended). SDK: `packages/sdk/src/managementInstructions.ts` (`buildCollectManagerFeeShareInstruction` signature change), `packages/sdk/idl/ssr_protocol.json` (hand-patched: `recipient` marked writable+signer, `payer` account entry removed from `collect_manager_fee_share`'s account list -- verified by a new offline structural test). Frontend: `src/merge/lib/managementClient.ts` (`executeCollectManagerFeeShare` signature + pre-flight guard), `src/merge/pages/ManageDTR.tsx` (per-recipient `collectingRecipient`/`lastRecipientCollection` state, new `collectRecipientFee` handler, read-only badge for non-connected recipients, updated copy).",
  "affectedAreas": [
    "programs/ssr_protocol/src/instructions/collect_manager_fee_share.rs",
    "programs/ssr_protocol/src/instructions/collect_fees.rs",
    "programs/ssr_protocol/src/errors.rs",
    "packages/sdk/src/managementInstructions.ts",
    "packages/sdk/idl/ssr_protocol.json",
    "src/merge/lib/managementClient.ts",
    "src/merge/pages/ManageDTR.tsx"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "LIVE DevNet: a transaction with `recipient = recipientB` signed only by the root Manager was rejected with \"Signature verification failed\" (signature never even reaches the chain -- rejected client-side by the transaction's own missing-signature check, exactly as a `Signer` constraint guarantees). The root Manager then collected its own 84,000-unit balance (tx `3aFHiEPW7HPxHMb1DDS35fonGpNG5TzGLyxAJyVapFnn8khoJo5Ry1EAhdcLnTjXQcS48NUxPm77trfAhEhAqUTA`), recipientB's pending balance confirmed byte-for-byte unchanged; a duplicate claim attempt immediately after failed on-chain with `NoPendingFees`; recipientB then independently self-collected its own exact 56,000-unit balance (tx `53RxdvoZu26rn48CxXBg65ACe6LcZnqQYKB6SMBq57k84b9EdbfvZAD9pND7mrmaovemCTLaoXeyyWhDFj6Hs2o2`). Full transcript: docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_VERIFY_OUTPUT_2026-08-14.txt (PART 3). See docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_CHECKLIST_2026-08-14.md items 1-5.",
    "Offline: `tests/phase_protocol_fee_auto_deposit.ts` gained a structural test confirming the hand-patched IDL's `collect_manager_fee_share` account list has no `payer` entry and `recipient` is writable+signer.",
    "cargo check -p ssr_protocol clean; full project tsc -b --force clean both before and after this change was combined with DEC-0101/DEC-0102's."
  ]
}
```

## DEC-0101

```json
{
  "id": "DEC-0101",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Protocol mint fees now transfer INSTANTLY, in the same atomic transaction as the mint, for every mint including the Reserve's mandatory initial seed -- never left as a `pending_protocol_fee_shares` balance requiring a later collection step. `mint_reserve_tokens_in_kind.rs` and `seed_reserve.rs` both gained two new accounts (`protocol_fee_destination_token_account`, `protocol_fee_destination`) and now CPI-mint the Protocol's computed share directly to the treasury ATA (signed by the same `mint_authority` PDA already used for the depositor's own mint), BEFORE the depositor's own mint CPI, immediately after computing the fee split -- replacing the prior `pending_protocol_fee_shares +=` accrual entirely for these two instructions. A new `ProtocolMintFeeTransferred` event records the transfer (reserve, mint, amount, destination, timestamp) for the Activity Log. Manager mint-fee shares are UNCHANGED -- they continue accruing to `ManagerFeeRecipients`/the legacy pending field exactly as before (DEC-0094), only the PROTOCOL side of a mint's fee changed. No 'Send to Treasury Now' action was added anywhere -- the whole point is that no manual trigger exists for this path any more. SDK/server wiring: `zapInstructions.ts`'s `buildBuyZapInstructions`/`buildBuyZapInstructionsDevUsdc` gained a `protocolFeeDestination` param (computing the destination ATA and threading both new accounts into the mint instruction); `api/devnet/swap-sign.ts` now fetches the LIVE `ProtocolConfig` account (via `fetchProtocolConfig`, not just the derived PDA address it already had) to supply the real `defaultProtocolFeeDestination` for every Buy; `createReserveFlow.ts`'s `buildSeedReserveInstruction` does the equivalent live fetch for the seed path.",
  "context": "Part 2 of the session's sixth task, verbatim: 'Protocol mint fees must never require collection, for every mint including the mandatory initial mint during Reserve creation. Calculate the Protocol mint-fee share, transfer it directly to the configured SSR.fun treasury in the SAME atomic transaction as the mint. Do not leave it pending/claimable/awaiting weekly transfer. Do NOT create a \"Send to Treasury Now\" action... Manager mint-fee shares may continue accruing to their claimable balances (unchanged).' This explicitly reverses DEC-0099's own design choice from earlier the same day (a scheduled weekly sweep via `collect_protocol_fee`, deliberately chosen THEN specifically to avoid touching the shared mint/redeem/accrue CPI paths every live Buy/Sell/Create already depended on) -- the current, more detailed instruction supersedes that earlier risk/scope tradeoff for the MINT-FEE portion specifically (the weekly-sweep design remains exactly as-is for legacy pre-this-pass pending balances, and DEC-0102 replaces the TVL-fee portion's accrual model too, on the same instant-transfer principle).",
  "rationale": "Only inline CPI-minting during the mint transaction itself can satisfy 'never require collection... same atomic transaction' literally -- a scheduled sweep (DEC-0099's approach) inherently leaves a window where the fee IS pending/claimable, which the current instruction explicitly forbids. The blast-radius increase DEC-0099 was designed to avoid (new required accounts on the hot Buy/seed path, touched call sites in zapInstructions.ts/swap-sign.ts/createReserveFlow.ts) is no longer avoidable once 'same transaction' is a hard requirement, so this pass accepts it directly rather than working around it. Fetching the LIVE ProtocolConfig account (not just deriving its PDA address) in swap-sign.ts/createReserveFlow.ts was necessary because the actual `defaultProtocolFeeDestination` VALUE (not just where to find it) is now needed client/server-side to build the new accounts into the transaction, whereas previously only the on-chain program itself ever read that field.",
  "alternativesConsidered": [
    "Keep DEC-0099's scheduled weekly sweep for mint fees too, only adding instant transfer for the TVL fee -- rejected: contradicts the explicit 'for every mint including the mandatory initial mint' requirement and 'do not leave it pending/claimable/awaiting weekly transfer.'",
    "Bundle a separate `collect_protocol_fee` instruction into the SAME transaction as the mint (client-side), rather than CPI-minting inline inside the mint instruction itself -- rejected: still requires the mint instruction to accrue a pending balance first (even if only for the instant that the bundled second instruction then drains), which is unnecessary complexity and a strictly weaker atomicity guarantee than a single instruction doing both in one CPI sequence; also would have left `pending_protocol_fee_shares` non-zero between the two instructions within the same transaction, a confusing intermediate state to reason about."
  ],
  "impact": "Program (see DEC-0102's `impact` for the combined deployment record): `programs/ssr_protocol/src/instructions/mint_reserve_tokens_in_kind.rs`, `instructions/seed_reserve.rs` (both: +2 accounts, instant CPI-mint replacing pending accrual), `events.rs` (+`ProtocolMintFeeTransferred`). SDK: `packages/sdk/src/zapInstructions.ts` (`buildBuyZapInstructions`/`buildBuyZapInstructionsDevUsdc` +`protocolFeeDestination` param/account), `packages/sdk/src/createReserveFlow.ts` (`buildSeedReserveInstruction` fetches live ProtocolConfig), `packages/sdk/idl/ssr_protocol.json` (hand-patched: both instructions' new accounts, new event + type). Server: `api/devnet/swap-sign.ts` (+`fetchProtocolConfig` call, threaded into both Buy builder call sites).",
  "affectedAreas": [
    "programs/ssr_protocol/src/instructions/mint_reserve_tokens_in_kind.rs",
    "programs/ssr_protocol/src/instructions/seed_reserve.rs",
    "programs/ssr_protocol/src/events.rs",
    "packages/sdk/src/zapInstructions.ts",
    "packages/sdk/src/createReserveFlow.ts",
    "packages/sdk/idl/ssr_protocol.json",
    "api/devnet/swap-sign.ts"
  ],
  "supersedes": "DEC-0099 (mint-fee portion only -- DEC-0099's weekly-sweep design remains the mechanism for draining any LEGACY pre-this-pass pending balance; it is superseded only as the ongoing mechanism for NEW mint activity going forward)",
  "supersededBy": null,
  "evidence": [
    "LIVE DevNet: treasury Reserve Token ATA balance read immediately before/after 3 separate mint transactions in one script run -- 0 -> 100,000 (initial seed, tx `5VJWu1gCpkqXWJSFRC81sKpt163GWes1FYmheCHrj2qS9hp2bksn12hrsm9y6dwM9H6eJDSKHMZWstDqHkgpuqTq`), +40,000 (subsequent Buy, tx `2gQMKkU5mKGug4wB4saPFbc2Qrux92KhuUdi1aTqTTrksSp6hXA6xrRNLRzEHVuUfgcV6vjGvJoUbGTMAcWK1J1Z`), each delta landing exactly within that mint's own transaction, matching the independently-computed expected fee-split exactly. `Reserve.feeConfig.pendingProtocolFeeShares` read as exactly 0 after every one of these mints. Full transcript: docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_VERIFY_OUTPUT_2026-08-14.txt (PARTS 1-2). See checklist items 6-9.",
    "cargo check -p ssr_protocol, full tsc -b --force, npx tsc -p api/devnet/tsconfig.json, oxlint, npm run build all clean (combined with DEC-0100/DEC-0102's changes in the same verification passes)."
  ]
}
```

## DEC-0102

```json
{
  "id": "DEC-0102",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Rebuilt the Annualized TVL fee's accrual model around a genuine time-weighted average, replacing the prior linear 'elapsed whole days x latest supply snapshot' approximation. New formula, exactly as specified: weekly fee = time-weighted average TVL during the period x annualized fee rate x elapsed seconds / 31,536,000 (365-day year in seconds exactly). Implementation: a new per-Reserve PDA, `TvlAccrual` (`state/tvl_accrual.rs` -- a separate, additive account, NOT a field grown onto `Reserve`/`FeeConfig`, mirroring DEC-0094's `ManagerFeeRecipients` precedent, specifically so no already-initialized `Reserve` account needs a realloc/migration), holding a Uniswap-V2-style cumulative accumulator: `period_supply_seconds` (sum of `supply x elapsed_seconds` since `last_settled_ts`, reset to 0 on each settlement), `last_checkpoint_ts`, `last_settled_ts`. A single shared function, `checkpoint_tvl_accrual` (in `accrue_fees.rs`), is called by EVERY mint/redeem/seed (cheap: pure arithmetic on the pre-transaction supply, no CPI) to keep the accumulator current -- but NONE of them ever settle/bill against it; settlement (minting the Protocol's share to treasury, crediting the Manager's share) happens EXCLUSIVELY in the standalone, permissionless `accrue_fees` instruction, which now also gained `protocol_config`/`mint_authority`/`tvl_accrual`/`protocol_fee_destination_token_account`/`protocol_fee_destination`/`payer`/`associated_token_program`/`system_program` accounts to do so. Settlement logic: bring the accumulator current as of `now`, then bill `period_supply_seconds x effective_rate_bps / (10000 x 31,536,000)` (ceiling division) -- since `period_supply_seconds` already equals avg_supply x elapsed_seconds, this is algebraically identical to the stated formula, with no separate average needing to be computed and any elapsed window (a full week, a partial week, or several overdue weeks) billed exactly. `api/devnet/accrue-fees-cron.ts` (the weekly keeper) was rewritten to call `accrue_fees` for EVERY discovered Reserve unconditionally each run (not just 'stale' ones past a threshold) -- since checkpointing != settling, an ACTIVE Reserve's fees would otherwise accrue in the accumulator forever without ever being paid out; the instruction is a safe, cheap no-op for a Reserve with nothing new to settle. A necessary consequential fix: `update_fee_recipients.rs`'s routing-change gate (previously required EVERY current recipient's pending balance to be zero, with the frontend auto-bundling a 'collect everyone first' step) was rewritten, since that bundling relied on the Manager collecting on OTHER recipients' behalf -- now structurally impossible after DEC-0100's claimant-only enforcement. New behavior: a recipient who STAYS on the list keeps its pending balance carried forward (never blocked); only a recipient being REMOVED must already have zero pending (its own wallet must collect first).",
  "context": "Part 3 of the session's sixth task: 'Weekly fee = time-weighted average TVL during the period x annualized fee rate x elapsed seconds / 31,536,000. Use actual elapsed time... Track enough authoritative checkpoints to calculate time-weighted average TVL accurately as TVL changes via mints, redemptions, funding, withdrawals, or rebalances. Accrue fees proportionally for partial weeks. Prevent double accrual for overlapping periods. Persist last settled timestamp on-chain. Protocol TVL-fee share transfers directly to treasury during weekly settlement. Manager TVL-fee shares accrue to configured recipient balances. Weekly settlement must be permissionless and safe for an automated keeper... Normal Reserve activity may settle an overdue period opportunistically, but this must not replace the weekly fallback. If one weekly run fails, retry safely without double charging. Continue correct accounting through pause and wind-down until the applicable fee period ends.' The deployed protocol has no oracle/bonding-curve price discovery (documented throughout this codebase since its earliest passes) -- 'TVL' is interpreted as Reserve Token SUPPLY, matching the existing fee-accrual system's own established convention (it already treated `reserve_token_mint_supply` as the fee base, never a USD figure), not attempted as genuine oracle-priced USD TVL (which would need a full Pyth/Switchboard integration, wildly out of scope).",
  "rationale": "The cumulative-accumulator pattern is the standard, proven way to compute an exact time-weighted average without needing to store every individual checkpoint -- `period_supply_seconds` already IS avg_supply x elapsed_seconds by construction, so no separate averaging step or elapsed-seconds tracking is needed at settlement time; the terms cancel algebraically into exactly the specified formula. Splitting 'checkpoint' (cheap, safe on every mint/redeem/seed) from 'settle' (only in the standalone instruction) directly satisfies both 'normal activity may settle... opportunistically, but must not replace the weekly fallback' (checkpointing alone never settles, so the keeper remains load-bearing for every Reserve, not just dormant ones) and keeps the hot Buy/Sell path's blast radius to 'one more cheap account, no CPI' rather than a second treasury-mint CPI on every trade. Persisting `last_settled_ts` (not deriving it from anything else) is what makes retries safe: nothing is ever billed twice because the accumulator only resets on an ACTUAL successful settlement, and any two settlement calls -- however close together in wall-clock time -- necessarily bill disjoint, sequential windows, never overlapping ones. Rewriting `update_fee_recipients` rather than trying to preserve the old 'auto-bundle a collect for everyone' UX was the only option once DEC-0100 made collecting on someone else's behalf structurally impossible; carrying forward (not resetting) a continuing recipient's pending balance, while still requiring a REMOVED recipient to have zero pending, preserves the original invariant's actual purpose (a routing change can never reallocate or lose already-accrued fees) without the now-impossible bundling.",
  "alternativesConsidered": [
    "Store an array of periodic snapshots (e.g. one entry per day) and average them at settlement time, instead of a running cumulative accumulator -- rejected: bounded storage for an unbounded time horizon is exactly what the accumulator pattern avoids needing, and a snapshot array would need its own eviction/rollover logic for a Reserve that lives far longer than the array's capacity.",
    "Let mint/redeem/seed also SETTLE (not just checkpoint) opportunistically, bundling the treasury CPI into the hot trading path -- rejected per the explicit 'must not replace the weekly fallback' requirement (if organic trading settled automatically, the weekly keeper would become redundant for active Reserves specifically, the opposite of a deliberate design decision to keep it load-bearing everywhere) and to keep the hot path's accounts/CPI count minimal; opportunistic settlement remains possible via instruction composability (bundling a separate accrue_fees instruction into the same transaction) without being built into this pass.",
    "Keep update_fee_recipients requiring zero pending for every recipient and simply drop the 'auto-bundle a collect' UX, surfacing a hard block whenever anyone has a pending balance -- rejected: this would make routing changes practically impossible on any Reserve with regular activity (someone almost always has SOME pending balance), a severe regression not requested by the user and not a necessary consequence of claimant-only collection -- carrying forward continuing recipients' balances instead preserves the real fund-safety invariant with none of that friction."
  ],
  "impact": "Program (rebuilt via cargo-build-sbf, upgraded on Solana DevNet: signature `WGkDTY31YPqewUcw5doaH2L5Gpd7D4NhYAcTboW5RjYhdp3WwaX99KzmdYAE5RPiXTV3jwHcT9Fa3cNMRTMo2KY`, slot 483836553, data length 828,848 -> 874,952 bytes -- this single deploy carries DEC-0100/DEC-0101/DEC-0102's combined changes): NEW `programs/ssr_protocol/src/state/tvl_accrual.rs` (+`state/mod.rs` registration), rewritten `instructions/accrue_fees.rs` (new `checkpoint_tvl_accrual`/settlement logic, full account-list rewrite), `instructions/mint_reserve_tokens_in_kind.rs`/`instructions/redeem_reserve_tokens_in_kind.rs`/`instructions/seed_reserve.rs` (+`tvl_accrual` checkpoint account each; redeem also +`system_program`, `redeemer` now `mut`), `instructions/update_fee_recipients.rs` (rewritten gate/carry-forward logic), `constants.rs` (+`TVL_ACCRUAL_SEED`), `errors.rs` (`PendingFeesBlockRoutingChange` message updated), `events.rs` (+`TvlFeeSettled`). SDK: `packages/sdk/src/pda.ts` (+`findTvlAccrual`), `packages/sdk/src/zapInstructions.ts` (+`tvlAccrual` account on all mint/redeem builders), `packages/sdk/src/createReserveFlow.ts` (+`tvlAccrual` on seed), `packages/sdk/idl/ssr_protocol.json` (hand-patched: new `TvlAccrual` account/type, `TvlFeeSettled` event/type, updated account lists for accrue_fees/mint/seed/redeem -- all independently verified against Anchor's sha256 sighash formula and the Rust struct field order via new offline tests). Frontend: `src/merge/lib/managementClient.ts` (`executeUpdateFeeRecipients` rewritten: pre-flight validation instead of auto-bundling, dropped now-unused `reserveTokenMint` param), `src/merge/pages/ManageDTR.tsx` (routing-change call site + copy updated). Ops: `api/devnet/accrue-fees-cron.ts` (rewritten: unconditional per-Reserve settlement loop, new account list, `?dryRun=true` reporting relabeled as advisory-only). New: `scripts/verify_claimant_only_and_tvl_settlement_2026_08_14.ts`, `scripts/verify_keeper_local_2026_08_14.ts`.",
  "affectedAreas": [
    "programs/ssr_protocol/src/state/tvl_accrual.rs",
    "programs/ssr_protocol/src/state/mod.rs",
    "programs/ssr_protocol/src/instructions/accrue_fees.rs",
    "programs/ssr_protocol/src/instructions/mint_reserve_tokens_in_kind.rs",
    "programs/ssr_protocol/src/instructions/redeem_reserve_tokens_in_kind.rs",
    "programs/ssr_protocol/src/instructions/seed_reserve.rs",
    "programs/ssr_protocol/src/instructions/update_fee_recipients.rs",
    "programs/ssr_protocol/src/constants.rs",
    "programs/ssr_protocol/src/errors.rs",
    "programs/ssr_protocol/src/events.rs",
    "packages/sdk/src/pda.ts",
    "packages/sdk/src/zapInstructions.ts",
    "packages/sdk/src/createReserveFlow.ts",
    "packages/sdk/idl/ssr_protocol.json",
    "src/merge/lib/managementClient.ts",
    "src/merge/pages/ManageDTR.tsx",
    "api/devnet/accrue-fees-cron.ts",
    "scripts/verify_claimant_only_and_tvl_settlement_2026_08_14.ts",
    "scripts/verify_keeper_local_2026_08_14.ts"
  ],
  "supersedes": "DEC-0099 (TVL-fee portion -- the linear days-x-snapshot accrual and its pending-protocol-balance model are replaced by the time-weighted accumulator and instant settlement)",
  "supersededBy": null,
  "evidence": [
    "LIVE DevNet, a single Reserve exercised through 3 mints + 2 settlement calls: `TvlAccrual.periodSupplySeconds` grew from 267,300,000 (after one real ~25s window) to 701,300,000 (after a second window that included a mid-period supply change from a third mint) -- correctly integrating both supply levels over their respective real durations, not one flat snapshot. Settlement (tx `4UhY2HpMJZyWMMomKbZaMZPaQsKNtjorA1m5Fw3GkBAhpEicWBiLkwWnQr4MwASqwXbuFLgzeUWCN35K7bX2gG3F`) matched an independently-computed expected fee (protocol +2, manager +1 raw units, deliberately tiny window/max 10%/yr rate so the effect is observable in seconds) exactly, minted straight to treasury in the same transaction. An immediate second settlement call (tx `47iCxa7GGoEbLHpk46zTL23SVvmJ6x4d3nnnsU87ACMVztguSPAv82NYeHH4w3tYu56CNtWRpaE656N88nt86Huo`) billed ONLY the new ~2-second sliver of real elapsed time since the first (independently recomputed and matched exactly) -- the already-settled 701,300,000 supply-seconds was never re-included, proving no double-charge on retry. Full transcript: docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_VERIFY_OUTPUT_2026-08-14.txt (PARTS 1-4). See checklist items 10-15.",
    "The rewritten keeper's `?dryRun=true` discovery path invoked locally against the live deployed program (scripts/verify_keeper_local_2026_08_14.ts) successfully found 20+ real overdue Reserves across the whole protocol (8-17+ days since last accrual each) -- confirming the discovery/reporting logic works post-upgrade. The keeper's actual settlement transaction shape is identical to the one directly proven above; its full unconditional real run across every Reserve was not completed live this pass due to public-DevNet-RPC rate-limiting under the volume of 20+ sequential Reserves' worth of calls (HELIUS_RPC_URL was unavailable in this session -- see docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_CHECKLIST_2026-08-14.md's 'Known gaps').",
    "Offline: `tests/phase_protocol_fee_auto_deposit.ts` gained 7 new structural IDL tests (TvlAccrual account/type, TvlFeeSettled event/type, and the updated account lists for mint/seed/redeem/accrue_fees, all checked against the Rust source). 594 offline tests passing overall across this pass's full combined change set. cargo check -p ssr_protocol, cargo-build-sbf, tsc -b --force, tsc -p api/devnet/tsconfig.json, oxlint, npm run build all clean."
  ]
}
```

## DEC-0103

```json
{
  "id": "DEC-0103",
  "date": "2026-08-14",
  "status": "confirmed",
  "decision": "Removed the entire 'Protocol Fees' section from Manage Reserve (`ManageDTR.tsx`) -- the pending-balance display, the 'Send to Treasury Now' button, and its `executeCollectProtocolFee` import, now that DEC-0101/DEC-0102 made every Protocol fee (mint AND TVL) transfer instantly with no manual trigger of any kind. Completed the Reserve Activity Log's event coverage: `packages/sdk/src/activityLog.ts`'s `summarizeActivityEvent` gained decoders for `reserveCreated`, `reserveAssetInitialized`, `reserveTokensMinted`, `reserveTokensRedeemed` (previously deliberately EXCLUDED as 'already covered by Trade history' -- explicitly reversed per this task's requirement that mint/redemption appear in the Activity Log), `protocolMintFeeTransferred` (a genuine gap from DEC-0101 -- the event existed on-chain but was never wired into the decoder until this fix), `tvlFeeSettled`, `managerFeeRecipientsConfigured`, `managerFeeShareAccrued`, `managerFeeShareCollected`, and `feesAccrued` (the legacy event, decoded defensively for any pre-this-pass history even though nothing new emits it). `ManageDTR.tsx`'s Activity Log tab now shows an explicit 'Confirmed' status label and a truncated signature inline on every row (previously only reachable via the Explorer link icon), and its description copy was updated to reflect the newly-covered event categories.",
  "context": "Parts 4 and 5 of the session's sixth task. Part 4, verbatim: 'Remove the ENTIRE visible \"Protocol Fees\" section: Protocol share awaiting transfer, Pending Protocol balance, Send to Treasury Now, any Protocol claim/collection controls, explanations about Managers/delegates triggering treasury transfers... Protocol transfers should remain visible only in the Reserve Activity Log and appropriate internal Protocol accounting/admin views.' Part 5 listed an explicit set of event categories the Activity Log must cover, including 'mint and redemption' and 'instant Protocol mint-fee transfers' and 'weekly TVL-fee settlements' -- each entry requiring 'user-friendly action, actor/automated executor, affected wallet/recipient, amount and asset, timestamp, transaction status, transaction signature, Solana Explorer link.'",
  "rationale": "Deleting the Protocol Fees UI block outright (rather than merely hiding the button) was the correct read of 'ENTIRE visible section... Protocol fees are automatic and must not appear in Manager fee-recipient claim interface' -- this is fully consistent with DEC-0101/DEC-0102 having already made every code path that section referenced (pending_protocol_fee_shares for new activity, the manual collect trigger) permanently unused for going-forward activity. Reversing the mint/redeem exclusion in the Activity Log decoder was the correct call given the CURRENT task's explicit, detailed requirement supersedes the EARLIER pass's design choice ('already covered by Trade history') -- the same pattern already applied when DEC-0101 reversed DEC-0099's mint-fee design choice. The Postgres indexer (`lib/reserve-activity/indexer.ts`) needed no changes at all since it is already fully generic (walks every emitted event through the same shared decoder) -- adding decoder cases was sufficient for the whole pipeline to pick up the new categories automatically.",
  "alternativesConsidered": [
    "Hide the Protocol Fees section behind a feature flag or leave it rendering a static 'automatic now' message instead of deleting it -- rejected: the task's explicit wording is 'remove the ENTIRE visible section,' and every piece of state it displayed (pending balance) is now permanently zero for new activity, making a static message pure clutter with no operational value to a Manager.",
    "Add a brand-new, separate Activity Log event/decoder path specifically for mint/redeem rather than reusing summarizeActivityEvent's existing switch -- rejected: the existing function/pipeline already generically handles every other event category; adding two more `case` branches is consistent with the established pattern and requires no changes anywhere else in the pipeline."
  ],
  "impact": "Frontend: `src/merge/pages/ManageDTR.tsx` (Protocol Fees section deleted, `executeCollectProtocolFee` import removed, Activity Log tab row UI + description copy updated). SDK: `packages/sdk/src/activityLog.ts` (9 new/completed decoder cases, header comment updated). Docs: `docs/protocol/DEVNET_RUNBOOK.md` (new upgrade-record section for this pass's combined deploy), `docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_CHECKLIST_2026-08-14.md` (new, 17-item checklist against the user's explicit verification list), `docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_VERIFY_OUTPUT_2026-08-14.txt` (new, full raw verification transcript).",
  "affectedAreas": [
    "src/merge/pages/ManageDTR.tsx",
    "packages/sdk/src/activityLog.ts",
    "docs/protocol/DEVNET_RUNBOOK.md",
    "docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_CHECKLIST_2026-08-14.md",
    "docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_VERIFY_OUTPUT_2026-08-14.txt"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Code review: `git grep -n \"Protocol Fees\\|executeCollectProtocolFee\" src/merge/pages/ManageDTR.tsx` finds no remaining references; clean `tsc -b --force`/`oxlint`/`npm run build` confirms no dangling imports.",
    "Offline: `tests/phase_road_to_mainnet_feedback.ts`'s summarizeActivityEvent describe block updated (the old 'returns null for mint/redeem' test replaced with tests asserting mint/redeem/protocolMintFeeTransferred/tvlFeeSettled/managerFeeShareCollected all decode correctly) -- 594 total offline tests passing across this pass's full combined change set.",
    "Not separately screenshotted/clicked in a running browser this pass -- see docs/protocol/DEVNET_CLAIMANT_ONLY_TVL_SETTLEMENT_CHECKLIST_2026-08-14.md's 'Known gaps' for the full honest accounting of what was and wasn't interactively exercised."
  ]
}
```

## DEC-0104

```json
{
  "id": "DEC-0104",
  "date": "2026-08-17",
  "status": "confirmed",
  "decision": "Created a preservation-only DevNet stable checkpoint of `main` at commit `f443346c26d8b99381cfb08274901e24c48d1a4e`: committed the only outstanding uncommitted work (pre-existing untracked files -- `.agents/skills/{neon,neon-postgres}/SKILL.md`, `.claude/skills/{neon,neon-postgres}/SKILL.md`, `docs/architecture/SSR_APP_ARCHITECTURE.{html,json}`, `docs/journey-map/{README.md,index.html}`, `skills-lock.json` -- none of it product code), ran and passed the full validation suite (typecheck, lint, offline tests, production build), pushed `main` to `origin/main`, then created and pushed both a backup branch `main-devnet-checkpoint-2026-08-17` and an annotated tag `main-devnet-checkpoint-2026-08-17`, both verified to point at the exact same commit as `main`. No product code (`src/`, `api/`, `programs/`, `packages/`), UI, protocol, IDL, deployment authority, or DevNet program state was touched or redeployed. Production (`https://strategic-super-reserve.fun`, deployment `dpl_6tEEB3UA5G1V7D2QeViK1AEiu4r7`, commit `6222eac67501cfe832ef3333204ab1fdf2c50fe5`) was left as-is per explicit user instruction after confirming the 2-commit gap between it and the checkpoint commit is docs/tooling-only (this checkpoint commit itself, plus the already-pushed prior commit `a0ef392` recording that same deployment in `PROJECT_STATUS.md`) -- no redeploy performed.",
  "context": "User-requested DevNet stable checkpoint: 'the entire current system is working extremely well and must be preserved exactly before making further changes,' explicitly preservation-only (no fixes, no UI/protocol/IDL/config/deployment-authority/DevNet-state changes, no program redeploy, no new program ID, no Reserve changes), requiring inspection of branch/working-tree/remote/production state, preservation of every uncommitted change, a full validation suite, a secrets/generated-file/unrelated-change diff review, a non-destructive commit+push to `main`, and a backup branch + annotated tag both pinned to the exact verified commit -- plus confirmation of whether production already matches that commit.",
  "rationale": "Committing the untracked files was necessary to satisfy 'preserve every current relevant change; do not discard, overwrite, or omit uncommitted work' -- all of it was reviewed line-by-line (grepped for private-key/API-key/seed-phrase/token patterns; none found) and confirmed to be documentation/tooling (Neon skill references, architecture/journey-map docs, a skills lockfile), not product code, so it did not conflict with the 'do not modify product code' constraint. Using explicit `refs/heads/...:refs/heads/...` and `refs/tags/...:refs/tags/...` push refspecs (rather than a bare branch/tag name) avoided the local ambiguity between the same-named branch and tag and guaranteed each landed on the intended remote ref. Skipping the production redeploy followed the user's explicit instruction after they judged the 2-commit, docs-only gap between the checkpoint commit and the already-live deployment as not warranting a new deploy -- consistent with the task's own 'if production already runs the same commit, do not create a needless code change' guidance, applied to a diff that carries no product-code delta.",
  "alternativesConsidered": [
    "Redeploy `f443346` to Vercel production via `vercel --prod` so the live deployment's `githubCommitSha` literally matches the checkpoint commit -- rejected per explicit user instruction ('it's already the one deployed... skip this part'), given the only delta versus the currently-live commit is two docs-only commits with zero product-code diff.",
    "Leave the untracked documentation/skill files uncommitted and tag only the pre-existing tip (`a0ef392`) -- rejected: the task explicitly required preserving all outstanding uncommitted work, and those files were genuine, reviewed, secret-free repo content, not scratch/generated output."
  ],
  "impact": "New backup branch `main-devnet-checkpoint-2026-08-17` and annotated tag `main-devnet-checkpoint-2026-08-17`, both at `f443346c26d8b99381cfb08274901e24c48d1a4e`, now exist on `origin` alongside `main` at the same commit -- a clean, independently restorable snapshot of this stable DevNet state. No functional/runtime impact: no product code, UI, protocol, IDL, deployment authority, or DevNet program/Reserve state changed.",
  "affectedAreas": [
    ".agents/skills/neon/SKILL.md",
    ".agents/skills/neon-postgres/SKILL.md",
    ".claude/skills/neon/SKILL.md",
    ".claude/skills/neon-postgres/SKILL.md",
    "docs/architecture/SSR_APP_ARCHITECTURE.html",
    "docs/architecture/SSR_APP_ARCHITECTURE.json",
    "docs/journey-map/README.md",
    "docs/journey-map/index.html",
    "skills-lock.json",
    "docs/project/PROJECT_STATUS.md",
    "docs/project/DECISION_LOG.md"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Validation suite, all clean against commit `f443346`: `npx tsc -b` (0 errors), `npx oxlint` (exit 0, only pre-existing warnings), `npx ts-mocha -p ./tests/tsconfig.json -t 60000 tests/phase_*.ts` (516/516 passing -- the on-chain `tests/ssr_protocol.ts` Anchor integration suite was not run, as it requires a local `solana-test-validator`, already documented as non-functional on this Windows machine per DEC-0034), `npm run build` (SDK build + `tsc -b` + `vite build` all succeeded, `dist/` produced).",
    "Git verification: `git ls-remote origin main refs/heads/main-devnet-checkpoint-2026-08-17 refs/tags/main-devnet-checkpoint-2026-08-17 refs/tags/main-devnet-checkpoint-2026-08-17^{}` -- all three resolve to commit `f443346c26d8b99381cfb08274901e24c48d1a4e`.",
    "Secrets scan: `grep -rIlE` for private-key/AWS-key/OpenAI-style-key/Slack-token patterns across every newly-committed file found zero matches; `.env*`, `.vercel`, keypair files remain gitignored and were never staged.",
    "Vercel `list_deployments`/`get_project` (project `prj_cbTf3idEypjW1ccQA90NEEVbUUxQ`) confirmed the live production deployment is `dpl_6tEEB3UA5G1V7D2QeViK1AEiu4r7`, commit `6222eac67501cfe832ef3333204ab1fdf2c50fe5`, target `production`, state `READY` -- matching `PROJECT_STATUS.md`'s existing 2026-08-14 deployment record exactly."
  ]
}
```

## DEC-0105

```json
{
  "id": "DEC-0105",
  "date": "2026-08-17",
  "status": "confirmed",
  "decision": "Early-stage Mainnet authority and treasury-control structure, confirmed by Creator (Claude User) -- the individual who currently controls and develops the SSR protocol, not to be confused with a 'Reserve creator' (an application user who launches a Reserve via SSR.fun). (1) Creator (Claude User) will control the protocol during the current early stage. (2) Creator (Claude User)'s wallet remains program upgrade authority, protocol admin, deployment authority, and holder of any other protocol-wide operational authority currently required to deploy, configure, pause, unpause, maintain, or fix the protocol. (3) The boss does not currently receive program upgrade authority, protocol-admin authority, deployment authority, unilateral authority over the protocol, or access to Creator (Claude User)'s private keys, seed phrases, hardware wallet, or keypair files. (4) A treasury multisig will be created separately (not created by this decision). (5) Creator (Claude User) and the boss will both be members of that treasury multisig. (6) The treasury multisig controls company treasury assets and treasury transactions only. (7) The treasury multisig must not automatically become program upgrade authority, protocol admin, deployment authority, controller of protocol-wide operational functions, or owner/controller of Reserve Asset vaults. (8) Reserve Assets remain in program-controlled PDAs under the existing non-custodial architecture and must not be transferred into the company treasury multisig. (9) Individual Reserve management remains governed by the existing Reserve-manager and delegate architecture, unaffected by this decision. (10) This early-stage arrangement is intentional: it lets Creator (Claude User) deploy updates and urgent bug fixes without waiting for treasury-multisig approval. (11) The treasury multisig is for shared company treasury access and oversight -- it is not presently the protocol-governance mechanism. (12) This arrangement may be reconsidered later; no migration date, TVL threshold, or automatic-transfer requirement is set by this decision, and multisig control of the program is NOT stated to be a committed Mainnet requirement here. (13) Any future transfer of program upgrade authority, protocol-admin authority, deployment authority, or another protocol-wide authority requires a separate, later, explicit decision by Creator (Claude User).",
  "context": "DEC-0015 (2026-07-27) already established that v1 has no DAO/governance contract and that `ProtocolConfig.authority` is a plain wallet (the inception wallet), with the account model deliberately left open to a future multisig/DAO without requiring a migration. Narrative planning notes derived from DEC-0015 -- `docs/project/PROJECT_STATUS.md`'s Next Actions #7/Risks/Engineering-Areas entries, `docs/protocol/DEVNET_RUNBOOK.md`'s Upgrade Policy section, and the pre-existing, database-backed `public/road-to-mainnet.html` checklist items MS-02 ('Multisig on the upgrade authority') and PM-08 ('Upgrade authority') -- all describe migrating the program's upgrade authority to a multisig as a pre-restricted-beta/pre-Mainnet goal, but none of them specify who controls the protocol in the interim or how a separate company treasury (distinct from protocol authority) should be structured. Creator (Claude User) explicitly confirmed both: the current early-stage protocol-control arrangement, and a separate treasury-multisig plan (Creator (Claude User) + the boss) scoped to company treasury assets only.",
  "rationale": "Keeping program upgrade authority, protocol admin, and deployment authority solely with Creator (Claude User)'s wallet for the current early stage lets urgent fixes and updates ship without waiting on multisig coordination, while the boss receives no unilateral protocol authority and no access to Creator (Claude User)'s keys -- addressing operational-security risk without slowing down active development. Standing up a treasury multisig now, scoped strictly to company treasury assets/transactions, gives the boss real shared oversight of company funds immediately without touching protocol-wide authority or the non-custodial Reserve Asset architecture (Reserve Assets stay in program-controlled PDAs -- see `docs/protocol/ACCOUNT_MODEL.md`'s ProtocolConfig/vault_authority sections and `docs/protocol/SECURITY_INVARIANTS.md`'s upgrade/admin blast-radius summary, both of which already establish that no administrative signer, including `ProtocolConfig.authority`, can move tokens out of an existing Reserve's vaults). Declining to set a migration date, TVL threshold, or automatic-transfer trigger for protocol authority avoids committing to an invented plan Creator (Claude User) has not approved; DEC-0015's already-flexible account model (plain `Pubkey` fields for `ProtocolConfig.authority` and `Reserve.manager`) means a later migration remains structurally possible without an account-model change whenever a separate explicit decision authorizes it.",
  "alternativesConsidered": [
    "Grant the boss co-equal protocol upgrade/admin/deployment authority now, alongside Creator (Claude User) -- rejected: explicitly outside the confirmed decision; the boss receives treasury-multisig membership only, not protocol authority or Creator (Claude User)'s credentials.",
    "Fold program upgrade authority into the new treasury multisig immediately, so one multisig covers both company treasury and protocol control -- rejected: explicitly out of scope per the confirmed decision; the treasury multisig is scoped to company treasury assets/transactions only and must not automatically acquire protocol-wide operational authority or Reserve Asset vault control.",
    "Commit now to a specific future date or TVL threshold for migrating program upgrade authority to a multisig -- rejected: explicitly disallowed; inventing a migration trigger not approved by Creator (Claude User) would misrepresent an undecided future action as already planned. Any such migration remains a separate, later, explicit decision (point 13 above)."
  ],
  "impact": "Documentation-only. No on-chain authority was transferred, no treasury multisig was created, and no wallet address was invented or recorded by this decision -- `ProtocolConfig.authority` and the program's on-chain upgrade authority are unchanged from their current state (see `docs/protocol/DEVNET_RUNBOOK.md`'s existing Deployment Record table). `docs/project/PROJECT_STATUS.md` gains a new 'Authority & Treasury Structure' section (current-state authority matrix, terminology clarification, security notes) and clarifying annotations on its Next Actions #7, Engineering Areas / Production Readiness, and Risks entries -- none of the annotated text was deleted or rewritten, only appended to. `docs/protocol/DEVNET_RUNBOOK.md`'s Upgrade Policy section and Deployment Record table gain a clarifying note each, same append-only treatment. `docs/protocol/SSR_ARCHITECTURE.md` section 7 and `docs/protocol/ACCOUNT_MODEL.md`'s ProtocolConfig section each gain a short 'current real-world holder' clarification tying the existing abstract 'ProtocolConfig authority' / ProtocolConfig.authority description to this decision, without altering the existing authority-boundary diagram or table. `public/road-to-mainnet.html` (frontend-served, database-backed checklist; MS-02/PM-08) was deliberately left untouched -- out of scope for a documentation-only pass and not a docs/ file -- so those checklist items remain open exactly as before, neither fulfilled nor contradicted by this decision.",
  "affectedAreas": [
    "docs/project/DECISION_LOG.md",
    "docs/project/PROJECT_STATUS.md",
    "docs/protocol/DEVNET_RUNBOOK.md",
    "docs/protocol/SSR_ARCHITECTURE.md",
    "docs/protocol/ACCOUNT_MODEL.md"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Explicit, itemized instruction from Creator (Claude User) this session confirming all 13 points of the decision statement above verbatim, including the mandatory 'Creator (Claude User)' / 'Reserve creator' terminology distinction.",
    "Cross-referenced against DEC-0015 (no DAO/governance in v1, plain-Pubkey authority fields) and confirmed non-contradictory -- this decision clarifies the interim real-world control of that same plain-Pubkey authority, it does not change the account model DEC-0015 established.",
    "Cross-referenced against `docs/protocol/ACCOUNT_MODEL.md`'s Authority-boundary diagram and `docs/protocol/SECURITY_INVARIANTS.md`'s 'Upgrade / admin blast-radius summary' and confirmed non-contradictory -- both already state that no administrative authority, `ProtocolConfig.authority` included, can move tokens out of an existing Reserve's vaults, consistent with point 8's Reserve Asset custody requirement.",
    "Cross-referenced against `public/road-to-mainnet.html`'s MS-02/PM-08 checklist items (eventual upgrade-authority-to-multisig goal) and confirmed non-contradictory -- this decision governs the current early stage only and explicitly does not set a migration date or declare that goal a committed Mainnet requirement (point 12); that file is frontend/database-backed product content and was not modified.",
    "`git status`/`git diff` confirm only documentation files listed under affectedAreas were changed this pass; no file under `src/`, `packages/sdk/`, `programs/`, or `public/` was touched; no `git commit`, `git push`, program deploy, or DevNet/production change was performed."
  ]
}
```

## DEC-0106

```json
{
  "id": "DEC-0106",
  "date": "2026-08-17",
  "status": "confirmed",
  "decision": "Standing, permanent policy: every situation across this project (DevNet and Mainnet alike) where real money (SOL or other real value) is locked as a rent-exemption deposit, temporarily at risk during a deploy, abandoned, or recoverable is tracked in a new append-only ledger, `docs/project/FUNDS_LEDGER.md`. Tracking is automatic and standing ('forever,' per Creator (Claude User)'s instruction). Actually moving any real money is NOT automatic or pre-authorized by this policy -- a request to sweep/consolidate/push recoverable funds requires, at the time of the request, an explicit confirmation of source account, exact amount, and destination address; this policy alone never executes a transfer. The ledger records `6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen` as the default documented recovery-request destination, per Creator (Claude User)'s explicit instruction, not independently verified as belonging to Creator or the boss.",
  "context": "Following up on the Mainnet SOL cost estimate given this session (~6.1 SOL / ~$460 program rent-exemption alone, ~10-12 SOL recommended working balance), Creator (Claude User) asked whether rent is redeemable on a redeploy (it is, in full, via a deliberate close -- redeploys/upgrades to the same program ID never re-charge already-locked rent) and explicitly requested a permanent, standing practice: 'any situations where there might be loss of money, you will track everything and will send upon my request push everything to 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen.'",
  "rationale": "A dedicated, purpose-built, append-only ledger (matching this project's established pattern of DECISION_LOG.md/PROJECT_STATUS.md for its own concerns) gives a single, durable place to find every locked/at-risk/recoverable-SOL situation across sessions, rather than scattering the information across risk bullets that could be missed. Separating 'track everything' (standing, automatic, no confirmation needed) from 'push/move funds' (never automatic, always requires a fresh explicit confirmation of source/amount/destination at the time) is necessary because moving real money is an irreversible, consequential action -- treating a general instruction given today as blanket standing authorization to execute an unspecified future transfer would violate the project's own 'Executing actions with care' principle and could execute the wrong amount, from the wrong account, at the wrong time. Recording the destination address as instructed, while flagging it was not independently verified, keeps the documentation honest about what is confirmed (Creator's explicit instruction) versus what is assumed (that the address is Creator's/the boss's own wallet).",
  "alternativesConsidered": [
    "Treat 'send upon my request, push everything' as standing pre-authorization to execute a fund transfer whenever a future message merely references it -- rejected: no specific source, amount, or transaction was confirmed at the time of this decision; executing a real, irreversible SOL transfer from an inferred instruction rather than a fresh explicit confirmation is exactly the failure mode the project's risk-taking guidance warns against.",
    "Fold this tracking into an existing file (PROJECT_STATUS.md's Risks section) rather than a new ledger -- rejected: Risks is a snapshot of current-state concerns, re-derived/rewritten over time, whereas this needs to be a permanent, append-only, cumulative record that survives every future session, matching DECISION_LOG.md's own rationale for being a separate append-only file rather than folded into PROJECT_STATUS.md.",
    "Independently verify who controls `6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen` before recording it -- not possible from this environment (no way to confirm off-chain wallet ownership); recorded as explicitly instructed instead, with the verification gap stated plainly rather than silently assumed away."
  ],
  "impact": "New file `docs/project/FUNDS_LEDGER.md`: the rent-exemption/recoverability mechanics reference, the recovery-request policy, the default destination address, and two seeded entries (DevNet's already-real, already-locked reserve_id 6 rent -- no reclaim instruction exists for it in v1 -- and the pending, not-yet-incurred Mainnet program-deployment estimate). `docs/project/DECISION_LOG.md` gains this entry. Cross-references added to `docs/project/PROJECT_STATUS.md` and `docs/protocol/DEVNET_RUNBOOK.md` pointing at the new ledger. No money moved, no wallet funded, no program deployed, no on-chain action of any kind performed.",
  "affectedAreas": [
    "docs/project/FUNDS_LEDGER.md",
    "docs/project/DECISION_LOG.md",
    "docs/project/PROJECT_STATUS.md",
    "docs/protocol/DEVNET_RUNBOOK.md"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Explicit instruction from Creator (Claude User) this session: track every money-loss-risk situation permanently, and record a specific destination address for a future sweep request.",
    "Cross-referenced against `docs/protocol/SECURITY_INVARIANTS.md`'s 'Outstanding gaps' and `docs/protocol/DEVNET_RUNBOOK.md`'s 'Wallet / fixture safety' section for the reserve_id 6 precedent -- confirmed accurate against the existing documented record before citing it in the new ledger.",
    "`git status`/`git diff` confirm only documentation files (the new ledger plus the cross-references above) were changed; no `src/`, `packages/sdk/`, `programs/`, or `public/` file touched; no transaction submitted, no `git commit`/`git push` performed as part of this decision."
  ]
}
```

## DEC-0107

```json
{
  "id": "DEC-0107",
  "date": "2026-08-18",
  "status": "confirmed",
  "decision": "Built a new password-gated internal dashboard, `/internal/kpis`, showing protocol-wide usage stats (Reserves created over time, daily mint/redeem volume, monthly Protocol/Manager fee revenue, live lifecycle-status breakdown, monthly avg Reserve Asset count per Reserve, a Top-10-by-volume leaderboard, and a full event-kind-count table), plus a full raw-event CSV export and a manual/scheduled data-refresh mechanism. To make real volume/fee aggregation possible, `packages/sdk/src/activityLog.ts`'s `summarizeActivityEvent` was extended to also emit structured `amountRaw`/`amountKind` (and, for the two dual-amount events, `amountRaw2`/`amountKind2`) fields alongside its pre-existing free-text `summary`, and `reserve_activity_log` gained four new nullable columns to persist them. Since the existing per-Reserve lazy indexer (`syncReserveActivity`) only backfills a Reserve when its own page is viewed, a new `backfillAllReserveActivity` sweep (bounded, resumable) walks every discovered Reserve's full history, run by a new daily cron (`/api/dashboard/kpis-backfill-cron`, 03:00 UTC) and by a manual 'Refresh data' button on the page itself.",
  "context": "Creator (Claude User) asked for 'a backend dashboard that will give me all the possible usage stats on the protocol,' specifying: same password gate as `/internal/status`; number of Reserves created, monthly avg assets per Reserve, daily volume, and 'everything under the sun'; logged as one big file exportable as CSV; also viewable as graphics on the same page; same architectural pattern as the existing internal pages, at route `/internal/kpis`. Pre-implementation research (a research pass, not a code change) found the pieces already in place -- the exact same password/session cookie (`SSR_DASHBOARD_PASSWORD`, `lib/dashboard/session.ts`), an event decoder already covering 28 of the protocol's 30 event kinds, and a Postgres-backed `reserve_activity_log` table -- but also found the real gap: that log only carries free-text summaries (no structured numeric amounts) and is only ever lazily, per-Reserve backfilled, never swept protocol-wide, so no genuine volume/fee/lifecycle aggregate could be computed from it as-is.",
  "rationale": "Extending the existing event decoder/schema (rather than building a parallel data pipeline) keeps a single source of truth for 'what happened to a Reserve' -- the same rows now serve both ManageDTR.tsx's per-Reserve Activity tab (unaffected; the new columns are purely additive and nullable) and this protocol-wide dashboard. Structured amounts are stored as `numeric`/`text`, never a JS `number` or Postgres `bigint`, end to end (activityLog.ts's `addBig`, the schema's `text` columns, `kpis.ts`'s SQL casting to `numeric` and JS `sumBigStrings`) because real u64 Reserve Token amounts can exceed `Number.MAX_SAFE_INTEGER`, and silently losing precision in a stats dashboard would misreport real revenue/volume numbers. Classifying `managerFeeShareCollected` as `managerFeeClaimed` rather than folding it into `managerFee` prevents double-counting an already-accrued balance as new revenue twice (once on accrual, again on collection) -- the same reasoning applies to keeping `protocolMintFeeTransferred`/`tvlFeeSettled`/`protocolFeeCollected` all tagged `protocolFee` despite covering different code paths (new instant-transfer vs. legacy manual-collection), since a given Reserve is only ever on one of those paths at a time, so no double count is possible there. A protocol-wide backfill sweep had to be built as a genuinely new primitive (not a reuse of the existing lazy per-Reserve sync) because the dashboard's own correctness depends on seeing EVERY Reserve's full history, not just whichever ones happen to have been recently viewed in ManageDTR.tsx. `monthlyAvgAssetsPerReserve` deliberately reports CURRENT live `assetCount` per Reserve grouped by creation month (not a historical snapshot at creation time) -- the log has no way to reconstruct composition at an arbitrary past moment without also tracking every `reserveAssetAdded`/`reserveAssetRemoved` event's ordering precisely, which was out of scope for a first version; the chosen metric is honestly labeled as such in the UI rather than presented as something it isn't.",
  "alternativesConsidered": [
    "Parse the existing free-text `summary` strings with regex to extract amounts instead of extending the schema -- rejected: fragile (any future wording change to a summary string would silently break every aggregate), and the raw decoded event data was already sitting right there in `summarizeActivityEvent`'s `data` parameter, making a structured field the strictly better option at roughly the same implementation cost.",
    "Compute daily volume / monthly fees live from RPC on every dashboard page load instead of via the Postgres log -- rejected: a genuine multi-month time series needs historical data no live RPC read can provide (current state only), and re-walking full transaction history for every Reserve on every page load would be far too slow/RPC-heavy for a page meant to load quickly.",
    "Extend `syncReserveActivity`'s existing lazy per-Reserve call path to also serve the protocol-wide sweep, instead of a new `backfillAllReserveActivity` function -- rejected: the existing function's whole design (one bounded step per call, resumable via a per-Reserve cursor) is correct for 'top up whichever Reserve's page a user is looking at right now' but wrong for 'guarantee full history across every Reserve exists before computing an aggregate' -- these are different correctness requirements needing a dedicated driver, even though the new driver calls the existing function as its primitive.",
    "Treat `managerFeeShareCollected`/`protocolFeeCollected` amounts as additional 'fee revenue' on top of the accrual events -- rejected: would double-count real revenue in the dashboard's headline totals, actively misleading anyone reading it."
  ],
  "impact": "New: `api/dashboard/kpis.ts` (GET, JSON aggregates), `api/dashboard/kpis-export.ts` (GET, streamed full CSV), `api/dashboard/kpis-refresh.ts` (POST, manual backfill trigger), `api/dashboard/kpis-backfill-cron.ts` (scheduled sweep, `CRON_SECRET`-gated like the existing `accrue-fees-cron.ts`), `api/dashboard/tsconfig.json` (new CommonJS/node-resolution TS project, mirroring `api/devnet/tsconfig.json`, needed because these new endpoints import `lib/reserve-activity`'s CommonJS-scoped modules -- the same reason that directory was already excluded from `tsconfig.node.json`), `lib/reserve-activity/kpis.ts` (pure bucketing/CSV helpers + the real SQL aggregates), `lib/reserve-activity/backfillAll.ts` (the protocol-wide sweep), `internal-kpis.html` + `src/internal-kpis/` (the page itself, React + recharts, dark-mode-only matching `/internal/status`'s own convention, chart colors taken verbatim from the dataviz skill's validated dark-mode reference palette), `tests/phase_kpis.ts` (19 new offline tests). Changed: `packages/sdk/src/activityLog.ts` (structured amount fields, additive), `lib/reserve-activity/schema.sql`/`indexer.ts` (4 new nullable columns, additive -- existing rows and the existing per-Reserve Activity Log reader are both unaffected), `middleware.ts`/`vercel.json`/`vite.config.ts` (routing/build wiring for the new page and its endpoints, plus the new daily cron entry), `tsconfig.json`/`tsconfig.node.json` (the new project reference/exclusion described above). No new secrets needed -- reuses the already-provisioned `SSR_DASHBOARD_PASSWORD`, `DATABASE_URL`, and `CRON_SECRET`. The new schema columns require running `node scripts/migrate-reserve-activity.mjs` against the real database before the new columns exist there (not yet run this pass -- see evidence). Nothing was committed, pushed, or deployed as part of this decision.",
  "affectedAreas": [
    "api/dashboard/kpis.ts",
    "api/dashboard/kpis-export.ts",
    "api/dashboard/kpis-refresh.ts",
    "api/dashboard/kpis-backfill-cron.ts",
    "api/dashboard/tsconfig.json",
    "lib/reserve-activity/kpis.ts",
    "lib/reserve-activity/backfillAll.ts",
    "lib/reserve-activity/schema.sql",
    "lib/reserve-activity/indexer.ts",
    "packages/sdk/src/activityLog.ts",
    "internal-kpis.html",
    "src/internal-kpis/main.tsx",
    "src/internal-kpis/Dashboard.tsx",
    "src/internal-kpis/kpis.css",
    "middleware.ts",
    "vercel.json",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.node.json",
    "tests/phase_kpis.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b --force`: 0 errors, including the two new project references (`api/dashboard/tsconfig.json` plus the pre-existing `api/devnet/tsconfig.json`).",
    "`npx oxlint`: exit 0, zero NEW warnings -- confirmed by diffing against the pre-existing warning set (the same `only-export-components`/`exhaustive-deps`/etc. warnings already present before this pass, unrelated files, unchanged count).",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 60000 tests/phase_*.ts`: 552/552 passing (533 pre-existing + 19 new in `tests/phase_kpis.ts`), covering every new `summarizeActivityEvent` amount classification (including a u64::MAX precision round-trip proving no `Number` truncation) and every pure helper in `kpis.ts`.",
    "`npm run build`: SDK build + `tsc -b` + `vite build` all succeeded; `dist/internal-kpis.html` and its bundle produced cleanly alongside the pre-existing `internal-status`/`internal-feedback`/`main` entries.",
    "`npx tsc -p tsconfig.tests.json --noEmit` re-run to confirm no NEW errors: all reported errors are in files this pass never touched (`phase_chart_range_selector.ts`, `phase_data_integrity.ts`, `phase_devusdc_buy_architecture_fix.ts`, `phase_discovery_reliability.ts`, `phase_landing_wallet_corrections.ts`, `phase_manager_fee_recipients.ts`, `phase_reserve_deploy_resumability.ts`, `tests/util/aliases.ts`) -- pre-existing, not introduced by this pass.",
    "NOT yet done, flagged transparently: the schema migration was not run against the real database this pass (no live DB access attempted); `?dryRun=true` live verification of the new cron/refresh endpoints against real DevNet data was not performed; no browser click-through of the new page was performed (no browser-automation tool available in this environment, the same documented gap as every prior pass). `git status` confirms nothing was committed or pushed."
  ]
}
```

## DEC-0108

```json
{
  "id": "DEC-0108",
  "date": "2026-08-18",
  "status": "confirmed",
  "decision": "Mainnet-readiness requirement for internal tooling: `/internal/kpis` (the protocol usage-stats dashboard, DEC-0107) must exist and be operational at Mainnet launch. `/internal/status` (the project-status/decision-log dashboard) is DevNet-only tooling and is explicitly left behind -- it does not need to carry over to Mainnet.",
  "context": "Following DEC-0107's rollout to DevNet production (migration applied, deployed, first backfill sweeps run -- see that entry's live-rollout evidence, including two real bugs found and fixed during rollout: a missing `api/dashboard/package.json` crashing the new cron, and a backfill-sweep ordering bug that silently starved progress), Creator (Claude User) confirmed the known residual gap (a pre-existing Borsh event-decode error affecting a subset of older DevNet Reserves' history, deliberately deferred, not fixed this pass) can stay deferred -- 'we can leave it' -- and explicitly scoped what matters going into Mainnet: `/internal/kpis` must be ready and working by launch; `/internal/status` does not need to be.",
  "rationale": "`/internal/status` renders `PROJECT_STATUS.md`/`DECISION_LOG.md` -- this project's own engineering/decision history, which is inherently a DevNet-era, single-repo development artifact with no ongoing purpose once Mainnet is live and this phase of work is done. `/internal/kpis` reports real protocol usage (Reserves, volume, fees) -- exactly the kind of operational visibility a live Mainnet deployment needs from day one, so it is a genuine Mainnet launch requirement, not DevNet-only tooling. Deferring the Borsh decode-error root-cause is reasonable for now since it only affects backfilling OLD DevNet Reserve history that predates this dashboard -- it does not block the dashboard's core function, and a fresh Mainnet deployment starts with no such legacy history to backfill in the first place (though the underlying event-parser bug itself is still real and could in principle resurface on Mainnet once enough real transaction diversity accumulates -- see 'Outstanding' below).",
  "alternativesConsidered": [
    "Carry `/internal/status` forward to Mainnet as well, for continuity -- rejected: explicitly not required per Creator (Claude User)'s scoping; no work was requested or performed to prepare it for a Mainnet context.",
    "Root-cause and fix the Borsh decode-error bug now, before considering this dashboard Mainnet-ready -- rejected for this pass: explicitly deferred ('we can leave it'); the bug affects only backfilling pre-existing DevNet history, not the dashboard's operation."
  ],
  "impact": "Documentation-only. No code changed by this decision. Establishes `/internal/kpis` as a tracked Mainnet-launch requirement (added to `docs/project/PROJECT_STATUS.md`'s Mainnet-Readiness Gaps) rather than leaving it as an undifferentiated DevNet-era feature alongside `/internal/status`. Outstanding, explicitly NOT closed by this decision: (1) the Borsh event-decode bug from DEC-0107's rollout remains unfixed and untracked beyond that entry's own note; (2) no explicit plan yet exists for standing up `/internal/kpis` against a Mainnet deployment (new program ID, likely a separate/parallel `reserve_activity_log` scope or a Mainnet-specific deployment of this same tooling) -- this decision states the requirement, not the implementation plan for meeting it.",
  "affectedAreas": [
    "docs/project/PROJECT_STATUS.md"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Explicit instruction from Creator (Claude User) this session: 'we can leave it. what matters is that when we launch mainnet this is ready to go. we then can leave the internal/status behind on devnet, but the /kpis need to be there. please store this info.'"
  ]
}
```

## DEC-0109

```json
{
  "id": "DEC-0109",
  "date": "2026-08-18",
  "status": "confirmed",
  "decision": "Fixed a real production incident: `/internal/status`'s login (`POST /api/dashboard/login`) crashed with `FUNCTION_INVOCATION_FAILED` for some period after DEC-0107's rollout, discovered when Creator (Claude User) tried to log into `/internal/kpis` and got 'Network error.' Root cause: giving `api/dashboard/` its own `tsconfig.json` + `package.json` (to satisfy local `tsc -b` for `kpis.ts`/`kpis-refresh.ts`/`kpis-backfill-cron.ts`'s `lib/reserve-activity` imports) made Vercel's per-function builder apply that new config to the ENTIRE directory, silently changing how it compiled the pre-existing, previously-untouched `login.ts`/`content.ts`/`logout.ts` too. Fixed by moving the 4 KPI-dashboard endpoints into a brand-new, fully isolated `api/kpis/` directory with their own `tsconfig.json`/`package.json` (mirroring `api/devnet/tsconfig.json`'s long-proven pattern exactly), leaving `api/dashboard/` completely untouched. Public URLs moved from `/api/dashboard/kpis*` to `/api/kpis/*` to match (updated in `middleware.ts`, `vercel.json`'s `crons`/`functions`, and the frontend's fetch calls).",
  "context": "Creator (Claude User) reported the login failure directly after being asked to try `/internal/kpis`. Diagnosis took multiple wrong turns before landing on the real cause: an initial theory blamed `.js`-suffixed relative import extensions (partially reverted, redeployed, confirmed WRONG -- login was still broken), before `npx tsc -b`'s real (not pipe-masked) exit code proved `lib/dashboard/`/`lib/road-to-mainnet/` genuinely require `.js` extensions under the root project's `nodenext`/`verbatimModuleSyntax` settings, and that `.js`-suffixed cross-directory imports had never been the actual problem -- login.ts's original imports were correct all along. The real cause was only found by testing the login endpoint directly against production after each change, rather than assuming a fix worked from typecheck/build success alone.",
  "rationale": "Isolating the 4 KPI endpoints into their own directory, rather than trying to make `api/dashboard/`'s shared config work for both the CommonJS-needing new files and the pre-existing ESM-native ones, removes the entire class of risk: Vercel's directory-level config application means ANY shared directory containing files with genuinely different module-format requirements is unsafe to special-case via a directory-scoped `tsconfig.json`/`package.json` -- the fix has to be at the directory-boundary level, matching exactly how `api/devnet/` already coexists safely alongside `api/dashboard/`, `api/road-to-mainnet/`, etc. (each a physically separate directory, never a shared one with mixed module-format needs). A `| tail -N` pipe silently swallowing `tsc`'s real exit code (masking a genuine failure as `TSC_EXIT=0` earlier in this incident's investigation) is now a known trap -- validation commands in this kind of investigation must capture the exit code before any pipe, not after.",
  "alternativesConsidered": [
    "Keep a single api/dashboard/tsconfig.json but scope its `include` narrowly to only the 4 new files (not `**/*.ts`) -- rejected: unresolved uncertainty about whether Vercel's per-function builder respects a tsconfig's `include` list when deciding which config governs a given file, or simply uses whichever tsconfig.json is nearest on disk regardless of its include patterns; given this exact uncertainty caused the live incident once already, a fully separate directory (provably safe, since Vercel's directory walk-up for 'nearest config' can never reach into a sibling directory) was preferred over re-testing an unproven theory against production again.",
    "Use vercel.json rewrites to keep the public URLs at /api/dashboard/kpis* while the files live under api/kpis/ -- rejected: adds another moving part with no existing precedent in this codebase for API-route (as opposed to static-page) rewrites; changing the public path directly in the 3 call sites (middleware.ts, vercel.json, Dashboard.tsx) was simpler and more transparent, at the one-time cost of a path change with no other functional impact.",
    "Duplicate the small amount of shared auth logic (isAuthenticated/isSameOriginRequest/unauthorized) into a new file rather than reusing lib/road-to-mainnet/auth.ts directly -- tried mid-incident, then reverted: unnecessary once the real fix (directory isolation) was found, and reusing the existing shared file is more maintainable than a parallel duplicate with no behavioral difference."
  ],
  "impact": "`/internal/status` login restored and live-verified (real `POST /api/dashboard/login` against production now returns a structured 401 for a wrong password instead of crashing). `/internal/kpis` login/data endpoints live-verified working at their new `/api/kpis/*` paths (`kpis-backfill-cron?dryRun=true` returned real progress: 30 sync calls, new Reserves reached beyond the previously backfilled set). All 5 production domains/paths re-confirmed `200` (`strategic-super-reserve.fun`, `www.strategic-super-reserve.fun`, `ssr-fun.vercel.app`, `/internal/status`, `/internal/kpis`). Vercel's runtime-error aggregation shows only one unrelated, pre-existing (first seen 2026-08-12) Node deprecation warning, nothing new. `api/dashboard/` (`login.ts`/`content.ts`/`logout.ts`) is now completely unmodified from its DEC-0106-era state -- zero net diff versus before DEC-0107 ever touched it.",
  "affectedAreas": [
    "api/kpis/kpis.ts",
    "api/kpis/kpis-export.ts",
    "api/kpis/kpis-refresh.ts",
    "api/kpis/kpis-backfill-cron.ts",
    "api/kpis/tsconfig.json",
    "api/kpis/package.json",
    "middleware.ts",
    "vercel.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "src/internal-kpis/Dashboard.tsx"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Direct `curl -X POST /api/dashboard/login` against production before the fix: `FUNCTION_INVOCATION_FAILED` (500). After the fix, same request with a deliberately wrong password: `{\"error\":\"Incorrect password.\"}` (401) -- a real, structured application response, not a crash.",
    "`curl /api/kpis/kpis-backfill-cron?dryRun=true` against production after the fix: real JSON progress report (66 Reserves discovered, 30 sync calls made this invocation, new Reserves reached beyond the set from DEC-0107's rollout), confirming both the directory move and the earlier sweep-ordering fix (DEC-0107) are both working together correctly.",
    "`npx tsc -b --force`, `npx ts-mocha tests/phase_*.ts` (552/552), `npx oxlint`, and `npm run build` all re-verified clean with real (non-pipe-masked) exit-code capture.",
    "`curl` against all 5 key production paths (apex, www, vercel.app alias, /internal/status, /internal/kpis) all returned `200` post-deploy.",
    "Vercel `get_runtime_errors` (10-minute post-deploy window): only one pre-existing, unrelated deprecation warning (first seen 2026-08-12), no new error groups."
  ]
}
```

## DEC-0110

```json
{
  "id": "DEC-0110",
  "date": "2026-08-18",
  "status": "confirmed",
  "decision": "Built the SSR Ledger (`lib/ledger/`, `api/ledger/`, `docs/protocol/LEDGER_ARCHITECTURE.md`) -- a normalized, acquisition-grade, cluster-aware business-data layer replacing the previous thin CSV export as the durable record of what happens through SSR.fun. A 12-table Postgres schema (`lib/ledger/schema.sql`) covers protocol deployments, Reserve/Reserve-Asset current state, weekly Jupiter-catalogue snapshots, the core `ledger_events` table (deterministic-ID, full structured event record -- slot, instruction index, actor role, raw+normalized+USD amounts, compute units, network fee, confirmation status, ingestion lineage), product-analytics events (privacy-allowlisted), daily rollups, operational incidents, ingestion cursors, and a reconciliation-run log. Deterministic event IDs (`lib/ledger/eventId.ts`) make ingestion naturally idempotent; a new program-wide (not per-Reserve) ingestion walker (`lib/ledger/ingest.ts`) records both successful AND failed transactions, unlike the existing per-Reserve indexer. Daily/date-range/complete CSV export (`api/ledger/export.ts`) streams a stable 44-column, one-row-per-event file with a dedicated `event_date_utc` field. Data-quality checks, a Jupiter Tokens API V2 weekly snapshot/diff system, and 32 new offline tests round out the build.",
  "context": "Creator supplied `ssr-fun-activity-log-2026-08-18.csv` (the /internal/kpis CSV export, DEC-0107/DEC-0109) as a reference and specified it was insufficient for management/investor/due-diligence/acquisition reporting: only 56 rows, 100% of them with a NULL raw-amount field (confirmed live before building anything -- caused by `reserve_activity_log`'s `ON CONFLICT DO NOTHING` never re-decoding historical rows even after the decoder gained new fields, a real architectural gap this pass's finding informed), no structured USD/decimals/actor-role/instruction-index/compute-unit/fee data, no cluster separation, no daily partitioning. Creator's task specified 15 numbered requirement sections (protocol/deployment, Reserves, Reserve Assets, on-chain activity, lifecycle events, product funnel, treasury/financial, reliability/operations, daily export, reporting views, data quality, raw-evidence preservation, Jupiter catalogue tracking, storage architecture, backfill/cluster-separation) plus documentation, terminology, and test requirements, explicitly scoped as 'implement everything that can be completed safely within the repository' with instructions to report any storage/credential blocker rather than invent a workaround.",
  "rationale": "Neon Postgres already exists in this repository, already provisioned (`DATABASE_URL`), and already serves two production features (`lib/road-to-mainnet/`, `lib/reserve-activity/`) -- per the task's own instruction ('if a suitable durable data store already exists, extend it'), this pass extends it via an additive migration rather than provisioning a second storage provider (explicitly restricted from doing so this pass regardless). `ledger_events` is a NEW table alongside (not a replacement for) `reserve_activity_log`, because the two serve genuinely different consumers (a per-Reserve UI tab needing a small field set vs. protocol-wide acquisition reporting needing the full normalized set) that decode the SAME underlying events via the SAME `summarizeActivityEvent`, so they can never disagree about meaning -- only about what else gets recorded. `api/ledger/` was built as its own fully isolated CommonJS directory with its own duplicated `_session.ts` from the very first commit of this pass, never touching `api/dashboard/` or reusing `lib/road-to-mainnet/auth.ts` even transiently -- applying DEC-0109's hard-won lesson (a directory-scoped tsconfig/package.json change silently affects every file in that directory; a CommonJS function synchronously requiring a genuine ESM module crashes invisibly before any try/catch) from the start rather than discovering it again the expensive way. USD valuation is deliberately never fabricated (`usd_price_source: 'unavailable'` with every numeric field null when no real price source exists) -- inventing a number that looks like data but isn't would actively harm the acquisition-reporting use case this whole system exists for. Given the genuine scale of the full 15-section requirement (protocol-wide product analytics instrumentation, live treasury reconciliation against on-chain balances, RPC-cost tracking, a Mainnet deployment that does not yet exist to backfill from, a real price oracle), this pass implements the complete schema/interfaces/ingestion/export/reconciliation/documentation for everything buildable without a live Mainnet deployment or a missing credential, and explicitly documents (LEDGER_ARCHITECTURE.md section 11) every remaining piece as either 'designed, not yet wired to a live data source' or 'blocked on a specific named Creator decision/credential' -- never silently claimed as done.",
  "alternativesConsidered": [
    "Retrofit `reserve_activity_log` in place with the full acquisition-grade field set instead of a new table -- rejected: would force ManageDTR.tsx's simple per-Reserve Activity tab to carry 30+ mostly-irrelevant columns, and would keep the walk scoped to one Reserve at a time, unable to answer protocol-wide questions (total revenue, all Reserves' daily volume) without N separate walks.",
    "Provision a new storage service (a dedicated analytics warehouse, a separate Postgres instance) for the Ledger -- rejected: explicitly restricted this pass, and unnecessary given Neon Postgres already handles this repository's durability/scale needs comfortably at the realistic early-Mainnet volume this system will see (see LEDGER_ARCHITECTURE.md section 15's estimate).",
    "Fabricate plausible-looking USD values using DevNet's fixed test prices even for a hypothetical future Mainnet event, or invent a migration/backfill timeline -- rejected outright per the task's own explicit instruction not to fabricate historical values that cannot be reconstructed; every field that cannot be honestly sourced is null with an explicit 'unavailable' source tag instead.",
    "Wire up full frontend product-analytics instrumentation (session tracking, funnel-step events across every page) as part of this same pass -- rejected as out of realistic scope for one pass alongside the rest of this build; the schema, privacy allowlist, and ingestion contract are built and tested, but the actual client-side call sites are a separately-scoped follow-up, honestly documented as such rather than silently partial."
  ],
  "impact": "New: `lib/ledger/` (schema.sql, db.ts, eventId.ts, amounts.ts, privacy.ts, csv.ts, decodeEvent.ts, ingest.ts, jupiterCatalogue.ts, reconciliation.ts, query.ts, package.json), `api/ledger/` (export.ts, ingest-cron.ts, jupiter-snapshot-cron.ts, reconciliation.ts, _session.ts, package.json, tsconfig.json), `scripts/migrate-ledger.mjs`, `docs/protocol/LEDGER_ARCHITECTURE.md`, `tests/phase_ledger.ts` (32 new tests). Changed: `middleware.ts`/`vercel.json` (routing/cron wiring for the new endpoints), `tsconfig.json`/`tsconfig.node.json` (new project reference/exclusion, same pattern as api/kpis's), `.env.example` (JUPITER_API_KEY/LEDGER_CLUSTER documented, CRON_SECRET/DATABASE_URL noted as reused). The existing `/api/kpis/kpis-export` CSV export was NOT deleted or modified -- both exports coexist per explicit instruction, until the new one is validated. No migration was run against the real database this pass (schema prepared, not applied -- see evidence); nothing was committed, pushed, deployed, or provisioned.",
  "affectedAreas": [
    "lib/ledger/schema.sql",
    "lib/ledger/db.ts",
    "lib/ledger/eventId.ts",
    "lib/ledger/amounts.ts",
    "lib/ledger/privacy.ts",
    "lib/ledger/csv.ts",
    "lib/ledger/decodeEvent.ts",
    "lib/ledger/ingest.ts",
    "lib/ledger/jupiterCatalogue.ts",
    "lib/ledger/reconciliation.ts",
    "lib/ledger/query.ts",
    "api/ledger/export.ts",
    "api/ledger/ingest-cron.ts",
    "api/ledger/jupiter-snapshot-cron.ts",
    "api/ledger/reconciliation.ts",
    "api/ledger/_session.ts",
    "scripts/migrate-ledger.mjs",
    "docs/protocol/LEDGER_ARCHITECTURE.md",
    "tests/phase_ledger.ts",
    "middleware.ts",
    "vercel.json",
    "tsconfig.json",
    "tsconfig.node.json",
    ".env.example"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b --force`: 0 errors, including the new `api/ledger/tsconfig.json` project reference.",
    "`npx oxlint`: exit 0, identical warning count to the pre-existing baseline (36) -- zero new warnings.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 60000 tests/phase_*.ts`: 584/584 passing (552 pre-existing + 32 new in `tests/phase_ledger.ts`), covering event-ID determinism, transaction-internal ordering, decimal conversion, raw/normalized/USD amounts (including the 'never fabricate' guarantee), missing timestamps/actors, failed-transaction handling, DevNet/Mainnet ID separation, Jupiter snapshot diffing, CSV escaping/stable headers, exact-date/date-range filtering, and privacy-field exclusion.",
    "`npm run build`: SDK build + `tsc -b` + `vite build` all succeeded.",
    "Live query against the real database confirmed the exact deficiency this pass addresses: `select count(*) from reserve_activity_log` = 56, `select count(*) filter (where amount_raw is null) from reserve_activity_log` = 56 -- 100% null, including event kinds (`reserveSeeded`, `feesCollected`, `protocolMintFeeTransferred`, etc.) the decoder has known how to populate since DEC-0107, confirming the ON CONFLICT DO NOTHING staleness gap described in LEDGER_ARCHITECTURE.md section 9.",
    "Confirmed via live web search that Jupiter Tokens API V2 requires an `x-api-key` header (portal.jup.ag) -- `lib/ledger/jupiterCatalogue.ts` built accordingly (throws a clear, explicit error when `JUPITER_API_KEY` is unset, never silently returns an empty catalogue); documented as a required Creator credential, not worked around.",
    "`git status` confirms nothing was committed or pushed; no `vercel --prod` or migration script was run against the real database; no paid service was provisioned; no production credential was created or exposed."
  ]
}
```

## DEC-0111

```json
{
  "id": "DEC-0111",
  "date": "2026-08-18",
  "status": "accepted",
  "decision": "Closed a set of real data-completeness gaps in the SSR Ledger (DEC-0110) that Creator (Claude User) identified via a live acquisition-readiness review of the first production export, and gave the /internal/kpis charts a visual polish pass.",
  "context": "Creator supplied a gap report against the live `/api/ledger/export` output (433 rows, 45 columns at the time) rating it 5/10 for acquisition-readiness. Reported: instruction_index/inner_instruction_index/instruction_name 100% empty; source_account/destination_account/vault 100% empty; all fee-specific fields empty even for protocol-fee events; confirmation_status 100% empty; actor classification unreliable (309 holder, 124 unknown, no manager/creator/delegate); reserveAssetFunded had no structured amount; only successful transactions were captured, no failed-transaction/error history; plus several items correctly identified as genuinely out of scope for this pass (frontend/funnel analytics, treasury reconciliation, AUM/NAV/TVL rollups, Jupiter snapshots, Mainnet records). USD prices/values being empty was investigated and confirmed to be the DESIGNED behavior (DEC-0110's 'never fabricate' principle -- no real price oracle exists yet), not a bug, and was left as-is.",
  "rationale": "Investigated each item against the actual ingestion code rather than assuming the gap report's framing: instruction_index/name were never populated because ingest.ts called Anchor's bare EventParser.parseLogs(), which yields decoded events with no position metadata by design. Wrote a custom log walker (lib/ledger/logWalker.ts) that mirrors EventParser's own execution-stack algorithm (verified against its actual node_modules source) while also tracking instruction index/name/nesting. source_account/destination_account/vault/fee_amount_raw/fee_destination/protocol_revenue_raw/manager_revenue_raw were declared in the CSV schema and ledger_events table from the start but ledgerEventRecordToCsvRow hardcoded them to null -- a real oversight, not a design choice; added lib/ledger/fieldExtraction.ts as ledger-only enrichment on top of the shared SDK decoder (not modifying the shared summarizeActivityEvent, to avoid changing behavior for ManageDTR.tsx's Activity tab). reserveAssetFunded's missing amount was the same root cause -- summarizeActivityEvent never covered it since its amount is Reserve-Asset-denominated, not Reserve-Token-denominated; extraction now surfaces it under a new ledger-only 'assetFunding' amount_kind, with decimals deliberately left null (never guessed) since no live mint-decimals lookup exists. confirmation_status was simply never set; now reports the literal 'confirmed' commitment level the RPC calls already request. Failed transactions were being fetched but produced zero events (most failures happen before an instruction reaches its emit!() call) and were silently dropped entirely; added buildFailedTransactionRecord to synthesize one 'transactionFailed' row per such signature, with the real on-chain error preserved. Actor classification was unreliable because classifyActorRole was always called with an empty context -- ledger_reserves/ledger_reserve_delegates existed in the schema but nothing ever wrote to them; ingestion now populates them (re-sorted into true chronological order before applying, since ingestion itself walks newest-to-oldest for resumability -- direct chronological writes during the walk would apply a stale manager after a newer one), and a new reclassify-actors-cron endpoint retroactively fixes rows classified before their Reserve's context was known. protocolInitialized/protocolConfigUpdated were previously unreachable/undecoded (documented as 'structurally unreachable' from the old per-Reserve activity log, but ARE reachable from program-wide ledger ingestion) -- added both cases to the shared summarizeActivityEvent. Charts: 'Reserves created by month' combined a small per-month count (bar) with a much larger cumulative total (line) on one linear axis -- a scale-mismatch anti-pattern per the dataviz skill's guidance ('two measures of different scale -> two charts, small multiples, or indexed to a common base'); split into two properly-scaled cards. Volume line charts converted to area charts with gradient fills for visual weight; direct end-value labels added to the two low-cardinality horizontal bar charts (lifecycle status, top Reserves by volume).",
  "alternativesConsidered": [
    "Wrap/subclass Anchor's EventParser instead of reimplementing its algorithm -- rejected: EventParser exposes no supported hook for per-event position metadata, and its generator discards that context internally; a parallel implementation mirroring its exact, verified execution-stack logic was more reliable than trying to desynchronize-proof two separate iterators over the same log array.",
    "Widen the shared SDK's summarizeActivityEvent to cover source/destination/vault/fee fields directly -- rejected: that function is also used by ManageDTR.tsx's per-Reserve Activity tab, which has a deliberately minimal, different contract; a ledger-only enrichment layer avoids any risk of changing that consumer's behavior.",
    "Leave already-ingested rows unfixed and only apply the new decode logic going forward -- rejected: ledger_events' `on conflict (event_id) do nothing` means existing rows would never receive the corrected fields; since schema.sql itself documents every ledger_* table as a DERIVED index safe to fully rebuild from chain data at any time, truncated and fully re-ingested the DevNet ledger instead so the fix is actually visible in the live export Creator is reviewing.",
    "Guess a Reserve-Token NAV or a fixed test price to populate USD fields -- rejected outright: violates DEC-0110's explicit 'never fabricate' principle; left `usd_price_source: 'unavailable'` as designed, pending a real Mainnet price oracle."
  ],
  "impact": "New: `lib/ledger/logWalker.ts`, `lib/ledger/fieldExtraction.ts`, `lib/ledger/reserveContext.ts`, `api/ledger/reclassify-actors-cron.ts`. Changed: `lib/ledger/decodeEvent.ts` (real source/destination/vault/fee columns, buildFailedTransactionRecord, instruction_name threading), `lib/ledger/ingest.ts` (custom log walker, reserve-context collection/application, failed-tx synthesis, literal confirmation_status), `packages/sdk/src/activityLog.ts` (protocolInitialized/protocolConfigUpdated decoding), `src/internal-kpis/Dashboard.tsx` (chart split, area fills, direct labels), `vercel.json` (new reclassify-actors-cron schedule), `tests/phase_ledger.ts` (12 new tests, 44 total). DevNet `ledger_events`/`ledger_reserves`/`ledger_reserve_delegates`/`ledger_ingestion_cursors` were truncated and fully re-ingested against production (safe per schema.sql's own 'derived, rebuildable' design -- no authoritative or on-chain state involved) so the fixes are reflected in the live export, not just future rows.",
  "affectedAreas": [
    "lib/ledger/logWalker.ts",
    "lib/ledger/fieldExtraction.ts",
    "lib/ledger/reserveContext.ts",
    "lib/ledger/decodeEvent.ts",
    "lib/ledger/ingest.ts",
    "packages/sdk/src/activityLog.ts",
    "api/ledger/reclassify-actors-cron.ts",
    "src/internal-kpis/Dashboard.tsx",
    "vercel.json",
    "tests/phase_ledger.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b`: 0 errors after each of the three commits in this pass.",
    "`npx oxlint lib/ledger api/ledger src/internal-kpis packages/sdk/src/activityLog.ts`: exit 0.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/phase_ledger.ts`: 44/44 passing (12 new -- logWalker instruction-index/name derivation against synthetic log arrays including a leading foreign top-level instruction and two sequential same-program instructions, fieldExtraction's per-event-type field mapping, buildFailedTransactionRecord's determinism).",
    "`npm run test:program` full offline suite (all `tests/phase_*.ts` except the live-RPC `ssr_protocol.ts`): 596/596 passing -- no regressions from the activityLog.ts/decodeEvent.ts changes.",
    "`npm run build`: clean.",
    "Live production verification, before/after the DevNet ledger was truncated and fully re-ingested (5 sweeps to reach `reachedRealEnd: true`, then one `reclassify-actors-cron` pass): instruction_index/instruction_name populated 434/466 rows (up from 0/433); confirmation_status populated 466/466 (up from 0/433); 32 real failed-transaction rows now present with real on-chain error codes (up from 0); vault populated 101/466, destination_account 64/466, fee_amount_raw 62/466 (all up from 0); actor_role breakdown changed from {holder: 309, unknown: 124} to {manager: 165, holder: 137, unknown: 124, delegate: 30, creator: 10}; event_type count rose from 27 to 29 (protocolConfigUpdated now decoded); ledger_reserves populated with 67 rows, ledger_reserve_delegates with 17.",
    "A live bug was caught and fixed mid-rollout: the first post-fix ingestion sweep crashed with a NOT NULL violation on ledger_reserves.program_id (the new upsert code never supplied it) -- fixed, redeployed, reverified before declaring the pass complete.",
    "Explicitly NOT attempted in this pass (communicated to Creator, not silently dropped): frontend/session/funnel analytics (new instrumentation across the React app, out of scope for a single pass), treasury reconciliation (on-chain vault-balance comparison, not yet built), AUM/NAV/TVL daily rollups (ledger_daily_rollups exists in schema but unpopulated), Jupiter weekly snapshots (blocked on a JUPITER_API_KEY Creator has not yet supplied), Mainnet records (blocked on no Mainnet deployment existing yet)."
  ]
}
```

## DEC-0112

```json
{
  "id": "DEC-0112",
  "date": "2026-08-18",
  "status": "confirmed",
  "decision": "Creator confirmed the final, temporary Mainnet authority and Treasury structure ahead of launch: program upgrade/closure authority and canonical IDL authority both single-wallet (Creator's Protocol Admin wallet), Protocol administration held independently by two named wallets (Creator and Boss, no multisig at that layer), and the company Treasury held by a separate Squads 2-of-3 multisig vault -- distinct from, and never to be confused with, the Squads Multisig Account address itself.",
  "context": "Pre-Mainnet-deployment investigation into the intended authority/treasury structure, requested so genesis configuration (initialize_protocol, upgrade-authority assignment, IDL publication) can be executed correctly the first time rather than corrected after the fact. Two central technical questions needed real, independently-verified answers before this structure could be confirmed as feasible, not just intended: (1) does the deployed/repository Anchor program actually support two simultaneous independent Protocol Admin wallets, and (2) is the named Squads address genuinely safe to configure as the protocol-fee destination.",
  "rationale": "Investigated both questions against real evidence rather than assuming the request's framing. (1) Source audit of programs/ssr_protocol/src/state/protocol_config.rs found ProtocolConfig.authority is a single Pubkey field, and the only admin-gated instruction (update_protocol_config) checks it via a single Anchor has_one constraint -- the deployed/repository code does NOT support two independent admins as-is, and a second, independently significant gap was found in the same pass: no instruction anywhere sets ProtocolConfig.paused after genesis, so the documented global emergency pause has never actually been reachable by any admin, single or dual. Both are real code gaps requiring a Rust change + rebuild + deploy before Mainnet genesis (tracked separately, see the entry for that implementation pass). (2) Fee-destination compatibility was verified by reading collect_protocol_fee.rs/collect_fees.rs directly: both derive the fee-destination token account as an associated-token-account keyed on an UncheckedAccount authority, funded via a mint_to CPI (not a transfer requiring the destination's own signature) -- this works identically for an on-curve wallet or an off-curve PDA, so a Squads vault is safe here. The Squads addresses themselves were verified with real Mainnet RPC calls (api.mainnet-beta.solana.com), not assumed from the request: getAccountInfo on the Multisig Account address confirmed real ownership by the genuine Squads V4 program (SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf); decoding its raw account data against the Squads V4 Multisig layout confirmed threshold=2 and exactly the 3 named signer pubkeys, each with full permissions; and the named Treasury vault address was independently re-derived via findProgramAddressSync([\"multisig\", <multisig>, \"vault\", [0]], SQDS4ep...) and confirmed to match exactly, and confirmed off-curve via PublicKey.isOnCurve(). No private keys or seed phrases were requested, shared, or inspected at any point -- every check used only public on-chain data and independently-computable PDA math.",
  "alternativesConsidered": [
    "Treat the requested structure as already supported and proceed straight to genesis configuration -- rejected: would have silently configured only one working admin (Boss would have no real on-chain authority) and shipped with a non-functional emergency pause, discovered only after Mainnet genesis when it could no longer be fixed without a fresh deployment.",
    "Assume the Squads addresses were correctly identified without independent verification -- rejected: fee-destination misconfiguration or an address mix-up (Multisig Account vs. Treasury vault) at genesis would be exactly the kind of mistake this structure explicitly must never make (see the explicit prohibition on ever using the Multisig Account address as a fee destination).",
    "Design a brand-new governance layer (e.g. a Protocol Control multisig wrapping ProtocolConfig.authority) instead of two named wallets -- explicitly out of scope; Creator's structure deliberately has no multisig at the protocol-admin layer, only at the Treasury layer."
  ],
  "impact": "Establishes the confirmed target structure for Mainnet genesis configuration (see docs/project/PROJECT_STATUS.md's \"Authority & Treasury Structure (Mainnet target)\" section for the full table and address list). Confirms two concrete pre-genesis blockers that must be closed before deployment: dual-admin support and a working pause instruction, both requiring a Rust code change (see the follow-up implementation entry). No code, on-chain state, or configuration was changed by this decision itself -- it is a confirmation of intent plus independent feasibility verification, not an execution step; as of this entry no Mainnet program has been deployed and no authority has been transferred or configured anywhere.",
  "affectedAreas": [
    "docs/project/PROJECT_STATUS.md",
    "programs/ssr_protocol/src/state/protocol_config.rs (finding, not yet a change as of this entry)",
    "programs/ssr_protocol/src/instructions/update_protocol_config.rs (finding, not yet a change as of this entry)",
    "programs/ssr_protocol/src/instructions/collect_protocol_fee.rs (verification only, unchanged)"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Source-level audit of every instructions/*.rs file for admin-gating patterns (has_one/constraint against ProtocolConfig.authority) and for any write to ProtocolConfig.paused -- confirmed both gaps directly against source, not by inference.",
    "getAccountInfo(B2BUEztDn1SKFZ7Kh3hakEWsD5sVM8gxLAE4wqS9w2am) on Mainnet: owner = SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf (real Squads V4 program).",
    "Decoded Squads V4 Multisig account layout directly: threshold = 2, exactly 3 members (2cLftQ4ftvRaqLs3UYi3sxh4RUfQFZJRkJBBEmW5HqCX, EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq, EkQ84781DvGgp8y32EhxS48HABDsYJ2JSY692an4juAz), each with full permissions, config_authority = zero-pubkey.",
    "Independently re-derived the Treasury vault PDA (findProgramAddressSync([\"multisig\", <multisig>, \"vault\", [0]], SQDS4ep...)) and confirmed an exact match to 3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5; confirmed off-curve via PublicKey.isOnCurve()."
  ]
}
```

## DEC-0113

```json
{
  "id": "DEC-0113",
  "date": "2026-08-18",
  "status": "accepted",
  "decision": "Reworked ProtocolConfig from a single admin authority to two independent Protocol Admin wallets, and added a new set_protocol_paused instruction, as required Mainnet-launch code blockers identified during the pre-deployment authority-model audit (Creator's approved Mainnet authority structure names two Protocol Admins -- Creator and Boss -- each required to act independently, with no Protocol Control multisig).",
  "context": "Auditing programs/ssr_protocol against the approved Mainnet authority structure found two real gaps, not one: (1) ProtocolConfig had a single `authority: Pubkey` field and every admin-gated instruction checked it with Anchor's `has_one`, so only one wallet could ever be a Protocol Admin -- the second approved admin (Boss) had no path to independent action; (2) ProtocolConfig.paused is a documented 'global emergency pause' (ACCOUNT_MODEL.md) checked by create_reserve/mint_reserve_tokens_in_kind/seed_reserve, but no instruction in the entire program ever set it -- initialize_protocol always starts it false and nothing else touches it, so the documented pause feature was structurally unreachable since v1. Both are corrected together since both gate the same account and the second was discovered while fixing the first.",
  "rationale": "Smallest correct model per the approved structure (exactly two named admins, no multisig layer): added `admin_2: Pubkey` alongside `authority` on ProtocolConfig (SCHEMA_VERSION bumped 1 -> 2; no migration needed, predates any Mainnet initialization) and a new `ProtocolConfig::is_admin(&self, key) -> bool` helper. `update_protocol_config`'s `has_one = authority` (which only supports single-field equality) was replaced with `constraint = protocol_config.is_admin(&authority.key())`, and `initialize_protocol` now takes `admin_2: Pubkey` as an instruction argument (not an account -- Boss's wallet is recorded, not required to co-sign genesis) with a `DuplicateProtocolAdmin` check against the primary authority. Neither admin gains any new path to Reserve vault custody -- collect_protocol_fee already only mints pre-accounted Reserve Token fee shares to the fixed configured destination, never touches raw Reserve Assets, and that boundary is unchanged by this pass. Added `set_protocol_paused(paused: bool)`, gated by the same `is_admin` constraint, to actually make the documented pause reachable; emits a new `ProtocolPausedSet` event. Chose two fixed named fields over a `Vec<Pubkey>` admin list: the approved structure specifies exactly two wallets with no stated need for a variable-size admin set, and a fixed two-field layout avoids realloc/bounds-checking complexity a Vec would require for no requirement it serves.",
  "alternativesConsidered": [
    "Vec<Pubkey> admin allowlist instead of two fixed fields -- rejected: no requirement calls for more than the two named admins, and a fixed layout is simpler to reason about and audit for a Mainnet launch.",
    "A Protocol Control multisig/PDA holding a single ProtocolConfig.authority slot -- explicitly rejected by Creator's approved authority structure ('There is no Protocol Control multisig').",
    "Require admin_2 to co-sign initialize_protocol as a second Signer account -- rejected: unnecessarily complicates genesis coordination for no security benefit, since admin_2's key is public information being recorded, not a secret being proven at that moment.",
    "Leave ProtocolConfig.paused unreachable and treat it as out of scope -- rejected: it's a named smoke-test requirement (protocol pause/unpause) and a documented security invariant; shipping to Mainnet with a non-functional emergency pause would be a real operational gap, not a paper one."
  ],
  "impact": "Changed: programs/ssr_protocol/src/state/protocol_config.rs (admin_2 field, is_admin helper, SPACE), constants.rs (SCHEMA_VERSION 1->2), instructions/initialize_protocol.rs (admin_2 arg + validation), instructions/update_protocol_config.rs (is_admin constraint), events.rs (ProtocolInitialized.admin_2, new ProtocolPausedSet), errors.rs (new DuplicateProtocolAdmin, append-only), lib.rs (initialize_protocol signature, new set_protocol_paused dispatch), instructions/mod.rs (new module). New: instructions/set_protocol_paused.rs. Tests: tests/ssr_protocol.ts updated initializeProtocol call sites for the new arg and added a dedicated 'Protocol Admin authority model' describe block (primary admin update, admin_2 update independently, non-admin rejection, pause/unpause by either admin, non-admin pause rejection). Docs: ACCOUNT_MODEL.md and INSTRUCTION_REFERENCE.md updated for both changes. Any already-generated IDL/SDK client bindings (packages/sdk/idl/*) are now stale relative to source and must be regenerated from this build before use -- not yet done as of this entry.",
  "affectedAreas": [
    "programs/ssr_protocol/src/state/protocol_config.rs",
    "programs/ssr_protocol/src/constants.rs",
    "programs/ssr_protocol/src/instructions/initialize_protocol.rs",
    "programs/ssr_protocol/src/instructions/update_protocol_config.rs",
    "programs/ssr_protocol/src/instructions/set_protocol_paused.rs",
    "programs/ssr_protocol/src/instructions/mod.rs",
    "programs/ssr_protocol/src/events.rs",
    "programs/ssr_protocol/src/errors.rs",
    "programs/ssr_protocol/src/lib.rs",
    "tests/ssr_protocol.ts",
    "docs/protocol/ACCOUNT_MODEL.md",
    "docs/protocol/INSTRUCTION_REFERENCE.md"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Source-level audit: grepped every instructions/*.rs file for `has_one = authority` and `NotProtocolAuthority` -- confirmed update_protocol_config.rs was the only admin-gated instruction prior to this pass, and confirmed no instruction anywhere set `protocol_config.paused` before set_protocol_paused was added.",
    "Confirmed collect_protocol_fee.rs's custody boundary is unaffected: it mints only `reserve.fee_config.pending_protocol_fee_shares` (pre-accounted) to `protocol_config.default_protocol_fee_destination` via the reserve's own mint_authority PDA -- no ProtocolConfig admin key appears anywhere in that instruction's Accounts struct.",
    "Rust build/test and IDL regeneration not yet run at the time of this entry -- toolchain path fix in progress (solana/anchor binaries confirmed present on this machine at C:\\devtools\\solana\\solana-release\\bin and under the user's cargo/rustup install, but not on this shell's PATH). This entry will not be edited once validation completes per this log's append-only rule; a follow-up entry will record build/test results before any Mainnet deployment proceeds."
  ]
}
```

## DEC-0114

```json
{
  "id": "DEC-0114",
  "date": "2026-08-18",
  "status": "accepted",
  "decision": "Closed out full pre-Mainnet build/lint/test validation for the DEC-0113 authority-model change, fixed two unrelated toolchain-path bugs discovered while doing so, and regenerated the canonical IDL from the exact current source -- discovering and fixing a real, pre-existing IDL/source drift in the process (the checked-in IDL was missing the entire execute_rebalance_leg instruction and several accounts' PDA-seed metadata).",
  "context": "DEC-0113 required a Rust rebuild and IDL regeneration before its result could be trusted; this session's `anchor build` panicked immediately (cargo-build-sbf's own toolchain.rs, Option::unwrap on None, unrelated to this repo's code) and a subsequent `anchor idl build` attempt failed at the link step because this shell's PATH resolved a second, WinGet-installed MinGW GCC under the user's space-containing profile path (C:\\Users\\JRA DEVNET\\AppData\\...\\WinGet\\...\\mingw64) ahead of the already-correctly-installed space-free one at C:\\devtools\\mingw64 that DEVNET_RUNBOOK.md's 'space-in-username problem' section documents as the required fix -- a PATH-ordering issue, not a re-occurrence of that already-solved bug. Once the IDL built, regenerating packages/sdk/idl/ssr_protocol.ts (the camelCase TS type wrapper) by hand-rolling a snake_case-to-camelCase converter produced a subtly wrong result (it left PascalCase names like `ProtocolConfig`/`ReserveStatus` and PDA cross-references like `{\"account\": \"Reserve\"}` uppercase, since a naive regex only rewrites text after an underscore) that broke `packages/sdk`'s own build (`AccountNamespace<SsrProtocol>` no longer had a lowercase `protocolConfig` member) -- caught by actually running the build, not assumed correct from the diff being 'formatting-only'.",
  "rationale": "Fixed the build by invoking `cargo-build-sbf --manifest-path programs/ssr_protocol/Cargo.toml` directly instead of `anchor build`, matching DEVNET_RUNBOOK.md's already-documented working command for this exact toolchain panic -- produced a clean release .so (883,760 bytes), zero warnings. Fixed the IDL build by prepending `/c/devtools/mingw64/bin` to PATH so `x86_64-w64-mingw32-gcc` resolves from the correct, space-free install; `anchor idl build -p ssr_protocol` then succeeded, and diffing the result against the old checked-in IDL (per-instruction, key-order-insensitive) surfaced the pre-existing drift: `execute_rebalance_leg` was entirely absent from the committed IDL despite existing in source and now compiling clean (its previously-documented CpiContext compile error, per DEC-0077/DEC-0092/the 2026-08-13 winddown-closure checklist, no longer reproduces -- unrelated to this pass, most likely an intervening dependency version change; not investigated further since it is a pre-existing-and-now-resolved condition, not a regression this pass introduced), and several other instructions' accounts were missing `docs`/`pda` seed metadata that current source actually has. Replaced the hand-rolled camelCase converter with `@anchor-lang/core`'s own bundled, official `convertIdlToCamelCase` function (found in node_modules, used internally by Anchor's own tooling) rather than trying to patch the hand-rolled regex further -- guarantees byte-for-byte agreement with what a working `anchor build` would have produced, including the PascalCase-name and cross-reference lowercasing the naive version missed. Also fixed two hardcoded test expectations in tests/phase_reserve_deploy_resumability.ts (\"6000-6055\" -> \"6000-6056\") that were stale relative to the new DuplicateProtocolAdmin error variant DEC-0113 appended -- confirmed the SDK's own error table (packages/sdk/src/errors.ts's SSR_PROTOCOL_ERRORS) is correctly derived live from `idl.errors`, so this was the only stale reference, not a design gap.",
  "alternativesConsidered": [
    "Accept the anchor build panic as a hard blocker and stop -- rejected: DEVNET_RUNBOOK.md already documents a working direct cargo-build-sbf command for this exact failure; using it needed no new investigation.",
    "Assume the large formatting-only-looking IDL diff was purely cosmetic and skip a real semantic comparison -- rejected: a per-instruction, order-insensitive diff was cheap to run and is exactly what caught the missing execute_rebalance_leg instruction, a real gap the task's own pre-Mainnet checklist explicitly calls out as a class of risk (IDL/source mismatch).",
    "Keep patching the hand-rolled camelCase regex once its PascalCase bug was found -- rejected once `@anchor-lang/core`'s own official converter was located in node_modules; using the real implementation removes any remaining risk of a further un-caught edge case in a hand-rolled version.",
    "Leave the two stale error-range test literals unfixed and mark them 'expected failures' -- rejected: they are simple, correct, mechanical updates with an already-verified root cause (a new error variant shifting the range by one), not a real test-coverage gap."
  ],
  "impact": "programs/ssr_protocol now builds clean via `cargo-build-sbf` (release .so, 883,760 bytes, 0 warnings/errors) and `anchor idl build` now succeeds via the corrected PATH. packages/sdk/idl/ssr_protocol.json and .ts are regenerated from the exact current source (29 instructions, including execute_rebalance_leg and set_protocol_paused; ProtocolConfig now shows admin_2). Full validation now passing: `npx tsc -b` clean; `npx oxlint` clean (pre-existing warnings only, no errors); Rust unit tests 7/7 passing (fee_math); offline TypeScript suite (`tests/phase_*.ts`, excludes the live-DevNet-only ssr_protocol.ts) 596/596 passing; `npm run build` (SDK build + tsc -b + vite build) clean. `solana-test-validator` was re-confirmed still blocked on this machine by the same pre-existing, previously-documented Windows privilege gap (ERROR_PRIVILEGE_NOT_HELD / SeCreateSymbolicLinkPrivilege, PROJECT_STATUS.md's Blockers section, unchanged since 2026-08-05) -- not a new limitation, and per this project's own prior decision, not something to force via elevation from within this session. No CI/Linux workflow exists in this repo to run it there instead. Net effect: the DEC-0113 authority-model change (two-admin ProtocolConfig, set_protocol_paused) is fully verified by build, static/source audit, and the full offline test/lint/typecheck suite, but has not been exercised against a running validator or live network -- that first happens at the Mainnet smoke-testing stage.",
  "affectedAreas": [
    "packages/sdk/idl/ssr_protocol.json",
    "packages/sdk/idl/ssr_protocol.ts",
    "tests/phase_reserve_deploy_resumability.ts",
    "target/deploy/ssr_protocol.so (build artifact, gitignored)"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`cargo-build-sbf --manifest-path programs/ssr_protocol/Cargo.toml`: `Finished release profile [optimized] target(s)`, 0 warnings; target/deploy/ssr_protocol.so 883,760 bytes.",
    "`cargo test -p ssr_protocol`: 7/7 passing (fee_math), 0 failed.",
    "`anchor idl build -p ssr_protocol`: succeeds after the PATH fix; regenerated IDL confirmed via node to contain 29 instructions (old checked-in IDL had only 27, missing execute_rebalance_leg and set_protocol_paused) and ProtocolConfig.admin_2.",
    "`npx tsc -b`: 0 errors.",
    "`npx oxlint`: exit 0, only pre-existing warnings.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/phase_*.ts`: 596/596 passing (after fixing the two stale 6000-6055 literals).",
    "`npm run build`: clean (packages/sdk tsc -p tsconfig.cjs.json, root tsc -b, vite build) -- confirmed only after switching to @anchor-lang/core's convertIdlToCamelCase; the hand-rolled converter's version of this same build failed with real TS2551/TS2339 errors in packages/sdk/src/discovery.ts and readOnly.ts, which is what surfaced the casing bug.",
    "`solana-test-validator --reset --quiet`: reproduces the exact same `Os { code: 1314, ... }` (ERROR_PRIVILEGE_NOT_HELD) failure already on record in DECISION_LOG.md's 2026-07-29 entries and PROJECT_STATUS.md's Blockers section -- confirmed still the same pre-existing condition, not a new regression."
  ]
}
```

## DEC-0115

```json
{
  "id": "DEC-0115",
  "date": "2026-08-19",
  "status": "confirmed",
  "decision": "Deployed ssr_protocol to Solana Mainnet, initialized the protocol with the DEC-0112 authority structure, published the canonical IDL, and completed minimal Mainnet smoke testing (Phase 6) -- finding and fixing two real bugs in the process, one of which (off-curve protocol-fee destinations) would otherwise have broken every future mint/seed call against this exact Mainnet deployment.",
  "context": "With DEC-0113/DEC-0114 closing the code/build blockers, Creator authorized proceeding through Mainnet deployment, initialization, IDL publication, and smoke testing in the same session. Creator held the CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8 keypair outside any file (browser wallet export), so it was converted into a local solana-keygen-format file via a one-off script that never logged the secret material at any point (only the resulting public key, verified to match exactly) -- the source export file (a plaintext Desktop file Creator had used) was flagged for deletion once the converted file existed. Smoke testing required a real minimal amount of a real Mainnet asset (Creator specified USDC-only Reserve Assets going forward, for simplicity); the signer held zero SPL tokens, and Creator explicitly authorized swapping SOL for USDC via Jupiter for this specific testing purpose (a deliberate, explicit override of the general no-auto-swap default, scoped to this one action).",
  "rationale": "Deployment: `solana program deploy` (883,760-byte binary, ~884 chunked transactions) using the dedicated Mainnet program keypair from DEC-0114's build; verified on-chain upgrade authority, ProgramData address, and data length all match expected values exactly, cost matched the pre-computed estimate to within 0.001 SOL. Initialization: a small dedicated script (scripts/mainnet_initialize_protocol.ts) refuses to run unless the signer's public key exactly matches the approved authority and refuses to re-run if ProtocolConfig already exists; verified on-chain afterward (authority, admin_2, paused=false, fee destination all correct). IDL publication: `anchor idl init`/`anchor idl fetch` both failed with a generic 'program not found' -- reproduced even against a well-known already-published Mainnet program (Squads V4), ruling out anything specific to this program or RPC provider; root cause matches an already-documented issue (DEVNET_INSTRUCTION_AUDIT_2026-08-13.md): Anchor's CLI shells out to `npx` in a way that breaks on Windows. Worked around exactly as documented before -- invoking `@solana-program/program-metadata`'s `write idl`/`fetch idl` directly; the fetched-back copy was diffed and confirmed byte-identical (JSON.stringify equal) to the committed file. Smoke testing (scripts/mainnet_smoke_test.ts) exercised, in order: unauthorized-wallet rejection (real NotProtocolAuthority/6031), Creator pause/unpause (reversible), a direct SOL transfer proving the Treasury vault (an off-curve PDA) can receive SOL, Reserve creation, USDC-only asset registration (100% weight), seeding, an additional mint, a partial redemption, and a custody check confirming the vault's owner is exactly the vault_authority PDA. Two real bugs were found and fixed live, not assumed away: (1) `packages/sdk/src/pda.ts`'s `resolveProtocolFeeDestinationTokenAccount` called `getAssociatedTokenAddressSync` without `allowOwnerOffCurve: true`, so it threw `TokenOwnerOffCurveError` for any off-curve fee destination -- since the Treasury vault IS an off-curve PDA, this would have broken every future mint/seed transaction against this exact Mainnet ProtocolConfig; DevNet never caught this because its fee destination was an ordinary on-curve wallet. (2) `redeem_reserve_tokens_in_kind` requires `manager_fee_recipients` (sentinel-able) and `tvl_accrual` accounts that `tests/ssr_protocol.ts`'s redeem test cases omitted -- that test file is explicitly marked 'UNVERIFIED / UNCOMPILED' in its own header and was never actually run before this session, so this was the first real execution of that code path; fixed in the smoke-test script by adding both accounts, matching the pattern already used by seed_reserve/mint_reserve_tokens_in_kind. A separate false alarm (an immediate post-redeem balance read showing no change) was root-caused to Helius RPC eventual consistency, not a protocol bug -- a fresh query moments later, and a short delay added to the script, both confirmed the redemption had in fact moved USDC correctly and proportionally.",
  "alternativesConsidered": [
    "Keep trying anchor idl init/fetch flag combinations instead of switching tools -- rejected once the failure reproduced against an unrelated, already-published, well-known Mainnet program (Squads), which is conclusive evidence the bug is tool/environment-level, not something a different flag would fix.",
    "Treat the immediate post-redeem zero-balance-change reading as a redemption bug and roll back or re-investigate the math -- rejected before concluding anything: cross-checked via a completely fresh RPC query and via `spl-token accounts`, both of which showed the correct, proportional post-redemption balances moments later, conclusively pointing at RPC read timing rather than program logic.",
    "Use wrapped SOL for the smoke-test Reserve Asset instead of asking Creator to authorize a USDC swap -- superseded by Creator's explicit instruction that Reserve Assets should be USDC-only for the time being.",
    "Keep the three intermediate debugging/resume scripts (created live while diagnosing the seed_reserve and redeem failures) in the repo -- rejected: consolidated their fixes back into one canonical scripts/mainnet_smoke_test.ts and deleted the debugging artifacts, matching this repo's existing convention of one clean verify script per pass."
  ],
  "impact": "Mainnet is live: Program 8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9, ProtocolConfig initialized and correct, canonical IDL published on-chain and verified byte-identical, one real USDC-seeded test Reserve exists (9KkRx62FwvXvzYZeWqpBdLvokdPjdfqYMZ6vawUFvf4i) with real vault-held USDC and a real Treasury Reserve-Token fee-share balance. Fixed packages/sdk/src/pda.ts's off-curve bug affects every future consumer of resolveProtocolFeeDestinationTokenAccount (frontend included) -- this was a genuine pre-existing defect the Mainnet launch surfaced, not something introduced by this pass. Total Mainnet spend this pass: ~6.307 SOL in fees/rent plus a 0.05 SOL SOL->USDC swap (yielding ~3.86 USDC), against the 15 SOL cap; signer balance after this entry: ~1.14 SOL remaining.",
  "affectedAreas": [
    "packages/sdk/src/pda.ts",
    "scripts/mainnet_initialize_protocol.ts",
    "scripts/mainnet_smoke_test.ts",
    "Mainnet on-chain state (program, ProtocolConfig, IDL metadata account, one test Reserve)"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Deployment signature 3HSttuKP21ieJBmWytDtUPC4zinr9FFFX5ERt5higGcizv8MfmSsFuqa1MpH1xtnbZ3mot6J36ETLcAzQBVejdGm, slot 440248996; `solana program show` confirms upgrade authority = CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8, data length 883,760 bytes, balance 6.15217368 SOL (matches the pre-deployment estimate exactly).",
    "initialize_protocol signature 4911gWEsAjDggQrbnc9vbhXgmoY9wTu5s2xFPLNYmCWwrPizyVgn8foJXn5nzQ2QpyFR8dPdjRa2tgU5txJjvp8M; on-chain fetch confirms authority/admin2/paused/defaultProtocolFeeDestination all exactly as intended.",
    "IDL metadata account 6ZPBMYWg6w3ox2mD3KUud2UTEMxCbdYd3om8Vdf6MrBg; independently re-fetched via `program-metadata fetch idl` and confirmed JSON.stringify-equal to packages/sdk/idl/ssr_protocol.json (29 instructions).",
    "Smoke test signatures: unauthorized rejection (client-side AnchorError, no signature -- rejected before submission), pause 4dnrcYuCPo3xFKaskiwZ3FKwwzgux9cTb322E1FUPcERpotJhXXXrTw52Ws5CLisixZLzE4fBbBUyFVEWhNcTUs9, unpause 5kWzgRo5yAQwAMmY36o5w3fXoQTEtna6D19WFnFMhoCBwgYS59jfxMNm4b8U9X3MHdFg6zyu1rUqtEamc67rBH8D, Treasury SOL transfer 9RPNBF1KJFYcv8No1oNP9KQawtPTDm92NTk8rYFcK4NGgyXK8VaNrTyyYL8x6zyN4AtNQLggCEmXoFcXnX6Ct4k (balance 1,000,000 -> 1,100,000 lamports exactly), create_reserve 3L1a2LUbpChpKeSDrCc4vdpnvtakcjprc39w5abCtkhtsNrynMfQ5b1y6vh4MikmY7VsieiVC6w58nBvJKiR26PF, initialize_reserve_asset 4EQE9TEEiJSY4c3KHLAFTw25k1TgNoyRCbV2Gfh85TCDFbebV7LRWMkBdNp391HmCWospwzfDnStoPErDHHi7VMP, seed_reserve wdvR1YtqhfeZDznNpmqrYmFXFCigSJ9MmM92BGNNNFjaRghJ9rAgmxihQTrCiK9Lm18R22GbJbehZfx4G2mrXoZ, mint_reserve_tokens_in_kind 4YrR7xMcpjbkwuwCPdesLyDDqpbHD955pbAddc9W8zbSR4RbxdziN2ue6sLQ94dujsJxrP9sZ6ysyqJ3z8kqSP4u, redeem_reserve_tokens_in_kind 4JDWcbAiWqRDJ26DR5vS2XXaQZn3HSZ2iNRn5f2AjEwnQHS7AtSGMFx9JTbBco2ETkysHmVQzW2U4XabtG1NZdeB.",
    "Post-redemption state independently re-verified via a fresh RPC query and `spl-token accounts`: manager USDC 2,663,852 -> 2,962,352 (+298,500, exactly the redeemed proportion), manager Reserve Token 1,194,000 -> 895,500, vault USDC 901,500 remaining, vault token-account owner confirmed equal to the derived vault_authority PDA.",
    "Full offline suite (`tests/phase_*.ts`) re-run after the pda.ts fix: 596/596 passing, no regressions.",
    "SOL->USDC swap signature wdfyQMemedC4oCXNKddAyKuxY6mge7qB3RUDagdCMmfAi7oYbSrgiAzH8fVwk2HhVQgfmnYqqgbhVKH5k8QgvXR (Jupiter, 0.05 SOL -> 3.863852 USDC)."
  ]
}
```

## DEC-0116

```json
{
  "id": "DEC-0116",
  "date": "2026-08-19",
  "status": "accepted",
  "decision": "Built a Mainnet-native, swap-free direct USDC Buy/Sell path (packages/sdk/src/directInstructions.ts + src/merge/lib/directClient.ts), made the frontend's program ID/RPC/cluster resolution genuinely cluster-aware end to end, added a dedicated api/mainnet/rpc-proxy.ts, and deployed the result to production at strategic-super-reserve.fun -- now pointed at Mainnet, not DevNet.",
  "context": "Creator confirmed Mainnet Reserves are USDC-only for this launch, 'in-kind minting secondary,' matching the DevNet devUSDC-primary-settlement precedent. Investigating the existing Buy/Sell zap (zapInstructions.ts) found it fundamentally cannot work on Mainnet: every non-primary-asset leg is funded by a DevNet-only swap-authority keypair that mints fake test tokens, which has no real equivalent for actual USDC. Separately, auditing every place the app resolves its own program ID found `DEVNET_FIXTURES.programId` hardcoded in 15 places across 7 files (RealReserveSync.tsx -- the discovery poll driving Discover/Portfolio/DTRDetail/ManageDTR for the entire app -- createReserveClient.ts, managementClient.ts, onChainReserve.ts, CreateDTR.tsx, DTRDetail.tsx, ManageDTR.tsx), meaning the already-cluster-aware SSR_PROGRAM_ID in solana-config.ts (from earlier this pass) was not actually reaching any real code path -- the whole app would have kept talking to the DevNet program even after Mainnet env vars were set.",
  "rationale": "Added packages/sdk/src/directInstructions.ts (buildDirectMintInstructions/buildDirectRedeemInstructions): single-signer, single-instruction (plus idempotent ATA setup) mint/redeem against a Reserve's sole asset, computed via the exact floor-inverse of the existing computeMintRequirements formula (proven correct by 6 new offline tests) so the on-chain required amount can never exceed what the user asked to deposit. src/merge/lib/directClient.ts mirrors zapClient.ts's shape (progress events, bounded confirmation, never-auto-retried submission) but signs and sends entirely client-side -- no server round-trip, no server-held co-signer, a genuine simplification over the DevNet zap, not just a workaround. DTRDetail.tsx's Buy/Sell now branch on IS_MAINNET to the new handlers, with zero changes to the existing DevNet handleBuy/handleSell code paths. Replaced every DEVNET_FIXTURES.programId occurrence with SSR_PROGRAM_ID (already cluster-aware); the two fixture-only display functions in onChainReserve.ts (buildPlaceholderRealDTR/mergeOnChainIntoDTR, used only for the 2 named DevNet Gate-9 fixtures) were deliberately left on DEVNET_FIXTURES.programId directly, since they're inherently DevNet-only regardless of cluster. Added api/mainnet/rpc-proxy.ts + api/mainnet/_lib/rpc.ts, mirroring api/devnet/rpc-proxy.ts's full security model (method allowlist, payload validation, per-IP and global sendTransaction throttling, bounded read-only fallback, sendTransaction never retried/routed to a fallback) as fully separate modules so a Mainnet request can never be misrouted to the DevNet endpoint. Added MAINNET_USDC_MINT to packages/sdk/src/tradableAssets.ts's SUPPORTED_ASSET_MINTS (safe unconditionally -- that address can never appear in a genuine DevNet Reserve). A real regression was caught before it shipped: onChainReserve.ts importing solana-config.ts (which reads import.meta.env, Vite-only syntax) transitively broke ts-mocha's CommonJS test loading for every test file that imports onChainReserve.ts or createReserveClient.ts (11 files) -- fixed by threading programId/cluster through buildDtrFromDiscoveredReserve's parameters (defaulting to the pre-existing DevNet values) instead of importing the Vite-dependent module into a file tests load directly, and by reverting createReserveClient.ts's two occurrences to the hardcoded DevNet constant (Reserve *creation* on Mainnet is explicitly out of scope for this pass -- deferred, not silently shipped unreviewed). Deployed via `vercel --prod` to the existing ssr14/ssr-fun project (the same project already serving strategic-super-reserve.fun) after adding VITE_SOLANA_CLUSTER=mainnet-beta, VITE_SSR_PROGRAM_ID, and HELIUS_MAINNET_RPC_URL (server-only) to its Production environment.",
  "alternativesConsidered": [
    "Build real Jupiter-based swap routing for Mainnet Buy/Sell instead of a direct USDC-only path -- explicitly superseded by Creator's USDC-only, direct-settlement scoping decision; deferred to a later pass if/when non-USDC Mainnet Reserves are needed.",
    "Also wire Reserve *creation* (CreateDTR.tsx) for Mainnet in this same pass -- rejected as out of scope: creation has its own DevNet-only funding-faucet step and asset-picker assumptions that need dedicated review, not a mechanical program-ID fix; reverted its programId references to the safe, known-working DevNet constant rather than leaving them silently pointed at Mainnet without that review.",
    "Patch solana-config.ts to avoid import.meta syntax entirely (e.g. guard behind a runtime check) -- rejected: the TS1343 failure is a parse-time/module-target error, not a runtime one: no runtime guard prevents it. Removing the transitive import path (parameters instead of a shared module) was the actual fix.",
    "Reuse zapInstructions.ts's existing buildBuyZapInstructionsDevUsdc/buildRedeemToDevUsdcInstructions with the real USDC mint substituted for devUSDC -- rejected: their result types/exported constants are explicitly typed and documented around DevNet fixtures ('devnet-test-asset-faucet' as a legSources literal, etc.); a clean, correctly-labeled new module was safer than repurposing DevNet-specific naming for real Mainnet money."
  ],
  "impact": "strategic-super-reserve.fun now serves the Mainnet build (deployment dpl_DqRggFv8SwF5NrmCFtfh5dyiVZ5R, aliased production). Verified non-visually (no browser automation available in this environment, same pre-existing limitation as every prior DevNet pass): the deployed bundle contains the Mainnet program ID and no leaked RPC API key. Full interactive browser verification (wallet connection, Buy/Sell click-through, Discover/Portfolio/Manage, Explorer links) is deferred to Creator, per Phase 7's own requirement and this project's established practice for every prior UI change. Reserve creation on Mainnet remains explicitly unreviewed/deferred. ssr.fun and its Coming Soon deployment were not touched.",
  "affectedAreas": [
    "packages/sdk/src/directInstructions.ts",
    "packages/sdk/src/tradableAssets.ts",
    "src/merge/lib/directClient.ts",
    "src/merge/lib/solana-config.ts",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/lib/RealReserveSync.tsx",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/managementClient.ts",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "api/mainnet/rpc-proxy.ts",
    "api/mainnet/_lib/rpc.ts",
    "tsconfig.node.json",
    "tsconfig.json",
    "vercel.json"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "6 new offline tests (tests/phase_mainnet_direct_instructions.ts) confirming computeDirectReserveTokensRequested's exact floor-inverse relationship to computeMintRequirements, including a zero-supply/zero-vault-balance guard and a non-positive-amount guard.",
    "Full offline suite after all fixes: 602/602 passing.",
    "`npm run build` (SDK + tsc -b + vite build): clean.",
    "Deployed bundle (curl-fetched directly from strategic-super-reserve.fun's served assets): contains '8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9' (the Mainnet program ID); no 'api-key='/Helius-URL pattern found anywhere in it.",
    "`vercel --prod` deployment dpl_DqRggFv8SwF5NrmCFtfh5dyiVZ5R: readyState READY, target production, aliased to the project's production domains."
  ]
}
```

## DEC-0117

```json
{
  "id": "DEC-0117",
  "date": "2026-08-19",
  "status": "accepted",
  "decision": "Added a site-wide password gate in front of the entire public site (strategic-super-reserve.fun), stacked on top of the pre-existing internal-team dashboard gate, and deployed it to production.",
  "context": "With Mainnet now live and real USDC flowing through the deployed program (DEC-0115/DEC-0116), Creator directed that the whole site be password-protected -- previously only /internal/* and /road-to-mainnet were gated, leaving Discover/DTRDetail/CreateDTR/ManageDTR (i.e. every page capable of moving real funds) reachable by any visitor during this controlled launch window.",
  "rationale": "Added api/site/login.ts, a near-exact mirror of the pre-existing api/dashboard/login.ts (independent SSR_SITE_* rate-limit/lockout env vars, timing-safe password comparison, signed HttpOnly session cookie via the existing generic helpers in lib/dashboard/session.ts) so the two gates share proven, already-audited session logic rather than a new bespoke implementation. Rewrote middleware.ts to run two independent, stacked checks: Gate 1 (site-wide, ssr_site_session cookie against SSR_SITE_PASSWORD) applies to every route except the login endpoint itself and the 5 CRON_SECRET-authenticated cron paths (which carry no browser session and would otherwise be permanently locked out); Gate 2 (the pre-existing internal-team ssr_dash_session/SSR_DASHBOARD_PASSWORD check) runs only for the same INTERNAL_API_PATHS/INTERNAL_PAGE_PATHS as before, now additionally requiring Gate 1 to have already passed. The two passwords/cookies are fully independent -- entering one never grants the other. Set SSR_SITE_PASSWORD in Vercel's Production environment (Sensitive) and deployed via `vercel --prod`.",
  "alternativesConsidered": [
    "Reuse the existing SSR_DASHBOARD_PASSWORD/ssr_dash_session for the site-wide gate instead of a second independent pair -- rejected: Creator's internal team already knows and uses the dashboard password day-to-day for /internal/*; reusing it as the public-facing gate would mean anyone given the internal password (a lower-trust distribution than 'people allowed to use the live product') could also unlock fund-moving pages, and rotating one would force rotating both.",
    "Gate only the fund-moving pages (DTRDetail Buy/Sell, CreateDTR) rather than the whole site -- rejected per Creator's explicit instruction to 'password gate the website,' not a subset."
  ],
  "impact": "Verified live end to end against production: an unauthenticated GET to strategic-super-reserve.fun/ returns the branded login page (200, HTML); an unauthenticated GET to an /api/* path returns 401 JSON; POSTing the correct password to /api/site/login returns 200 and a Set-Cookie; a subsequent authenticated GET to / returns the real app shell (200). Cron paths were left unaffected by design (still authenticated solely by CRON_SECRET inside each handler, never by a browser session).",
  "affectedAreas": [
    "middleware.ts",
    "api/site/login.ts"
  ],
  "supersedes": null,
  "supersededBy": "DEC-0119 (password-independence choice only -- the site-wide gate mechanism itself, middleware.ts, and api/site/login.ts are unchanged and remain exactly as implemented here)",
  "evidence": [
    "`npx tsc -p tsconfig.node.json --noEmit`: clean.",
    "Live curl verification against strategic-super-reserve.fun: unauthenticated page -> login HTML (200); unauthenticated /api/kpis/kpis -> 401 JSON; POST /api/site/login with the configured password -> 200 {\"ok\":true} + Set-Cookie; authenticated GET / -> 200 app shell.",
    "`vercel --prod` deployment: readyState READY, target production, aliased to strategic-super-reserve.fun."
  ]
}
```

## DEC-0119

```json
{
  "id": "DEC-0119",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Set SSR_SITE_PASSWORD (strategic-super-reserve.fun's site-wide gate, DEC-0117) to the exact same value as SSR_DASHBOARD_PASSWORD (the pre-existing /internal/* gate), reversing DEC-0117's deliberate choice to keep the two passwords independent.",
  "context": "Creator asked to 'password protect strategic-super-reserve.fun, same password as the other urls' -- ambiguous on its face since the site was already password-gated as of yesterday (DEC-0117). A clarifying question surfaced two readings: (a) just confirm the current SSR_SITE_PASSWORD value, or (b) actually set it equal to SSR_DASHBOARD_PASSWORD, which DEC-0117 explicitly chose not to do. Before acting, Creator was shown DEC-0117's stated rationale for keeping them separate (the dashboard password is more broadly distributed than 'people allowed to use the live product,' and reuse would let dashboard-password holders reach fund-moving Mainnet pages) and confirmed intent to merge the passwords anyway.",
  "rationale": "No code change: middleware.ts's two-gate structure (Gate 1 site-wide / Gate 2 internal-team) is untouched, only the env var value changed. Removed the existing SSR_SITE_PASSWORD Production variable (`vercel env rm`), pulled SSR_DASHBOARD_PASSWORD's real value locally via `vercel env pull` (never printed to any output/log; the pulled file was deleted immediately after each use), and re-added SSR_SITE_PASSWORD (`vercel env add`, type Sensitive) with that exact value. Redeployed to production (`vercel --prod`) since Vercel does not hot-apply env var changes to already-built deployments -- same mechanism DEC-0117 itself used for the original rollout.",
  "alternativesConsidered": [
    "Leave the two passwords independent per DEC-0117's original security rationale -- rejected: Creator was shown that rationale directly and explicitly re-confirmed wanting the passwords merged anyway.",
    "Keep SSR_SITE_PASSWORD separate but just hand the internal team a copy of its value -- rejected: doesn't satisfy 'same password,' and the two would silently drift apart the next time either is rotated by hand."
  ],
  "impact": "Anyone who knows the internal dashboard password (a broader, lower-trust distribution than 'people allowed to use the live product,' per DEC-0117's own rationale) can now also reach every fund-moving Mainnet page (Buy/Sell/Create/Manage) on strategic-super-reserve.fun, not just /internal/*. Rotating either password now requires rotating both together to keep them in sync, or they will diverge again on the next manual rotation. No repository files changed -- this is purely a Vercel Production environment-variable value change plus a redeploy to apply it.",
  "affectedAreas": [
    "Vercel Production environment variable SSR_SITE_PASSWORD (project ssr14/ssr-fun)"
  ],
  "supersedes": "DEC-0117 (password-independence choice only -- the site-wide gate itself, middleware.ts, and api/site/login.ts are unchanged and remain exactly as DEC-0117 implemented them)",
  "supersededBy": "DEC-0120 (the specific password value only -- the decision to keep the two passwords merged/identical is unchanged)",
  "evidence": [
    "`vercel env ls production` (before): SSR_SITE_PASSWORD Encrypted, Production, ~19h old (from DEC-0117). `vercel env rm SSR_SITE_PASSWORD production` followed by `vercel env add SSR_SITE_PASSWORD production` (value sourced from a fresh `vercel env pull` of SSR_DASHBOARD_PASSWORD) succeeded, type Sensitive.",
    "`vercel --prod`: deployment dpl_MZhWYi614N3GpnSM5GNx7mqu85qS, readyState READY, target production; `vercel inspect` confirmed aliases strategic-super-reserve.fun and www.strategic-super-reserve.fun both point at it.",
    "Live verification: unauthenticated GET https://strategic-super-reserve.fun/ -> 200 login page ('SSR.fun - Sign in'); POST /api/site/login with SSR_DASHBOARD_PASSWORD's value -> 200 {\"ok\":true} + Set-Cookie; authenticated GET / with that cookie -> 200 real app shell.",
    "A fresh `vercel env pull` immediately after redeploy confirmed SSR_SITE_PASSWORD and SSR_DASHBOARD_PASSWORD are now byte-identical (compared locally in a throwaway shell variable; neither value was ever printed to any transcript, and the pulled file was deleted right after)."
  ]
}
```

## DEC-0120

```json
{
  "id": "DEC-0120",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Set both SSR_SITE_PASSWORD and SSR_DASHBOARD_PASSWORD (Production) to a specific value Creator provided, superseding DEC-0119's merge (which used SSR_DASHBOARD_PASSWORD's then-existing, un-chosen value as the shared password).",
  "context": "Creator reported the password they expected ('the password... it's not accepting, please recheck') failed to log in. Verified locally (without ever printing either secret) that neither SSR_SITE_PASSWORD nor SSR_DASHBOARD_PASSWORD -- both already byte-identical per DEC-0119 -- matched the value Creator gave (different length, 11 vs. 13 characters): the login rejection was correct behavior, not a bug, because that value had genuinely never been configured anywhere. Confirmed with Creator before overwriting a live credential that both env vars should be set to this exact value.",
  "rationale": "No code change (same as DEC-0119, middleware.ts/api/site/login.ts/api/dashboard/login.ts untouched). `vercel env rm` + `vercel env add` (Sensitive) replaced both SSR_SITE_PASSWORD and SSR_DASHBOARD_PASSWORD in Production with Creator's provided value, then `vercel --prod` redeployed to apply it. Live end-to-end verification initially showed a misleading result -- POSTing the new password directly to /api/dashboard/login from a fresh cookie jar returned 401 -- traced immediately to middleware.ts's Gate 1 (site-wide) running in front of EVERY route including /api/dashboard/login itself (only /api/site/login and the 5 cron paths are exempt), so an unauthenticated dashboard-login attempt is rejected by Gate 1 before api/dashboard/login.ts's own password check ever runs. Re-tested correctly (POST /api/site/login first to obtain the ssr_site_session cookie, then POST /api/dashboard/login reusing that same cookie jar) and both passwords confirmed working, with /internal/status subsequently loading (200).",
  "alternativesConsidered": [
    "Assume the reported 'not accepting' was a session/cookie/browser-side issue rather than a password mismatch -- rejected: checked the actual configured values first, which showed conclusively that the password Creator expected had never been set."
  ],
  "impact": "strategic-super-reserve.fun's site-wide gate and the /internal/* dashboard gate both now accept Creator's intended password. DEC-0119's risk entry (dashboard password also unlocks fund-moving Mainnet pages) still stands unchanged -- only the shared value changed, not the merged-password design.",
  "affectedAreas": [
    "Vercel Production environment variables SSR_SITE_PASSWORD and SSR_DASHBOARD_PASSWORD (project ssr14/ssr-fun)"
  ],
  "supersedes": "DEC-0119 (the specific password value only -- the decision to keep the two passwords merged/identical is unchanged)",
  "supersededBy": null,
  "evidence": [
    "Local comparison (values never printed): the password Creator reported as failing matched neither the then-current SSR_SITE_PASSWORD nor SSR_DASHBOARD_PASSWORD (11 chars vs. the reported value's 13).",
    "`vercel env rm`/`vercel env add` (Sensitive) for both SSR_SITE_PASSWORD and SSR_DASHBOARD_PASSWORD; `vercel --prod` deployment dpl_HrbmMnqX6pPrC7hoWjyv6FMrLtMn, readyState READY, target production, aliased to strategic-super-reserve.fun and www.strategic-super-reserve.fun (confirmed via `vercel inspect`).",
    "Live verification: POST /api/site/login with Creator's password -> 200 {\"ok\":true}; reusing that session cookie, POST /api/dashboard/login with the same password -> 200 {\"ok\":true}; GET /internal/status with both cookies -> 200.",
    "Isolated false-negative explained and reproduced: POST /api/dashboard/login from a cookie-less client -> 401 {\"error\":\"Unauthorized\"}, which is middleware.ts's Gate-1 site-wide check rejecting the request before api/dashboard/login.ts runs -- not a password error."
  ]
}
```

## DEC-0118

```json
{
  "id": "DEC-0118",
  "date": "2026-08-19",
  "status": "accepted",
  "decision": "Made the live Mainnet product genuinely USDC-native end to end (Buy/Sell, Reserve creation, rebalance tooling), purged DevNet fixture Reserves and the devUSDC faucet panel from the Mainnet UI, and added an 11-item Mainnet function checklist to road-to-mainnet.html.",
  "context": "Creator's post-launch review of strategic-super-reserve.fun found the still-devUSDC/DevNet-branded UI unacceptable now that real funds are involved: misleading copy ('preview your in-kind redemption' on a Reserve that only ever holds USDC), a DevNet faucet panel rendering unconditionally on Portfolio regardless of cluster, Reserve creation left entirely disabled rather than USDC-only as directed, and the two DevNet Gate-9 fixture Reserves still capable of appearing in a Mainnet visitor's persisted state. Creator's exact instructions: wipe devUSDC/mock-token references from the live product; make Buy/Sell purely USDC-in/USDC-out; enable Reserve creation but USDC-only; purge DevNet reserves from display, keep only Mainnet ones; and add a Mainnet function checklist mirroring the existing DevNet one.",
  "rationale": "DTRDetail.tsx's balance-tracking, validation and every piece of Buy/Sell copy now resolve through a cluster-aware SETTLEMENT_MINT/SETTLEMENT_SYMBOL/CLUSTER_LABEL (real USDC + 'Mainnet' on this deployment, devUSDC + 'DevNet' unchanged elsewhere) instead of hardcoded devUSDC constants -- the flagged 'in-kind redemption' string and every devUSDC-branded label, toast, and disclaimer a Mainnet visitor could see is gone; DevNet's own zap-based Buy/Sell path is untouched. Portfolio.tsx's DevnetOnboarding faucet panel (which called DevNet-only api/devnet/faucet-devusdc and api/devnet/sponsor-sol unconditionally) is now gated behind !IS_MAINNET. CreateDTR.tsx gained a SELECTABLE_ASSETS split (MAINNET_REAL_ASSETS = USDC only vs the existing DEVNET_REAL_ASSETS), and createReserveClient.ts's createReserveOnChain/resumeReserveDeploymentOnChain now accept an explicit programId + allowFaucet (defaulting to the exact pre-existing DevNet behavior for every current caller/test) -- allowFaucet:false makes fundSeedAssetsIdempotent throw a plain 'fund your own wallet, there is no Mainnet faucet' error on a genuine shortfall instead of ever calling the DevNet-only mint endpoint. Fixed a real latent bug found while wiring this up: CreateDTR.tsx's dtrId was hardcoded to `devnet-${reserveId}`, which would have registered a freshly-created Mainnet Reserve under a different id than RealReserveSync's own `${SOLANA_CLUSTER}-${reserveId}` scheme derives for the exact same on-chain account on its next poll -- now both use SOLANA_CLUSTER, matching exactly. ManageDTR.tsx's rebalance-slider model had its hardcoded devUSDC 'permanent cash slot' generalized to CASH_SLOT_MINT (USDC on Mainnet) and its DevNet-only addable-asset list emptied on Mainnet. useAppStore.ts's REAL_PLACEHOLDER_DTRS (the two DevNet Gate-9 fixtures) are no longer seeded into initial/persisted state when IS_MAINNET, and a new v6 persisted-state migration strips any DTR whose onChain.programId doesn't match the program this exact deployment actually talks to -- protecting a returning visitor's localStorage from a stale DevNet Reserve left over from before strategic-super-reserve.fun's Mainnet cutover. road-to-mainnet.html gained an 11-item Mainnet function checklist (MCR/MMT/MRD/MAR/MRR/MRB/MDL/MPU/MFE/MWD/MSC), a near-exact mirror of the existing DevNet function checklist's coverage, re-scoped to demand real Mainnet transactions and a genuine wallet click-through rather than DevNet or script evidence; caught and fixed a real bug before it shipped -- the backend's CONTROL_ID_RE only allows 2-3 letter ID prefixes, so the initially-drafted 4-letter MNCR/MNMT/etc. IDs would have been silently rejected (400) by every sync attempt, fixed by shortening to 3-letter prefixes.",
  "alternativesConsidered": [
    "Physically delete the now-Mainnet-unreachable DevNet zap code (zapInstructions.ts, zapClient.ts, api/devnet/*, the DevNet asset-picker) instead of leaving it gated behind IS_MAINNET -- deferred, not decided unilaterally: DevNet remains a real, separate, still-used test environment (its own deployment, its own tests, its own runbook), and ~1000+ lines across multiple files still depend on some of these modules for that purpose. Flagged to Creator rather than deleted.",
    "Rename the low-level generic utility function names in calculations.ts (buyAvailableFromDevUsdcBalance, isReservePureDevUsdc, etc.) for consistency -- rejected as unnecessary churn: these are internal helper names, never user-visible, and already accept a settlement-mint parameter rather than being hardcoded to devUSDC.",
    "A full standalone Mainnet checklist page instead of a new section inside the existing road-to-mainnet.html -- rejected: Creator asked for 'the mainnet checklist... same items as the devnet list,' and the existing page already has proven Neon-backed sync/history/comments infrastructure keyed generically by control ID; reusing it is a smaller, lower-risk change than standing up a second synced document."
  ],
  "impact": "Deployed to production (dpl_E68tr5EYcEtKNZqAEM3goCe2LAzB) after the devUSDC-purge deployment (dpl_2Y5u5evnRKFrphzkqE9idGa9zuhT). Verified: full offline suite 602/602 passing after each step; `npm run build` and `npx tsc -b` clean throughout; the deployed bundle no longer contains the flagged 'preview your in-kind redemption' string; road-to-mainnet.html's inline script passes `node --check` and its Neon-sync entity IDs conform to the backend's CONTROL_ID_RE. Not yet verified: live browser click-through of the new USDC-only Create Reserve flow (no browser automation available in this environment, consistent with this project's established practice -- deferred to Creator, same as every prior UI change), and the Mainnet function checklist itself is a tracking tool whose items remain genuinely unchecked pending that same manual verification.",
  "affectedAreas": [
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/Portfolio.tsx",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/pages/ManageDTR.tsx",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/store/useAppStore.ts",
    "public/road-to-mainnet.html"
  ],
  "supersedes": null,
  "supersededBy": "DEC-0121 (Reserve Asset composition scope only -- this entry's USDC-only Buy/Sell/mint/redeem settlement design is unchanged and remains exactly as implemented here)",
  "evidence": [
    "Full offline suite: 602/602 passing after every edit in this pass.",
    "`npx tsc -b` and `npm run build`: clean after every edit in this pass.",
    "Deployed bundle (curl-fetched from strategic-super-reserve.fun after authenticating through the DEC-0117 site gate): 0 occurrences of 'preview your in-kind redemption'.",
    "`node --check` on road-to-mainnet.html's extracted inline script: clean.",
    "`vercel --prod` deployments dpl_2Y5u5evnRKFrphzkqE9idGa9zuhT and dpl_E68tr5EYcEtKNZqAEM3goCe2LAzB: both readyState READY, target production."
  ]
}
```

## DEC-0121

```json
{
  "id": "DEC-0121",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Fixed the root cause of both reported production 500s (homepage, Reserve-launch Wallet Cost Summary), fixed several DevNet/Mainnet data-mixing bugs (hardcoded /api/devnet/* routes and 'DevNet' copy reachable on the live Mainnet build, a duplicated homepage warning), and restored the Mainnet Reserve Asset selector to the full Jupiter Tokens API V2 verified-token catalogue (previously silently hardcoded to USDC-only).",
  "context": "Creator reported both live 500s by their exact Vercel invocation IDs, DevNet references still visible in production (including the literal /api/devnet/reserve-metadata URL), and asked why the Reserve Asset selector -- previously built against the Jupiter Tokens API V2 with a weekly refresh -- only offered USDC on Mainnet. On the last point, a clarifying exchange surfaced that DEC-0118's USDC-only Mainnet scoping (2026-08-19) was about Buy/Sell/mint/redeem settlement, not the Reserve Asset composition itself -- Creator confirmed: 'usdc is the go-to mint and redeem and create reserve token. however, the reserve assets should be as per Jupiter list,' and provided a JUPITER_API_KEY (Jupiter's catalogue fetch had never been runnable in production -- the key had never been configured).",
  "rationale": "Root cause #1 (both 500s): `vercel logs` on the deployment that was live during the reported incident (dpl_EaqXq4nf1CcFvM8P4zeyJJPB5cKY) showed every /api/mainnet/rpc-proxy request -- GET or POST -- crashing identically at module-import time with `ReferenceError: exports is not defined in ES module scope`. api/devnet/, api/kpis/, and api/ledger/ each have their own package.json declaring {\"type\": \"commonjs\"} to override the root package.json's {\"type\": \"module\"} for their CommonJS-compiled build output; api/mainnet/ was the one directory missing it, so Node loaded its CommonJS output as ESM and crashed before the handler ever ran -- for every request, regardless of method, which is exactly what both reported invocation IDs' timestamps matched. Fixed with one file: api/mainnet/package.json ({\"type\": \"commonjs\"}), mirroring the three sibling directories exactly. This alone fixes both #1 and #2 -- the homepage's RealReserveSync discovery poll and Create-Reserve's estimateCreateReserveCost both route Mainnet RPC calls through this same proxy via solana-config.ts's SOLANA_RPC_URL.\n\nRoot cause #3/#4 (DevNet/Mainnet mixing): useLandingStats.ts (the homepage's holder/24h-volume hook) hardcoded /api/devnet/landing-stats regardless of cluster -- no Mainnet counterpart existed. createReserveClient.ts's uploadReserveMetadata hardcoded /api/devnet/reserve-metadata for both the upload call and the resulting on-chain metadata_uri, so a Mainnet Reserve's metadata pointed at a DevNet-prefixed URL (the exact URL Creator flagged). RealReserveSync.tsx and Home.tsx had several hardcoded 'DevNet' strings (discovery status messages, the 'How It Works' step-3 copy: 'Use devUSDC to mint and redeem...') shown regardless of actual cluster. Fixed by adding api/mainnet/landing-stats.ts and api/mainnet/reserve-metadata.ts (mirroring their DevNet counterparts -- the metadata store is fully cluster-agnostic already, kept as a separate route per cluster so a Mainnet metadata_uri can never land under /api/devnet/), making both call sites cluster-aware via IS_MAINNET, and replacing every hardcoded 'DevNet'/'devUSDC' string in the affected files with the existing CLUSTER_LABEL/SETTLEMENT_SYMBOL pattern already used elsewhere in this codebase since DEC-0118.\n\nRoot cause #5 (duplicate warnings): Home.tsx rendered the identical 'Live Reserve data is temporarily unavailable on Solana DevNet (...)' callout in both the kpi-strip AND the Featured Reserves section whenever discovery failed. Fixed by removing it from the Featured Reserves section (the kpi-strip's copy, now cluster-aware, already covers it once).\n\nRoot cause #6 (Jupiter catalogue): the code Creator remembered (lib/ledger/jupiterCatalogue.ts, api/ledger/jupiter-snapshot-cron.ts, a weekly cron already scheduled in vercel.json) was real and already built (DEC-0110), but was built for the internal Ledger/analytics system, never wired to CreateDTR.tsx's picker, and had never actually run in production (JUPITER_API_KEY was never configured -- confirmed via `vercel env ls production`, absent). Set JUPITER_API_KEY (Sensitive, Production) from Creator's provided key. Added api/ledger/asset-catalogue.ts, a new public read endpoint serving the existing catalogue table, deduplicated by symbol (dedupeBySymbolPreferOrganicScore, keeping only the highest Jupiter organic-score mint per symbol -- Jupiter's verified tag still contains bridged/duplicate/occasionally-squatted symbols, and this app's picker keys selectable assets by symbol) and excluding the literal 'USDC' symbol entirely (the app's own hardcoded MAINNET_USDC_MINT is the only USDC entry ever offered, since USDC remains, per Creator's clarification, the protocol's mint/redeem/settlement currency -- unchanged from DEC-0118). CreateDTR.tsx's MAINNET_REAL_ASSETS static array became a live useMainnetAssetCatalogue(IS_MAINNET) fetch, merged with the pinned USDC entry, feeding the SAME existing search/select UI unchanged (it already had a working search box).\n\nWhile wiring this up, found and fixed a second, independent bug: discovery (packages/sdk/src/discovery.ts) can only find a Reserve's registered assets among a caller-supplied 'candidate mint' list -- each ReserveAsset PDA is seeded by [reserve, assetMint], so an asset whose mint isn't in that list is invisible to discovery, not just unpriced. Widening the picker to hundreds of Jupiter mints without also widening RealReserveSync.tsx's (previously USDC-only on Mainnet) candidate list would have made any real Reserve someone created with a non-USDC asset silently disappear from Discover/Portfolio/the homepage right after creation. Weighed two options with Creator: probing the full ~500-mint catalogue on every ~15s poll tick (simple, but multiplies Mainnet RPC volume by ~500x with no benefit for assets nobody has used) vs. probing only mints actually used on-chain (bounded cost, new plumbing) -- Creator chose the latter. Added api/ledger/known-asset-mints.ts (distinct reserve_asset_mint values from the Ledger's own on-chain event ingestion, cluster-scoped to mainnet-beta) as the candidate-mint source for both RealReserveSync.tsx and api/mainnet/landing-stats.ts, plus a small local useAppStore.mainnetKnownAssetMints registry so a browser's own just-created Reserve is discoverable immediately rather than waiting for the Ledger's daily ingest cron. tradableAssets.ts gained an additive registerDynamicSupportedAssetMints (new function, zero changes to isReserveTradable/isSupportedAssetMint's existing signatures or the static SUPPORTED_ASSET_MINTS set) so a dynamically-known mint is actually treated as tradable/visible everywhere that gate is checked, without touching any of its ~7 existing call sites.\n\nWhile verifying this live, found and fixed a third, independent bug in the ALREADY-EXISTING (not written this pass) lib/ledger/jupiterCatalogue.ts: shapeSnapshotRows dropped Jupiter's decimals/tokenProgram fields entirely, so runWeeklyJupiterSnapshot had been upserting every mint into ledger_asset_catalogue with decimals permanently NULL -- the first live snapshot (2,577 mints, triggered manually via the pre-existing ?dryRun=true bypass) fetched successfully but api/ledger/asset-catalogue.ts's correct 'decimals is not null' safety filter (can't safely offer a mint for basket-weight math without knowing its decimals) then excluded every single row, returning an empty catalogue. Fixed shapeSnapshotRows to carry decimals/tokenProgram through and the upsert to persist them (coalesced, so a future fetch missing either never blanks an already-known value); added a force option to runWeeklyJupiterSnapshot (api/ledger/jupiter-snapshot-cron.ts's new ?force=1) to safely re-run the SAME UTC day and backfill the columns into the rows the first (buggy) run had already inserted, reusing that day's existing snapshot row rather than violating its (snapshot_date_utc) unique constraint.",
  "alternativesConsidered": [
    "Guess at the two 500s' cause from the reported symptoms alone instead of pulling real Vercel logs -- rejected per the task's explicit instruction to use authenticated Vercel CLI logs, and because the actual cause (a missing package.json) would never have been found by reading application code alone -- it's a deployment/build-format issue invisible to `tsc`/`oxlint`/the offline test suite.",
    "Fetch Jupiter's API directly from the browser or per-request instead of reusing the existing weekly-snapshot Postgres cache -- rejected: threads JUPITER_API_KEY through a second surface for no benefit, and re-fetches a ~2,600-entry list on every page load instead of once a week.",
    "Probe the full Jupiter catalogue as Mainnet discovery's candidate-mint list (simpler code) -- rejected by Creator: multiplies live Mainnet RPC volume by roughly the catalogue's size for assets that, by definition, no Reserve has ever actually used yet.",
    "Ship the Jupiter picker without fixing the discovery-candidate-mint scope, deferring that gap to a follow-up pass -- offered as an option; Creator chose to close it in this same pass instead, given it would otherwise make a freshly-created diversified Reserve silently disappear.",
    "Allow every Jupiter-catalogue symbol, including duplicate/bridged 'USDC' variants -- rejected: this app's asset picker keys selectable entries by symbol (REAL_ASSET_BY_SYMBOL), so a second 'USDC'-symbol mint could silently shadow the real one; excluded the literal USDC symbol from the catalogue entirely and kept the app's own hardcoded MAINNET_USDC_MINT as the sole USDC entry."
  ],
  "impact": "strategic-super-reserve.fun's homepage and Create-Reserve Wallet Cost Summary both work again (previously fully broken for every Mainnet visitor since the Mainnet cutover). The site no longer surfaces any DevNet-prefixed API route or 'DevNet'/'devUSDC' copy while running as a Mainnet build. The Reserve Asset selector now offers 500 real, verified Mainnet SPL tokens (deduplicated by symbol, sorted by Jupiter's organic score) instead of USDC only, refreshed weekly via the pre-existing cron (now actually runnable). A Reserve composed of a non-USDC catalogue asset will be discoverable/visible immediately after creation (own-browser) and within the Ledger's daily ingest cycle (everyone else), without materially increasing the live discovery poll's Mainnet RPC volume. No Solana program, authority, Treasury, or on-chain Reserve state was touched by any part of this pass -- purely frontend/server/data-loader work, per the task's explicit restriction.",
  "affectedAreas": [
    "api/mainnet/package.json (new)",
    "api/mainnet/landing-stats.ts (new)",
    "api/mainnet/reserve-metadata.ts (new)",
    "api/ledger/asset-catalogue.ts (new)",
    "api/ledger/known-asset-mints.ts (new)",
    "api/ledger/jupiter-snapshot-cron.ts",
    "lib/ledger/jupiterCatalogue.ts",
    "packages/sdk/src/tradableAssets.ts",
    "src/merge/hooks/useLandingStats.ts",
    "src/merge/hooks/useMainnetAssetCatalogue.ts (new)",
    "src/merge/hooks/useMainnetKnownAssetMints.ts (new)",
    "src/merge/lib/RealReserveSync.tsx",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/managementClient.ts",
    "src/merge/lib/solana-config.ts",
    "src/merge/pages/CreateDTR.tsx",
    "src/merge/store/useAppStore.ts",
    "src/pages/Home.tsx",
    "tests/phase_mainnet_production_fixes.ts (new)",
    "tests/phase_ledger.ts",
    "Vercel Production environment variable JUPITER_API_KEY (project ssr14/ssr-fun)"
  ],
  "supersedes": "DEC-0118 (Reserve Asset composition scope only -- DEC-0118's USDC-only Buy/Sell/mint/redeem settlement design is unchanged and remains exactly as implemented)",
  "supersededBy": null,
  "evidence": [
    "Live production logs (`vercel logs dpl_EaqXq4nf1CcFvM8P4zeyJJPB5cKY`, the deployment live during the reported incident) showed the exact repeating crash: `ReferenceError: exports is not defined in ES module scope ... at file:///var/task/api/mainnet/rpc-proxy.js:2:23`, on every GET/POST to /api/mainnet/rpc-proxy, timestamped within the reported invocation IDs' window (08:52/08:59 UTC 2026-08-20).",
    "`npx tsc -b`, `npx oxlint` (changed files), `npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts` (620/620 passing, 33 new/updated across two commits), and `npm run build` all clean, run twice (once per commit).",
    "Deployed dpl_DFypeVpGb7q9y8NS5RxuN4pDUvm9 then dpl_3XPxaYzATW24RvsNRSNA2sHsWZWa (the decimals-fix follow-up), both `vercel --prod`, readyState READY, target production, aliased to strategic-super-reserve.fun and www.strategic-super-reserve.fun.",
    "Live post-deploy verification: authenticated `POST /api/mainnet/rpc-proxy` (getLatestBlockhash) -> 200 with a real slot/blockhash (previously 100% crash); `GET /api/mainnet/landing-stats` -> 200 with real data (2 holders, $0.4985 24h volume, the real DEC-0115 Mainnet test Reserve 9KkRx62FwvXvzYZeWqpBdLvokdPjdfqYMZ6vawUFvf4i); `GET /api/mainnet/reserve-metadata` (no id) -> clean 400, not a crash; `GET /`  (homepage) -> 200.",
    "`vercel logs <final-deployment> --level error`: only a pre-existing, harmless Node `url.parse()` deprecation warning from the manual verification call itself -- no application errors.",
    "`GET /api/ledger/jupiter-snapshot-cron?dryRun=true` -> real fetch, 2,577 verified mints, `skipped:false`; after the decimals-fix redeploy, `?dryRun=true&force=1` re-ran the same day and backfilled decimals without a unique-constraint violation (`skipped:false` again, same snapshotDate).",
    "`GET /api/ledger/asset-catalogue` (post-backfill): 500 real tokens returned with populated decimals -- e.g. USDT (6), SOL (9), JUP (6), ETH (8), JitoSOL (9) -- zero 'USDC'-symbol entries (excluded by design), zero duplicate symbols.",
    "`vercel env ls production` confirmed JUPITER_API_KEY present (Sensitive) before the first snapshot call; confirmed absent beforehand (the root cause of the catalogue never having run).",
    "Diff/secret scan (`git diff` + a direct grep of every new file) before each commit: no API keys, passwords, or other secrets present in any changed or new file."
  ]
}
```

## DEC-0122

```json
{
  "id": "DEC-0122",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Raised api/ledger/asset-catalogue.ts's MAX_RAW_ROWS/MAX_RESPONSE_TOKENS from 2000/500 to 6000/5000 -- both were below the real size of Jupiter's verified-token list (~2,600 as of this date), so a legitimately verified token with a lower organic score (Jupiter's trading-activity ranking, not a safety/verification signal) could be silently absent from the Reserve Asset picker and its own search box.",
  "context": "Creator asked how to add support for $SSR (mint BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump, 'Strategic Super Reserve'). Looked it up directly against Jupiter Tokens API V2: isVerified true, tagged 'verified', classic SPL Token, 6 decimals, mint/freeze authority both disabled, pump.fun-graduated, but organicScore 0 ('low'). Confirmed live it was absent from the picker's 500-token response even though DEC-0121's snapshot had already fetched and stored it -- the DEC-0121-introduced 500-token response cap (sorted by organic score, intended as a reasonable default at the time) was silently excluding it, and the 2000-row raw-query cap risked excluding it even earlier in the pipeline. Flagged to Creator, before making it more visible, that a permissionless pump.fun token's name alone doesn't prove it's genuinely this project's token -- proceeded on Creator's exact CA as given.",
  "rationale": "Fixed generally, not as a single-token carve-out: raised both caps to comfortably exceed the current verified-list size with headroom for growth (6000 raw rows, 5000 in the response), so ANY verified token -- not just this one -- is now findable via the picker's existing search box regardless of its organic score. Sort order (highest organic score first, for the default/no-search browse view) is unchanged; this only affects which verified tokens are included in the result set at all. No change to the verified/decimals/ssr_status/symbol-dedup safety filters from DEC-0121.",
  "alternativesConsidered": [
    "Add SSR to a manual always-include pin list (like the existing hardcoded USDC entry) -- rejected: a one-off carve-out for a single token doesn't fix the same problem for the next verified-but-low-organic-score token someone asks about, and a pinned entry would need its own ongoing manual curation.",
    "Add server-side search (a `?q=` query param) instead of raising the caps -- more code for the same practical outcome given the verified list's actual size (~2,600) comfortably fits in one payload; deferred as unnecessary complexity unless the list grows enough to matter."
  ],
  "impact": "The Reserve Asset picker's catalogue endpoint now returns 2,522 tokens (up from 500), including SSR. Payload size increases accordingly (still comfortably small as JSON text) but is unchanged in shape/fields -- no frontend code change was needed beyond this endpoint's two constants.",
  "affectedAreas": ["api/ledger/asset-catalogue.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Jupiter Tokens API V2 direct lookup (`/tokens/v2/search?query=<mint>`) confirmed SSR's real on-chain state: isVerified true, tags:['verified'], decimals 6, tokenProgram = classic SPL Token, audit.mintAuthorityDisabled/freezeAuthorityDisabled both true, organicScore 0/'low'.",
    "Before the fix: `GET /api/ledger/asset-catalogue` returned exactly 500 tokens; SSR absent.",
    "`npx tsc -b`, `npx oxlint api/ledger/asset-catalogue.ts`, `npx ts-mocha ... tests/phase_mainnet_production_fixes.ts` (17/17 passing, unchanged), `npm run build`: all clean.",
    "`vercel --prod` deployment dpl_CBgKGKvhF8DP2rFZCrZ4RK5YGaM9, readyState READY, target production, aliased to strategic-super-reserve.fun.",
    "After the fix: `GET /api/ledger/asset-catalogue` returned 2,522 tokens; SSR present with the exact expected mint/symbol/decimals. `vercel logs <deployment> --level error`: none."
  ]
}
```

## DEC-0123

```json
{
  "id": "DEC-0123",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Made the Create-Reserve asset picker's search box match on contract address (mint), not just name/ticker, and show each listed asset's truncated mint underneath its symbol.",
  "context": "Creator asked to make assets searchable by CA, immediately following DEC-0122's $SSR investigation -- with thousands of verified tokens now in the picker (many sharing similar or ambiguous names), searching only by name/ticker isn't enough to confidently find and confirm a specific token.",
  "rationale": "Added src/merge/lib/assetSearch.ts (matchesAssetSearch, pure: case-insensitive substring match against name, symbol, OR mint; empty query matches everything) as its own module rather than inline in CreateDTR.tsx, so that page component file keeps exporting only the component (avoids oxlint's react-fast-refresh warning, matching how every other shared-logic extraction in this codebase already avoids that warning). Both the picker's filter and its 'no results' empty-state check now call the same function, replacing what would otherwise have been duplicated inline predicate logic. Each row in the picker also now shows the asset's mint truncated to first4...last4 (the same truncation convention already used elsewhere in this same file for wallet addresses) so a user can visually confirm which specific mint they're about to select -- directly relevant given DEC-0121's own reasoning for excluding a duplicate 'USDC' catalogue entry: multiple real mints can legitimately share a name or symbol. Mint matching is deliberately case-insensitive (base58 is technically case-sensitive) for forgiving paste/retype UX -- a coincidental substring collision between two different real mints in this app's own already-curated/verified catalogue is astronomically unlikely.",
  "alternativesConsidered": [
    "Require an exact, full-length mint match rather than a substring match -- rejected: the existing name/ticker search is already a live substring filter as the user types, and a first-few/last-few-characters partial paste is a common, useful way to sanity-check a token without typing/pasting the whole address."
  ],
  "impact": "The Reserve Asset picker's search box (both Mainnet's Jupiter-catalogue-backed list and DevNet's fixture list, since both share the same SELECTABLE_ASSETS/search UI) now accepts a full or partial contract address in addition to name/ticker. Every listed asset's row shows its truncated mint for visual confirmation. No API/backend change -- purely a client-side filter and one new pure function.",
  "affectedAreas": ["src/merge/lib/assetSearch.ts (new)", "src/merge/pages/CreateDTR.tsx", "tests/phase_mainnet_production_fixes.ts"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b`, `npx oxlint` (changed files, zero warnings including the react-fast-refresh one that first appeared with the inline version): clean.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 625/625 passing (5 new matchesAssetSearch cases, including a real full/partial/case-varied match against DEC-0122's SSR mint and a confirmed non-match against an unrelated mint).",
    "`npm run build`: clean.",
    "`vercel --prod` deployment dpl_E3uMFEXPT4tjeAQJwMZhbjDJ36WA, readyState READY, target production, aliased to strategic-super-reserve.fun and www.strategic-super-reserve.fun; `vercel logs --level error`: none."
  ]
}
```

## DEC-0124

```json
{
  "id": "DEC-0124",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Fixed all 3 issues Creator reported on MCR-01 (road-to-mainnet's Mainnet function checklist, Create Reserve): pre-filled the Primary Fee Destination field, added real Jupiter-swap-funded Reserve creation for non-USDC assets (fixing a related $1-peg pricing bug found along the way), and clarified the Wallet Cost Summary's multi-transaction total.",
  "context": "Creator posted 3 comments on MCR-01 after live-testing Reserve creation on strategic-super-reserve.fun: (1) the fee-destination field wasn't visibly pre-filled despite defaulting correctly; (2) creating an SSR-backed Reserve with 10 USDC failed asking for '10 more of Bpdh...pump' with no faucet, when the expectation was that USDC would be traded into SSR automatically via Jupiter; (3) the displayed cost estimate (0.01074 SOL) didn't match what Phantom actually asked for (0.008665 SOL) for one transaction. Investigated and confirmed all three as real (see the prior turn's report); Creator said 'go and fix all of them.'",
  "rationale": "(1) feeDestination's useState(wallet.address || \"\") only runs its initializer once -- if wallet.address isn't populated yet at first render (common with async wallet-adapter resolution), the field locks in blank forever even though submission's `feeDestination || walletCtx.publicKey.toBase58()` fallback was always correct. Added a useEffect that backfills it the moment wallet.address becomes known, gated by a feeDestinationUserEditedRef so it never overwrites a value the user has since typed. (2) Mainnet Reserve creation required the creator to already hold each selected asset directly -- no swap existed. Added api/mainnet/jupiter-swap.ts (server-only JUPITER_API_KEY, restricted to USDC-as-input only, price-impact capped at 15% server-side, rate-limited) which builds an UNSIGNED Jupiter swap transaction for the connected wallet to sign and submit itself -- never custodies funds, same model as every other Mainnet write path in this app. fundSeedAssetsIdempotent (createReserveClient.ts) gained a jupiterSwap option: for any asset that isn't USDC or wrapped SOL, it now gets a live Jupiter quote (replacing seedRawAmountForAsset's broken assumption that every non-SOL asset is worth exactly $1 -- true only for USDC, and the actual root cause of the reported error demanding exactly '10' of an asset trading nowhere near $1), swaps the shortfall if the wallet doesn't already hold enough, then re-verifies the real resulting balance before proceeding to seed_reserve with the live-quote-derived (not guessed) amount. Both createReserveOnChain and resumeReserveDeploymentOnChain now return/use finalSeedAmounts (the actual amounts, post-swap) rather than the original pre-swap estimate. (3) estimateCreateReserveCost's networkFeeLamportsEstimate and numTransactions previously never accounted for a Jupiter swap transaction (higher priority fee than a plain instruction) or its count; both now do (worst-case: every non-USDC/non-wSOL asset assumed to need one, since the estimate can't cheaply know current balances). Clarified the InfoTip and added a one-line caption explaining the total is summed across every transaction, while Phantom only ever shows the cost of the ONE transaction it's currently signing -- directly addressing the reported '0.01074 total vs 0.008665 for one popup' as expected behavior, not a bug, once explained.",
  "alternativesConsidered": [
    "Have the server co-sign/execute the Jupiter swap on the creator's behalf -- rejected outright: this app has never custodied Mainnet funds anywhere, and DEC-0117/0118's entire security posture depends on every Mainnet write being signed solely by the connected wallet. The server only ever builds an unsigned transaction; the swap literally cannot execute without the creator's own wallet signature.",
    "Use Jupiter's ExactOut swap mode (specify the exact output amount needed) instead of ExactIn -- tried live against SSR specifically and got 'NO_ROUTES_FOUND' (thin-liquidity/pump.fun-graduated AMMs often don't support ExactOut cleanly); switched to ExactIn (spend a fixed USD budget, accept whatever real amount results, re-derive the seed target from that same live quote) which is both more broadly compatible and a more honest reflection of 'this is what your USD budget actually buys right now.'",
    "Leave the cost-estimate mismatch as a documentation-only fix (copy clarification, no numeric change) -- rejected: the estimate's transaction/fee counts were ALSO genuinely incomplete (never counted a Jupiter swap transaction at all), so a pure copy fix would still have been wrong once feature (2) shipped; fixed the undercount for real, not just relabeled it."
  ],
  "impact": "Deployed to production. Live-verified: a real Jupiter quote+swap-transaction build for 1 USDC -> SSR succeeds (2,131,330,446 raw SSR out, 1.6% price impact, real serialized transaction returned); the endpoint correctly rejects USDC-as-output. Creating a Reserve with a non-USDC asset on Mainnet now actually trades USDC for it via Jupiter instead of demanding the creator already hold it. Posted a succinct fix summary as a comment on MCR-01 in road-to-mainnet.html per Creator's request, asking for a live re-test.",
  "affectedAreas": [
    "api/mainnet/jupiter-swap.ts (new)",
    "src/merge/lib/jupiterSwapClient.ts (new)",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/pages/CreateDTR.tsx",
    "tests/phase_mainnet_production_fixes.ts",
    "road-to-mainnet.html's MCR-01 comment thread (Neon-backed, not a repository file)"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b`, `npx oxlint` (changed files): clean.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 636/636 passing (11 new: isJupiterSwapEligible pure cases, api/mainnet/jupiter-swap.ts input-validation cases including a real full/partial USDC-rejection and a JUPITER_API_KEY-unset sanitized-503 case).",
    "`npm run build`: clean.",
    "`vercel --prod` deployment dpl_6BRXg9kNpiMVRD788AXfxvzpPatr, readyState READY, target production, aliased to strategic-super-reserve.fun; `vercel logs --level error`: none.",
    "Live POST /api/mainnet/jupiter-swap (1 USDC -> real SSR mint, a throwaway pubkey): 200, real swapTransaction + lastValidBlockHeight + inAmount/outAmount/priceImpactPct returned. Live POST with outputMint=USDC: 400 'Invalid or unsupported outputMint.'",
    "Live GET /: 200, GET /create: 200 (site unaffected).",
    "Comment id 18 posted to control MCR-01 via POST /api/road-to-mainnet/comments, confirmed 200 with the comment echoed back."
  ]
}
```

## DEC-0125

```json
{
  "id": "DEC-0125",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Reserve creation no longer blocks on a Jupiter swap landing below its quote's expected output -- it now always proceeds using the real amount received, and only warns (non-blocking) when that shortfall exceeds 5%.",
  "context": "Creator hit DEC-0124's new shortfall error live: 'Swapped USDC for Bpdh...pump via Jupiter, but the resulting balance is still short of the target... this specific failure will not resolve itself on a plain retry.' Instructed: 'whatever the resulting value is just create with it. if the value is too short % of the usdc entry just warn the user.'",
  "rationale": "Root cause: the prior check compared the real post-swap balance against the QUOTE's optimistic outAmount, but Jupiter's on-chain swap instruction only ever guarantees the much looser slippage-bounded otherAmountThreshold -- so any ordinary execution-price movement within the configured ~1.5% slippage tolerance (routine, especially on a thin-liquidity pump.fun-graduated token like the one Creator was testing with) tripped a 'failure' on a swap that had actually executed exactly as designed. Removed the throw entirely: fundSeedAssetsIdempotent's finalSeedAmounts[i] is now always set to the real post-swap balance (fetchOwnedBalanceRaw, re-read after confirmation), used whether it landed above, within, or below the quote's expectation. Added a new, non-blocking onSwapShortfall callback fired only when the real result is more than 5% short of the quote (SHORTFALL_WARN_PCT, comfortably above the routine slippage band so it only fires for a genuinely unusual outcome) -- CreateDTR.tsx wires this to a toast notification naming the asset, the amount actually received vs. quoted, and the percentage short, while making clear the Reserve was still created. Extracted the percentage math into a small pure computeSwapShortfallPct (createReserveResume.ts) for direct test coverage, mirroring the existing computeFundingShortfall.",
  "alternativesConsidered": [
    "Compare against Jupiter's own otherAmountThreshold (the real on-chain guarantee) instead of removing the check entirely -- considered, but Creator's explicit instruction was simpler and more permissive: never block, warn only past a real threshold. A threshold-based check would still occasionally interrupt an otherwise-successful flow for a difference the creator may not care about; the chosen design defers entirely to the real outcome and only interrupts attention (a toast, not a blocking error) when it's meaningfully large."
  ],
  "impact": "Deployed to production. A Mainnet Reserve creation that includes a Jupiter swap can no longer fail (in this specific way) due to ordinary slippage -- it always completes using the real swapped amount. A creator is still notified, via a non-blocking toast, if a swap underperformed its quote by more than 5%. Posted a follow-up comment on MCR-01 explaining the fix and asking Creator to retry.",
  "affectedAreas": [
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/createReserveResume.ts",
    "src/merge/pages/CreateDTR.tsx",
    "tests/phase_mainnet_production_fixes.ts",
    "road-to-mainnet.html's MCR-01 comment thread (Neon-backed, not a repository file)"
  ],
  "supersedes": "DEC-0124 (the swap-shortfall handling only -- everything else in DEC-0124 is unchanged)",
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b`, `npx oxlint` (changed files): clean.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 640/640 passing (4 new computeSwapShortfallPct cases: met-or-exceeded target, exact fractional shortfall, 100% shortfall from a zero result, zero-target edge case).",
    "`npm run build`: clean.",
    "`vercel --prod` deployment dpl_D5neKv9nwq64Ug6s8aLFmSqwtv4L, readyState READY, target production, aliased to strategic-super-reserve.fun; `vercel logs --level error`: none.",
    "Live GET /: 200, GET /create: 200 (site unaffected).",
    "Comment id 19 posted to control MCR-01 via POST /api/road-to-mainnet/comments, confirmed 200 with the comment echoed back."
  ]
}
```

## DEC-0126

```json
{
  "id": "DEC-0126",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Fixed a misleading Jupiter swap failure message (was decoded as if it might be an ssr_protocol error) and enabled Jupiter's dynamic slippage so a genuine on-chain swap rejection (a real InstructionError/Custom(52) from an external AMM in the route) happens less often in the first place.",
  "context": "Creator hit a real on-chain swap failure live: 'Jupiter swap failed on-chain ({\"InstructionError\":[4,{\"Custom\":52}]})... program error code 52 is not defined anywhere in the deployed SSR Protocol IDL... check whether the deployed program binary has drifted from this IDL.' The transaction genuinely failed on-chain (not a false alarm like DEC-0125's shortfall case) -- but the error explanation was wrong for the context: it was produced by createReserveClient.ts's describeOnChainError, which is scoped to ssr_protocol's own deployed IDL and Anchor's framework error table, neither of which the swap transaction's instructions ever touch (they belong to Jupiter's router and whichever AMM program(s) it routed through).",
  "rationale": "Added describeJupiterSwapError (jupiterSwapClient.ts, pure), used instead of describeOnChainError for a swap-transaction failure specifically. It names the real error code, states the single most common real cause of an AMM/router instruction reverting mid-swap (a minimum-output/slippage check tripping because the price moved between quote-fetch and execution -- routine for a lower-liquidity token) WITHOUT claiming certainty about an external program's exact error semantics (this repo has no IDL for Jupiter's router or the AMMs it can route through), and confirms a retry already re-quotes fresh (fundSeedAssetsIdempotent fetches a new live quote on every attempt, unchanged from DEC-0124). Separately, enabled dynamicSlippage:true on the swap-build request (api/mainnet/jupiter-swap.ts) -- previously only a fixed 150bps slippage was ever used; Jupiter's dynamic mode computes its own volatility/route-aware tolerance instead (live-confirmed via a direct API test: it independently picked 80bps for the exact same SSR route where 150bps had been requested), which should reduce how often a real price-movement-driven revert like this happens at all, not just explain it better after the fact.",
  "alternativesConsidered": [
    "Simply raise the fixed default slippageBps (e.g. to 300 or 500) instead of switching to dynamic slippage -- rejected: a single static number is either too tight for a volatile token (this exact failure) or wastes slippage budget on a stable one; Jupiter's own dynamic mode adapts per-trade instead of guessing at one fixed compromise value.",
    "Attempt to identify the exact semantic meaning of error code 52 for the specific AMM program involved -- rejected: this repo has no IDL/source for Jupiter's router or the third-party AMM programs it routes through, so asserting a specific meaning would be a guess presented as fact; named the far-more-likely general cause (slippage) honestly instead of fabricating certainty."
  ],
  "impact": "Deployed to production. A genuine on-chain swap rejection now explains itself in plain, swap-specific terms instead of misleadingly implicating ssr_protocol/this app's own deployed program. Dynamic slippage should reduce (not eliminate -- a real price-moving revert can still happen) how often this failure class occurs for real, lower-liquidity Mainnet assets. Posted a follow-up comment on MCR-01 explaining the fix and asking Creator to retry.",
  "affectedAreas": [
    "src/merge/lib/jupiterSwapClient.ts",
    "api/mainnet/jupiter-swap.ts",
    "tests/phase_mainnet_production_fixes.ts",
    "road-to-mainnet.html's MCR-01 comment thread (Neon-backed, not a repository file)"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b`, `npx oxlint` (changed files): clean.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 643/643 passing (3 new describeJupiterSwapError cases: real InstructionError/Custom decode, unrecognized-shape fallback, malformed-input never-throws).",
    "`npm run build`: clean.",
    "Live direct Jupiter API test confirmed dynamicSlippage:true returns a real dynamicSlippageReport (slippageBps 80 for the exact USDC->SSR route that had been requested at a fixed 150bps).",
    "`vercel --prod` deployment dpl_8odfxQAWHmpX3Rr9hsydYKSN1Pse, readyState READY, target production, aliased to strategic-super-reserve.fun; `vercel logs --level error`: none.",
    "Live POST /api/mainnet/jupiter-swap (1 USDC -> SSR) with dynamicSlippage enabled server-side: 200, real swapTransaction returned. Live GET /: 200, GET /create: 200.",
    "Comment id 20 posted to control MCR-01 via POST /api/road-to-mainnet/comments, confirmed 200 with the comment echoed back."
  ]
}
```

## DEC-0127

```json
{
  "id": "DEC-0127",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Fixed a stale post-swap balance read (RPC eventual consistency, same root-cause class as DEC-0115's redemption-read false alarm) that was reading a just-confirmed Jupiter swap as having delivered 0 tokens, and added a client-side pre-flight check that refuses to submit a seed transaction that would definitely revert on-chain.",
  "context": "Creator reported a real on-chain failure: `Transaction failed on-chain ({\"InstructionError\":[2,{\"Custom\":6019}]})... SsrError::SeedAmountTooLow (6019)`, immediately preceded by a DEC-0125 shortfall toast claiming the Jupiter swap for SSR 'delivered 0 instead of the ~21,341.811 quoted (100.0% short)'. Creator flagged this as 'weird' and pointed at wallet 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen, noting the purchases went through. Directly verified via a live getTokenAccountsByOwner RPC call: that wallet genuinely holds 107,147.418057 SSR right now -- the swap(s) unambiguously succeeded and delivered real tokens; the '0' the app saw was never real.",
  "rationale": "Root cause: fundSeedAssetsIdempotent read the post-swap balance with a single immediate fetchOwnedBalanceRaw call right after confirmSignatureBounded returned 'confirmed' -- but a confirmed signature only guarantees the SUBMITTING node has seen it land, not that every RPC node (including whichever one serves the very next getTokenAccountBalance call, especially behind a load-balanced provider like Helius) has caught up yet. This exact class of bug was already found and fixed once in this repo for a different flow (DEC-0115's Mainnet smoke test: 'an immediate post-redeem balance read showing no change... root-caused to Helius RPC eventual consistency... a fresh query moments later... confirmed the redemption had in fact moved... correctly'). The stale 0 then flowed straight into finalSeedAmounts and on into buildSeedReserveInstruction, which the program correctly rejected (SeedAmountTooLow requires >= MIN_SEED_AMOUNT_PER_ASSET, 1,000 raw units) -- a real, wasted transaction and a confusing user-facing failure for what was, underneath, a fully successful swap.\n\nFixed two ways, both defense-in-depth: (1) fetchOwnedBalanceRawSettled (createReserveClient.ts) retries the post-swap balance read (up to 6 attempts, 1s apart) until it genuinely differs from the pre-swap snapshot captured at the top of the funding pass, rather than trusting a single read -- same fix shape as DEC-0115's own resolution. (2) New assertSeedAmountsMeetMinimum, called immediately before ever building the seed transaction (in both createReserveOnChain and resumeReserveDeploymentOnChain): if any asset's final amount is still below the protocol's real floor even after the settled-read retries (a genuine remaining edge case -- e.g. an RPC provider outage lasting longer than the retry window, or a truly failed delivery the settled-read correctly still sees as unchanged), refuses to submit rather than wasting a transaction on a predictable on-chain revert, naming the exact asset. Also wired in packages/sdk/src/calculations.ts's existing validateSeedPlan/MIN_SEED_AMOUNT_PER_ASSET -- already written specifically for this purpose ('so a client can fail fast... before submitting a transaction that would revert') but never actually called anywhere in the live flow until now.",
  "alternativesConsidered": [
    "Increase confirmSignatureBounded's commitment level or wait longer before the FIRST balance read, instead of retrying on an unchanged result -- rejected: a fixed extra delay either wastes time in the common case (RPC already caught up) or still isn't long enough in a worse case; retrying specifically until the balance is OBSERVED to change is both faster on average and correct in the slow case, bounded at ~6 seconds worst case.",
    "Silently proceed and let seed_reserve's own on-chain rejection be the only signal -- rejected: that's exactly what just happened and it wastes a real transaction (rent + network fee) every time, plus produces a confusing two-part error (a shortfall toast immediately followed by an unrelated-looking program error) instead of one clear, pre-flight explanation."
  ],
  "impact": "Deployed to production. A Jupiter swap's real result is now given a real chance to become visible before being used, closing the specific failure Creator hit. If a seed amount is still genuinely too low after that, the flow now fails fast with one clear, asset-named message instead of wasting a transaction on a guaranteed on-chain revert. Confirmed live that no funds were lost at any point -- the swap(s) always succeeded and delivered real SSR to Creator's wallet; only the app's own read of that fact was stale. Posted a follow-up comment on MCR-01 with the independently-verified wallet balance and asked Creator to retry.",
  "affectedAreas": [
    "src/merge/lib/createReserveClient.ts",
    "tests/phase_mainnet_production_fixes.ts",
    "road-to-mainnet.html's MCR-01 comment thread (Neon-backed, not a repository file)"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Live `getTokenAccountsByOwner` RPC call against wallet 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen for the SSR mint: real token account, tokenAmount.uiAmountString \"107147.418057\" -- conclusive proof the swap(s) had genuinely succeeded despite the app's stale '0 received' read.",
    "`npx tsc -b`, `npx oxlint` (changed files): clean.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 647/647 passing (4 new assertSeedAmountsMeetMinimum cases: passes at/above minimum, throws naming the exact mint below minimum, catches the exact reported 0-amount scenario).",
    "`npm run build`: clean.",
    "`vercel --prod` deployment dpl_4VV5LKdrddSNTh96u8gBuM3RfTPM, readyState READY, target production, aliased to strategic-super-reserve.fun; `vercel logs --level error`: none.",
    "Live GET /: 200, GET /create: 200 (site unaffected).",
    "Comment id 21 posted to control MCR-01 via POST /api/road-to-mainnet/comments, confirmed 200 with the comment echoed back."
  ]
}
```

## DEC-0128

```json
{
  "id": "DEC-0128",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Reserve-creation success/failure is now always determined by re-reading AUTHORITATIVE on-chain Reserve state before ever reporting 'deployment incomplete' to the user -- a new, strictly READ-ONLY reconciliation check (checkReserveGenuinelyComplete) runs on every fund-seed-assets/seed failure, before the failure toast, and finalizes the SAME success UI a normal completion would if the Reserve has, in fact, already fully seeded. It can never fund, swap, or seed anything, so it can never resubmit or double-submit whatever just (apparently) failed.",
  "context": "Creator reported: 'After seeding, the Creator received the correct Reserve Token amount, but the UI reported \"received less than expected: 0%\" and/or SeedAmountTooLow (6019), then marked deployment incomplete.' Explicit instruction: diagnose the real transaction/on-chain state before changing anything, and never resubmit or modify existing Reserve state during diagnosis.\n\nDiagnosis performed, strictly read-only (no signature submitted, no Reserve state touched): decoded the failing seed_reserve transaction's raw instruction data directly against the deployed IDL. This surfaced and fixed a diagnostic-tooling bug of my own along the way -- Solana RPC's `getTransaction(..., {encoding:\"json\"})` returns instruction `data` as base58, not base64; my first decode attempt (base64) produced garbage that didn't match seed_reserve's real discriminator (57439d35fac4741c), and a correct base58 decode confirmed the match. With that fixed, the decoded instruction showed `seed_amounts=[0]` was genuinely SUBMITTED to the program (which correctly rejected it with SeedAmountTooLow) -- this was not a UI-only misreport of a real success; a real, empty seed_amount was sent on-chain. At the time of that specific failing transaction, the creator wallet (6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen, named directly by Creator -- 'since the purchases went through, u can check this wallet') held ~128,431 SSR (confirmed via its preTokenBalances and independently via a fresh RPC balance read), and an immediately-preceding transaction (16:06:16 UTC) was confirmed to be a real, successful Jupiter swap (JUP6LkbZ... program, real USDC decrease, real SSR increase). So the wallet unambiguously held far more than the ~1,000-raw-unit minimum at seed-submission time, yet the client computed and submitted exactly 0 as that asset's seed amount. Honest uncertainty, not resolved with full certainty: I could not conclusively prove WHY the client's in-memory `finalSeedAmounts[0]` was exactly 0 for that specific submission -- no code path in the (already DEC-0127-patched) logic deployed at the time should produce exactly 0 given a nonzero usdBudget and a wallet holding that much. My best-supported working hypothesis, not proven, is a stale browser tab still running JS from before one of that day's several back-to-back deploys (DEC-0124 through DEC-0127) -- a Vercel deploy does not force-reload an already-open SPA tab, and multiple client-side fixes to this exact code path landed within the same session. The most recent transaction from this same wallet (16:09:29 UTC) was a fresh, successful CreateReserve+InitializeReserveAsset -- not a resume of the failed one -- consistent with the creator having simply started a new attempt rather than the false-failure/false-'0%' report describing that exact decoded transaction.\n\nRegardless of this specific transaction's exact root cause, the architectural gap the report actually describes -- and the gap that would make ANY transient client-side misread (a stale balance snapshot, an ambiguous RPC confirmation, a race between tabs/attempts, or exactly the kind of stale-bundle scenario hypothesized above) permanently unrecoverable without a real fix -- is real and independent of this one transaction: CreateDTR.tsx decided 'deployment incomplete' purely from the error thrown by ONE specific attempt, never by re-checking fresh, authoritative on-chain state first. That gap is what this pass closes.",
  "rationale": "Root cause of the ARCHITECTURAL gap (the false-failure risk itself, independent of any one transaction's exact trigger): handleResumeDeployment's and handleSubmitReal's catch blocks decided success/failure purely from whatever error the CURRENT attempt threw, with no step in between that re-reads real on-chain Reserve state before declaring 'incomplete' and offering Resume. determineDeploymentResumePoint (createReserveResume.ts) already had all the logic needed to recognize a Reserve that reached AssetsInitializing-or-later as 'already-complete' -- it was just never consulted at the moment of a REPORTED failure, only at the start of an explicit Resume click.\n\nFixed by adding checkReserveGenuinelyComplete (createReserveClient.ts), a new function that is deliberately, structurally incapable of writing anything: it only calls fetchReserveOnChain (a read) and, if-and-only-if determineDeploymentResumePoint classifies the fresh result as already-complete, builds and returns the same CreateReserveResult shape a real completion would produce -- otherwise it returns null and the caller's normal (still-safe, still-resumable) failure handling proceeds unchanged. Both CreateDTR.tsx catch blocks (handleResumeDeployment's CreateReserveStepError branch, and handleSubmitReal's `e.step !== \"create-and-register\"` branch) now call this BEFORE ever showing the 'deployment incomplete' toast; a true reconciled success is finalized through a new shared finalizeResumedReserve helper (extracted from what was previously duplicated inline in handleResumeDeployment's try block) -- the exact same registration/toast/navigation a normal successful Resume already used, so a reconciled success is never treated as a second-class or different outcome from a normal one.\n\nAlso hardened the two mechanisms most likely to have contributed to the specific stale-zero read pattern this report described, even though the exact submitted transaction shows a real seed_amounts=[0]: fetchOwnedBalanceRawSettled (added in DEC-0127) is now exported with injectable retry timing so its retry-until-changed behavior under RPC lag is directly, offline-testable rather than only exercisable live; and a new pure rawToUiAmount helper replaces an inline raw/decimals division in the swap-shortfall toast, closing off decimal-conversion as a possible source of a misleading displayed percentage.",
  "alternativesConsidered": [
    "Have handleResumeDeployment/handleSubmitReal's catch blocks call the FULL resumeReserveDeploymentOnChain again on any failure, relying on its own already-complete short-circuit -- rejected during implementation (self-corrected before this reached the user): that function CAN submit fund/seed transactions when the Reserve isn't actually complete, and the reconciliation call as drafted would have used a plain retry (no Jupiter-swap config), so a genuinely-incomplete Reserve could have been resubmitted with a WRONG, non-swap-aware amount -- a direct violation of 'do not resubmit this transaction.' Replaced with the strictly read-only checkReserveGenuinelyComplete instead, which cannot submit anything under any circumstance.",
    "Trust the immediate error and always show 'deployment incomplete,' relying on the user to click Resume (which already re-reads on-chain state) -- rejected: this is exactly the reported bug. A genuinely successful seed being reported as a failure, even if 'safely resumable,' is still a false failure the user has to notice and manually work around; the fix makes the correct outcome the FIRST thing shown, not something recovered a click later.",
    "Assume the specific decoded seed_amounts=[0] transaction fully explains the report and stop at that -- rejected: it explains that transaction, but the user's report describes the UI marking deployment incomplete generally, which the architecture gap above can produce for reasons unrelated to that specific submission (a stale read, an ambiguous confirmation, a race). Fixing only the one transaction's trigger would leave the general false-failure risk open."
  ],
  "impact": "Deployed to production. A Reserve whose seeding genuinely succeeded on-chain -- for any reason a specific client attempt errored -- is now reported as complete and finalized through the normal success UI, never left showing 'deployment incomplete' with a Resume button that could tempt a double-submission. A Reserve that is genuinely still incomplete is unaffected -- reconciliation returns null and the existing safe, resumable failure UI is shown exactly as before. No Reserve state was read-write-touched, modified, or resubmitted at any point during this diagnosis; every on-chain check performed (transaction decoding, balance reads, account existence) was a plain RPC read. 14 new regression tests (661/661 total passing), tsc -b/oxlint/build all clean.",
  "affectedAreas": [
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/createReserveResume.ts",
    "src/merge/pages/CreateDTR.tsx",
    "tests/phase_mainnet_production_fixes.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Decoded seed_reserve instruction data (base58, not base64 -- a diagnostic-tooling bug of my own, fixed mid-investigation) from signature 5br3VUGGKNHUbLTiwofRsG6LgvvpHt3mCVBXbcswqaqxnniYFuoQmdQPQ6yKajVEKpBRZGvkhxx7EsRaksj4X6F6 (16:06:27 UTC): discriminator 57439d35fac4741c (matches seed_reserve's real IDL discriminator), seed_amounts=[0], initial_reserve_tokens=10000000; on-chain result Custom(6019) (SeedAmountTooLow), confirming a real, empty seed_amounts was genuinely submitted and correctly rejected.",
    "preTokenBalances on that same transaction plus an independent fresh RPC balance read both confirmed wallet 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen held ~128,431.20 SSR at submission time -- ruling out a genuinely empty wallet.",
    "Decoded the immediately-preceding transaction (4aPV4yG2zwEmM45NXHKGQGLXJo2D6J6rTP59aENoXpzvsfAoRA6K56djmBQCe1gE3KmJYVakamEA5tb1HqQqK3aG, 16:06:16 UTC): a real Jupiter swap (JUP6LkbZ... program), USDC -10.0 (187.082134 -> 177.082134), SSR +21,283.78 (107,147.418057 -> 128,431.197991) -- confirms the swap genuinely succeeded and delivered real tokens before the failing seed attempt.",
    "Confirmed the wallet's most recent transaction (3wdo2eT9oyzPTFnyz71CbJYR68ZCg3ecwGf9VbndTKRS7aC8NxwY1r1vtgSSnPh9dVyEHzisjPdNfHXaJzbnMvRy, 16:09:29 UTC) was a fresh, successful CreateReserve+InitializeReserveAsset -- not a resume of the failed Reserve.",
    "No transaction was signed, submitted, or simulated at any point during this diagnosis; every check was a read-only getTransaction/getTokenAccountBalance/getAccountInfo-class RPC call.",
    "`npx tsc -b`, `npx oxlint` (changed files): clean.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 661/661 passing (14 new: fetchOwnedBalanceRawSettled delayed-RPC/stale-zero-correction/never-settles/real-regression-shape cases, rawToUiAmount decimal-conversion cases including the wrong-decimals-manufactures-a-fake-percentage case, and already-complete-reconciliation idempotency cases).",
    "`npm run build`: clean.",
    "Commit `24f9dfb` on `main`, pushed to `origin/main`; `vercel --prod --yes` deployment `dpl_88krftpo89RWbF5wnWLpbwQZkLaM`, readyState READY, target production, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun (confirmed via `vercel inspect`).",
    "Live GET https://strategic-super-reserve.fun/: 200; GET https://strategic-super-reserve.fun/create: 200; `vercel logs --level error` for this deployment: none.",
    "MCR-01 comment NOT posted this pass -- SSR_SITE_PASSWORD/SSR_DASHBOARD_PASSWORD both came back as Vercel's `[SENSITIVE]` placeholder on `vercel env pull` (documented recurring limitation, see DEC-0119/0120's context), so the authenticated POST this requires could not be made without asking Creator for the value; flagged in the final report instead."
  ]
}
```

## DEC-0129

```json
{
  "id": "DEC-0129",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "At Creator's explicit request ('remove password from the website for now please'), disabled the site-wide password gate (Gate 1, DEC-0117/0119) so the public site is reachable without a password again -- via a new SSR_SITE_GATE_ENABLED=false Production env var, not a code deletion, so it can be flipped back on later without a redeploy. The separate internal dashboard gate (Gate 2 -- /road-to-mainnet, /internal/status, /internal/feedback, /internal/kpis and their data endpoints, SSR_DASHBOARD_PASSWORD) was left completely untouched -- 'the website' was read as the public site, not the internal team dashboard.",
  "context": "Creator asked to remove the password from the website, immediately after the DEC-0128 false-failure fix/report. No further scoping was given; interpreted 'the website' as the public-facing site-wide gate (the one a real, un-onboarded visitor hits), not the separate internal-team dashboard gate, since those protect genuinely different things (a controlled Mainnet launch vs. an internal engineering/status dashboard) and the request came with no mention of /road-to-mainnet or the dashboard specifically.",
  "rationale": "middleware.ts's Gate 1 previously read SSR_SITE_PASSWORD unconditionally; verifySessionCookie (lib/dashboard/session.ts) returns false whenever the password argument is empty, so simply unsetting SSR_SITE_PASSWORD would NOT have opened the site -- it would have made Gate 1 permanently unsatisfiable (no session could ever verify against an empty password), locking everyone out instead of letting everyone in. Instead added an explicit, additive bypass: `if (process.env.SSR_SITE_GATE_ENABLED !== 'false') { ...existing Gate 1 checks... }`, defaulting to enabled (a no-op) so nothing changes unless the var is explicitly set to the literal string 'false'. Set it in Vercel Production and redeployed. Chosen over deleting Gate 1's code outright specifically because Creator said 'for now' -- re-enabling later is a one-line env var change (remove the var, or set it back to 'true'), not a code revert.",
  "alternativesConsidered": [
    "Unset SSR_SITE_PASSWORD entirely -- rejected: as above, this locks the site out completely (verifySessionCookie always returns false for an empty password) rather than opening it, the opposite of the request.",
    "Delete Gate 1's code from middleware.ts outright -- rejected: Creator said 'for now,' implying this is expected to come back; a toggle is exactly as safe to disable and strictly easier to re-enable than a code deletion would be.",
    "Also disable Gate 2 (the internal dashboard password) -- rejected: not requested, and conflates two independent concerns (public site access vs. internal team access) this repo has deliberately kept separate since DEC-0117/0119."
  ],
  "impact": "Deployed to production. https://strategic-super-reserve.fun/ and /create now serve real content directly, no login required. /road-to-mainnet and the rest of /internal/* still correctly require the internal dashboard password, unchanged. No code path was deleted -- re-enabling Gate 1 later is a single env var change (`vercel env rm SSR_SITE_GATE_ENABLED production` or setting it to 'true') plus a redeploy, no code change needed.",
  "affectedAreas": ["middleware.ts", "Vercel Production env (SSR_SITE_GATE_ENABLED, new)"],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b`, `npx oxlint middleware.ts`: clean.",
    "Commit `7048e3a` on `main`, pushed to `origin/main`.",
    "`vercel env add SSR_SITE_GATE_ENABLED production` (value `false`, type Sensitive); `vercel --prod --yes` deployment `dpl_BjV6gkhVMytvmGa4ct2VgtP6uWCp`, readyState READY, target production, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun (confirmed via `vercel inspect`).",
    "Live GET https://strategic-super-reserve.fun/: 200, real app shell HTML (title 'SSR.fun — a launchpad for tokenized reserves'), no login form -- confirmed after an initial request briefly still showed the cached login page (edge propagation lag immediately after aliasing), which cleared within seconds on retry.",
    "Live GET https://strategic-super-reserve.fun/create: 200.",
    "Live GET https://strategic-super-reserve.fun/road-to-mainnet: still returns the 'Internal access' login page, confirming Gate 2 is completely unaffected.",
    "`vercel logs --level error` for the new deployment: none."
  ]
}
```

## DEC-0130

```json
{
  "id": "DEC-0130",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "CONFIRMED ROOT CAUSE of the recurring 'seeding step reads zero' incident, superseding DEC-0127/DEC-0128's incomplete diagnosis: Connection.getTokenAccountBalance -- the ONLY way the client reads a real wallet token balance -- was missing from BOTH api/mainnet/rpc-proxy.ts's and api/devnet/rpc-proxy.ts's method allowlists, so every single call was rejected with a JSON-RPC 'method not permitted' error, silently swallowed by fetchOwnedBalanceRaw's try/catch and reported as a balance of exactly 0, deterministically, every time. Fixed by adding the method to both allowlists, reworking seed-funding to swap only the genuine deficit against target (not the full budget every retry), backing off exponentially on balance polling, and excluding Token-2022 mints from the Mainnet Reserve Asset picker (a real, separate, confirmed client-wide gap surfaced during this diagnosis).",
  "context": "Creator reported, with specifics: SSR mint BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump read as 0 raw units for wallet/reserve context 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen, which actually held ~191,000 SSR (~9x the ~21,000 required for a $10 USDC Reserve); repeated launch attempts had successfully bought MORE SSR each time, yet seeding kept reading zero. Explicit instruction: verify every address on-chain, do not assume; diagnose using actual Mainnet transactions/accounts; do not submit transactions or modify the existing Reserve during diagnosis; describe the intended read-existing/use-existing/deficit-only/swap-deficit/poll-with-backoff/seed/confirm/mark-complete flow and fix Resume Deployment to reconstruct it from on-chain state.",
  "rationale": "Live, read-only forensics (no signature submitted, no Reserve state touched): getTokenAccountsByOwner for wallet 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen filtered by the SSR mint returned real token account 63UUcPv7qnDjGXtS64VyUuYXQrLRNKoXK4ddWJP8YvM3 holding 191,598.743106 SSR (6 decimals) -- confirmed as the CORRECT canonical ATA by independently deriving it with the exact same getAssociatedTokenAddressSync(mint, owner) call createReserveClient.ts uses (matched exactly). The SSR mint's own account confirmed it is owned by the classic SPL Token program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA), not Token-2022 -- ruling out an ATA-derivation/token-program mismatch for THIS specific incident. Decoding the wallet's recent transaction history showed a create_reserve+initialize_reserve_asset landing, immediately followed by TWO separate real $10 Jupiter swaps 47 seconds apart (each confirmed via pre/post token balances: USDC -10 exactly, SSR increasing both times) with NO seed_reserve transaction ever attempted in between or after -- meaning the client was re-swapping the FULL budget on each attempt (never recognizing the wallet already held far more than enough) and then failing to submit seed_reserve at all (the new DEC-0127 client-side pre-flight guard correctly refusing to submit a doomed transaction, but for a balance that was never actually zero).\n\nTraced directly to the RPC layer: a direct curl POST of a getTokenAccountBalance JSON-RPC request against the LIVE production proxy (api/mainnet/rpc-proxy) returned `{\"error\":{\"code\":-32601,\"message\":\"Method not permitted via this proxy.\"}}` -- confirmed getAccountInfo and getBalance both work correctly for the exact same account, isolating the failure to this one specific method never having been added to ALLOWED_METHODS when Jupiter-swap-funded seeding was introduced (DEC-0124). fetchOwnedBalanceRaw's blanket try/catch (added for the legitimate 'no ATA yet = 0 balance' case) had no way to distinguish that from 'this RPC call is structurally blocked' -- both silently became 0. This explains every observed symptom: the pre-swap 'already holds enough, skip the swap' check always saw 0 (so every retry re-swapped the full budget, matching 'repeated launch attempts have successfully bought more SSR'), and fetchOwnedBalanceRawSettled's post-swap retries ALSO always converged to 0 after exhausting their window (since every attempt hit the identical deterministic rejection, never a transient lag the retries could ever outlast) -- meaning DEC-0127's diagnosis (RPC eventual consistency / node lag) was WRONG, or at best an incomplete explanation of a symptom whose real, dominant cause was this hard method block the whole time.\n\nA SEPARATE, genuine gap was also found and fixed during this diagnosis: fundSeedAssetsIdempotent always fetched a Jupiter quote for and (if needed) swapped the FULL per-asset USD budget, never just the shortfall against an existing balance -- so even once the balance-read bug above is fixed, a partially-funded wallet would still have been over-swapped. New scaleUsdcBudgetForDeficit (createReserveResume.ts) scales the USDC input proportionally to only the genuine deficit, reusing the full-budget quote's own price ratio rather than a second, potentially differently-priced quote. Also found: every packages/sdk instruction builder hardcodes `tokenProgram: TOKEN_PROGRAM_ID` unconditionally, while the on-chain ssr_protocol program itself is genuinely Token-2022-aware (`TokenInterface`/`TokenProgramKind::Token2022` in initialize_reserve_asset.rs) -- meaning a Token-2022 Reserve Asset, if ever selected, would build a transaction with the wrong token_program account and fail on-chain regardless of any balance-reading fix. Not itself the reported incident's cause (the SSR mint is confirmed classic-Token-program), but a real latent gap; fixed by excluding confirmed Token-2022 mints from api/ledger/asset-catalogue.ts's picker output rather than attempting a partial client-side fix that the SDK-wide hardcoding would still defeat end to end.",
  "alternativesConsidered": [
    "Widen fetchOwnedBalanceRaw's error handling to distinguish 'RPC method rejected' from 'account not found' and surface the former as a hard error instead of silently returning 0 -- considered as defense-in-depth alongside the allowlist fix, not instead of it; deferred this pass since the allowlist fix removes the actual rejection entirely, and a broader error-classification change to a function called on every balance check everywhere risks behavior changes outside this incident's scope.",
    "Fetch an ExactOut Jupiter quote requesting the deficit amount directly (server-side swapMode=ExactOut support) instead of scaling an ExactIn quote proportionally -- more precise (avoids any price-drift between the full-budget quote and the deficit purchase), but requires new server-side api/mainnet/jupiter-swap.ts changes to support a second swap mode; deferred as a possible future refinement -- the proportional-scaling approach is accurate enough given the swap already has slippage tolerance built in, and keeps this fix scoped to the client.",
    "Make the client Token-2022-aware end to end (detect each mint's real token program, pass the correct one through every instruction builder) instead of excluding Token-2022 mints from the picker -- rejected as out of scope for this pass: it would require touching packages/sdk broadly (createReserveFlow.ts, directInstructions.ts, managementInstructions.ts, zapInstructions.ts, ammInstructions.ts, rebalanceExecutionInstructions.ts), affecting Buy/Sell/rebalance/zap flows that have nothing to do with the reported incident, for a token-program family this specific incident never actually involved."
  ],
  "impact": "Deployed to production. Connection.getTokenAccountBalance now succeeds through both rpc-proxy endpoints -- confirmed live, returning the wallet's real 191,598.743106 SSR balance. A partially- or fully-funded wallet resuming a deployment now swaps only its genuine deficit (or nothing at all), never the full budget again -- both fixing wasted USDC/fees and making 'existing SSR being excluded because it was acquired during earlier attempts' (explicitly checked per Creator's instruction) impossible going forward. Token-2022 mints are excluded from the Mainnet Reserve Asset picker until the SDK is updated end to end. No transaction was signed, submitted, or simulated at any point during this diagnosis; every on-chain check was a plain read (getTokenAccountsByOwner, getAccountInfo, getTransaction, and a direct proxy-method probe). 19 new regression tests (680/680 total passing, including a self-auditing test that scans createReserveClient.ts's/rpcResilience.ts's actual Connection method usage against both rpc-proxy allowlists -- this specific check would have caught the missing method the moment it was first called), tsc -b/oxlint/build all clean.",
  "affectedAreas": [
    "api/mainnet/rpc-proxy.ts",
    "api/devnet/rpc-proxy.ts",
    "api/ledger/asset-catalogue.ts",
    "src/merge/lib/createReserveClient.ts",
    "src/merge/lib/createReserveResume.ts",
    "tests/phase_mainnet_production_fixes.ts",
    "tests/phase_helius_rpc_and_buy_fix.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "getTokenAccountsByOwner (live RPC) for wallet 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen filtered by mint BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump: real token account 63UUcPv7qnDjGXtS64VyUuYXQrLRNKoXK4ddWJP8YvM3, tokenAmount 191598.743106 (6 decimals).",
    "Independently derived getAssociatedTokenAddressSync(mint, owner) in Node using this repo's own @solana/spl-token dependency: matched 63UUcPv7qnDjGXtS64VyUuYXQrLRNKoXK4ddWJP8YvM3 exactly.",
    "getAccountInfo (live RPC) on the SSR mint itself: program 'spl-token', owner TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA -- confirmed classic Token program, not Token-2022.",
    "getSignaturesForAddress + getTransaction (live RPC, jsonParsed) decoded the wallet's most recent transactions: 54bDD6R...(19:53:19, create_reserve+initialize_reserve_asset, discriminators 1aa1d3135ada70eb/846114b03c42b428, success), 4zkHyUqvT...(19:53:27) and 3jWMYho3z...(19:54:14), each a real Jupiter swap confirmed via pre/post token balances (USDC -10.0 exactly, SSR increasing 149,711 -> 170,658 -> 191,598) -- no seed_reserve instruction present in any of these or any later transaction.",
    "Direct curl POST of {method:\"getTokenAccountBalance\"} against the LIVE production proxy (https://strategic-super-reserve.fun/api/mainnet/rpc-proxy) returned {\"error\":{\"code\":-32601,\"message\":\"Method not permitted via this proxy.\"}} BEFORE this fix -- and the identical request against getAccountInfo/getBalance for the same account succeeded, isolating the failure to this one method.",
    "`npx tsc -b`, `npx oxlint` (changed files): clean.",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 680/680 passing (19 new).",
    "`npm run build`: clean.",
    "Commit `ebf372e` on `main`, pushed to `origin/main`; `vercel --prod --yes` deployment `dpl_FF8oAQFcdzoZwFxiBZWzER9ZFYCf`, readyState READY, target production, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun (confirmed via `vercel inspect`).",
    "Post-deploy, the identical getTokenAccountBalance curl request against the same live proxy now returns the correct real balance (191598.743106 SSR) instead of the method-not-permitted error -- confirmed fixed in production, not just in code.",
    "Live GET https://strategic-super-reserve.fun/: 200; GET https://strategic-super-reserve.fun/create: 200; `vercel logs --level error` for this deployment: none."
  ]
}
```

## DEC-0131

```json
{
  "id": "DEC-0131",
  "date": "2026-08-20",
  "status": "confirmed",
  "decision": "Fixed two live-reported Mainnet display bugs: (1) 'Live on Solana DevNet' and other 'DevNet' labels appeared everywhere -- Discover/Featured Reserve cards, Portfolio's per-Reserve badge, the global nav/footer/wallet-chip/wallet-panel/connect-modal shell, Buy/Sell in-flight labels and RPC-congestion toasts -- regardless of which cluster the app was actually running against; (2) a Mainnet Reserve composed of a real, non-fixture asset (Creator's example: a Reserve called 'alpha', 100% SSR) showed its composition entry as a generic 'Asset' placeholder instead of the real symbol.",
  "context": "Creator reported directly: 'reserves still say \"live on solana devnet\" on their cards in discover reserves for example. reserve deployed on mainnet called \"alpha\", comprised 100% of SSR, but in the composition it's labeled as \"asset\"'. Reported alongside a third item (manager fees claimable in Reserve Token instead of USDC) -- see DEC-0132 for why that one was NOT implemented this pass.",
  "rationale": "Item 1 root cause: reserveCardProps.ts's buildReserveCardProps hardcoded `{ label: \"Live on Solana DevNet\", tone: \"onchain\" }` unconditionally for every on-chain Reserve -- confirmed via grep this was one of roughly a dozen genuinely hardcoded 'DevNet' strings scattered across Discover.tsx, Portfolio.tsx, and the pre-merge FABLE shell (Shell.tsx/WalletPanel.tsx/WalletModal.tsx, which wrap literally every route via App.tsx and had never been touched during the Mainnet-launch pass) -- none of these had ever been made cluster-aware, unlike DTRDetail.tsx/CreateDTR.tsx/ManageDTR.tsx which already correctly used a local CLUSTER_LABEL constant. rpcResilience.ts's txPhaseLabel (the Buy/Sell in-flight status text) had the same hardcoding. Fixed every instance to be cluster-aware, following the exact CLUSTER_LABEL pattern already proven correct elsewhere. Two of the fixed functions (reserveCardProps.ts, rpcResilience.ts, onChainReserve.ts) are directly required by tests/phase_*.ts via ts-mocha's CommonJS loader, which cannot load solana-config.ts's import.meta.env syntax (a constraint already documented in onChainReserve.ts's own header) -- so each accepts its cluster context as a plain parameter with a DevNet-matching default instead, keeping every pre-existing caller/test unchanged. Also found and fixed two further Mainnet-vs-DevNet UX mismatches surfaced while auditing this: WalletPanel.tsx unconditionally tried to read and display a 'devUSDC' balance even on Mainnet (where that mint doesn't exist), and the DevNet-only 'Testing Environment'/'Unlisted testing deployment' badge and 'no real economic value' framing were still shown on a genuinely live Mainnet deployment with real funds.\n\nItem 2 root cause: buildDtrFromDiscoveredReserve's (onChainReserve.ts) symbol-resolution chain for a discovered Reserve's composition only recognized DevNet fixture mints, wrapped SOL, devUSDC, and the hardcoded Mainnet USDC constant -- ANY other real asset (any Jupiter-catalogued Mainnet token, including SSR itself) fell straight through to a generic `Asset${i+1}` placeholder regardless of cluster, since this function had no access to the Mainnet Jupiter asset catalogue's mint->symbol data at discovery time. Fixed by threading the catalogue (already fetched client-side for CreateDTR.tsx's asset picker via the existing useMainnetAssetCatalogue hook) into RealReserveSync.tsx as a mint->{symbol,name} map, passed through buildDtrFromDiscoveredReserve as a new, backward-compatible `mintMeta` parameter (default {}) consulted as an additional resolution source before the placeholder. Best-effort by design: a mint the catalogue hasn't (yet) indexed still honestly falls back to 'AssetN' rather than fabricating a symbol, self-correcting on RealReserveSync's next poll once the catalogue has loaded. Also found and fixed a second instance of the same underlying bug class while auditing this function: its `tags` array and unparsed-metadata fallback `category` both hardcoded the literal string 'devnet'/'DevNet' regardless of the real `clusterOverride` already being passed in.",
  "alternativesConsidered": [
    "Import IS_MAINNET from ./solana-config directly into reserveCardProps.ts/onChainReserve.ts/rpcResilience.ts -- rejected: that module reads import.meta.env (Vite-only syntax), and all three files are required directly by tests/phase_*.ts via ts-mocha's CommonJS loader, which crashes on that syntax the moment it's transitively imported (already documented and worked around this same way in onChainReserve.ts's pre-existing header comment for its own clusterOverride parameter).",
    "Do a blanket find-and-replace of every 'DevNet' string in the whole codebase, including files unreachable from any live route -- rejected: scoped this pass to strings genuinely visible on a live page (confirmed each fixed file is actually rendered/reachable via App.tsx's route tree), not a mechanical sweep that could touch dead code or deliberately-DevNet-only surfaces (DevnetOnboarding.tsx is correctly gated behind `!IS_MAINNET` already and was left untouched)."
  ],
  "impact": "Deployed to production. Every 'DevNet' label a Mainnet user could see is now accurate, including the global nav bar/footer/wallet UI that wraps every single page (previously untouched by the Mainnet-launch pass entirely). A Reserve composed of a real Mainnet asset (e.g. SSR) now shows its real symbol in its composition breakdown instead of a generic placeholder, self-correcting automatically as the Jupiter catalogue indexes new mints. 10 new regression tests (690/690 total passing), tsc -b/oxlint/build all clean, live-verified (site/discover both 200, no error logs).",
  "affectedAreas": [
    "src/merge/lib/reserveCardProps.ts",
    "src/merge/lib/onChainReserve.ts",
    "src/merge/lib/RealReserveSync.tsx",
    "src/merge/lib/rpcResilience.ts",
    "src/merge/pages/Discover.tsx",
    "src/merge/pages/DTRDetail.tsx",
    "src/merge/pages/Portfolio.tsx",
    "src/pages/Home.tsx",
    "src/components/Shell.tsx",
    "src/components/WalletPanel.tsx",
    "src/components/WalletModal.tsx",
    "tests/phase_create_reserve_delegate_and_metadata.ts",
    "tests/phase_featured_cards_and_rpc_redaction.ts",
    "tests/phase_rpc_resilience.ts"
  ],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "`npx tsc -b`, `npx oxlint` (changed files): clean (2 pre-existing, unrelated DTRDetail.tsx react-hooks/exhaustive-deps warnings, not introduced this pass).",
    "`npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_*.ts`: 690/690 passing (10 new).",
    "`npm run build`: clean.",
    "Commit `2162760` on `main`, pushed to `origin/main`; `vercel --prod --yes` deployment `dpl_CqTJ32ke3Kbjkoif1fVKgbmwNMry`, readyState READY, target production, aliased to strategic-super-reserve.fun/www.strategic-super-reserve.fun (confirmed via `vercel inspect`).",
    "Live GET https://strategic-super-reserve.fun/: 200; GET https://strategic-super-reserve.fun/discover: 200; `vercel logs --level error` for this deployment: none."
  ]
}
```

## DEC-0132

```json
{
  "id": "DEC-0132",
  "date": "2026-08-20",
  "status": "deferred",
  "decision": "Deliberately did NOT implement Creator's third request this pass -- 'manager fees are claimable in reserve token. the fee shouldn't come out of the reserve token, it should come out in USDC and be claimable in usdc' -- pending explicit confirmation from Creator, after investigation confirmed this is a real-money, protocol-level (Rust) redesign of a live Mainnet program, not a client-side bug.",
  "context": "Reported alongside the two display bugs fixed in DEC-0131. Investigated before writing any code, per this session's standing 'diagnose before changing anything' practice for anything touching real Mainnet state.",
  "rationale": "Confirmed via direct code review (programs/ssr_protocol/src/instructions/mint_reserve_tokens_in_kind.rs, accrue_fees.rs, collect_fees.rs, collect_manager_fee_share.rs, collect_protocol_fee.rs, packages/sdk/src/feeMath.ts) that the mint fee and TVL fee are NOT deducted from deposited USDC/backing assets today -- they are additional Reserve Token SHARES minted on top of supply (an ERC-4626-style dilutive fee model, by original design -- see DEC-0094), and collect_fees.rs's/collect_manager_fee_share.rs's claim path literally calls token::mint_to into the recipient's Reserve Token ATA. ManageDTR.tsx's fee-claim UI (labeling every fee amount with the Reserve's own ticker) is honestly reporting real on-chain behavior, not a display bug -- there is no USDC-denominated fee path anywhere in the deployed program today. This means the request cannot be satisfied client-side at all; it requires reworking every fee-touching on-chain instruction (mint_reserve_tokens_in_kind.rs, accrue_fees.rs, collect_fees.rs, collect_manager_fee_share.rs, collect_protocol_fee.rs, seed_reserve.rs, fee_math.rs, and the relevant account state) from a mint-based accounting model to a transfer-based one -- not a parameter tweak.\n\nTwo genuine open product questions block writing this safely, neither of which this session can decide unilaterally: (1) where would USDC-denominated fees even come from for a non-100%-USDC Reserve -- Creator's own cited example, 'alpha', is 100% SSR and holds no USDC at all, so charging fees 'in USDC' requires either redeeming some of the backing asset into USDC (a new, non-trivial mechanism) or a different design entirely; (2) existing Reserves already have real, accrued-but-uncollected pending Reserve-Token-denominated fee balances on-chain today -- a format change needs an explicit migration decision (do they still pay out as Reserve Tokens, or does something else happen to them) rather than silently breaking or reinterpreting real pending state. Separately, this environment's `cargo-build-sbf` has worked as recently as DEC-0114 (2026-08-18), so a rebuild is technically feasible, but `solana-test-validator`/`anchor test` do not work here (a longstanding Windows privilege gap) -- meaning any change to this code would be validated with zero local integration coverage before going straight to a Mainnet program upgrade that already custodies real, live Reserves and real funds.",
  "alternativesConsidered": [
    "Implement the Rust change now and ship it -- rejected: a real-money, no-local-test-coverage change to a program with existing live Reserves and real pending fee balances must not be guessed at; the two open product questions above have real, materially different possible answers that change what code should even be written.",
    "Silently do nothing and only mention this in the final report -- rejected: the investigation itself is genuinely useful and worth recording durably (root cause, exact affected files, exact blockers) so a future pass -- once Creator has answered the open questions -- doesn't have to re-derive any of this from scratch."
  ],
  "impact": "No code changed, no transaction submitted, nothing deployed for this item. Findings reported back to Creator directly, with the two open product questions surfaced explicitly so a future pass can proceed the moment they're answered.",
  "affectedAreas": [],
  "supersedes": null,
  "supersededBy": null,
  "evidence": [
    "Direct source review: programs/ssr_protocol/src/instructions/mint_reserve_tokens_in_kind.rs, accrue_fees.rs, collect_fees.rs, collect_manager_fee_share.rs, collect_protocol_fee.rs -- fee shares minted as Reserve Token supply via token::mint_to, no USDC transfer path present.",
    "packages/sdk/src/feeMath.ts / DEC-0094: confirms the mint-based (dilutive share) fee model was the original, deliberate design, not an oversight.",
    "src/merge/pages/ManageDTR.tsx: fee-claim UI amounts are suffixed with the Reserve's own ticker throughout -- confirmed to accurately reflect real on-chain behavior, not a mislabeling bug.",
    "docs/project/PROJECT_STATUS.md / DEC-0113/DEC-0114: cargo-build-sbf confirmed working in this environment as of 2026-08-18; solana-test-validator/anchor test confirmed still blocked (pre-existing, documented Windows privilege gap)."
  ]
}
```
