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
