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
  "supersededBy": null,
  "evidence": [
    "tsc -b, vite build, oxlint all clean (new internalFeedback build entry confirmed in dist/ output)",
    "Google Drive folder/sheet genuinely created this session via the assistant's connected Drive access: folder id 1B1HMK1HHmnINSuQQ42iztgtTyU8-z5zv, sheet id 1xacWW9Bu0CmcUEBhw1TQsibdLwn6gZrK2OAiebmWQag, both owned by joao@enigma-fund.com",
    "FEEDBACK_DRIVE_FOLDER_ID/FEEDBACK_SHEET_ID confirmed added to Vercel (Production + Preview) via `vercel env add`",
    "No live end-to-end submission test performed -- GOOGLE_SERVICE_ACCOUNT_KEY is not yet configured (pending the user's GCP setup) and the destination folder/sheet have not yet been shared with a service account, so a real Drive write cannot succeed yet; the endpoint fails closed with an honest 'not configured' error in the meantime, never a fabricated success"
  ]
}
```
