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
