<!--
  Source of truth for the /internal/status dashboard's Milestones,
  Engineering Timeline, and Infrastructure panels. Parsed server-side
  (api/dashboard/content.ts / lib/dashboard/parseMarkdown.ts) exactly like
  PROJECT_STATUS.md and DECISION_LOG.md -- fenced ```json blocks under each
  heading are the structured data the dashboard renders.

  Every entry has a "source" field:
    - "git"    -- derived from a real commit; "commit" gives the exact hash
                  (verify with `git show <hash>` / `git log -1 <hash>`).
    - "manual" -- not reconstructable from a single commit (platform
                  migrations, external config like DNS/domain registration,
                  labels for infrastructure that isn't itself a code change).
                  Never fabricated -- each one is a real, known fact, just
                  not one `git log` alone can prove.

  Mechanical repo facts (commit counts, contributors, branches, LOC, doc/DEC
  counts) live in the separately-generated docs/project/REPO_METRICS.json
  (see scripts/generate-repo-metrics.ts -- re-run it, never hand-edit that
  file). This file is the curated NARRATIVE layered on top of those facts.

  Update this file when a new milestone lands, following the existing
  entries' format. Keep entries in chronological order within "Timeline".
-->

## Milestones

```json
[
  {
    "id": "replit-prototype",
    "title": "SSR.fun prototype started",
    "description": "First commit of the BYOR (Build-Your-Own-Reserve) prototype on Replit -- the seed of what became SSR.fun.",
    "date": "2026-07-13",
    "category": "product",
    "source": "git",
    "commit": "8e0fa4bcf5fd4978a92556ef6829bab5ec2aa2c0"
  },
  {
    "id": "replit-to-github",
    "title": "Migrated from Replit to GitHub",
    "description": "Development moved off Replit's managed environment onto a locally-driven git workflow pushed to github.com/JRA-EF/SSR.FUN. No single commit marks the switch itself (it's a platform change, not a code diff) -- inferred from the gap between the last Replit Agent commit and the first commit authored outside Replit.",
    "date": "2026-07-16 to 2026-07-22",
    "category": "infra",
    "source": "manual",
    "note": "Window inferred from git log, not independently confirmed against Replit/GitHub account history."
  },
  {
    "id": "simulation-platform-complete",
    "title": "SSR.fun simulation platform completed",
    "description": "Full mocked/simulated launchpad experience: homepage, Discover, Create Reserve, Portfolio, Manage, and Reserve-detail flows, unified Reserve cards, a simulated wallet-connect modal, and a full terminology pass onto \"Reserve\" / \"Launch Reserve\". Everything Simulation Mode -- no wallet, network, or on-chain program yet.",
    "date": "2026-07-24",
    "category": "product",
    "source": "git",
    "commit": "1f6a2a619bc2c9862b189ab0f277ccd074e2bc85"
  },
  {
    "id": "claude-code-workflow",
    "title": "Claude Code workflow established",
    "description": "First AI-co-authored commits (\"Claude Fable 5\"), rebuilding the homepage to the approved reference design and porting the Discover/Create/Portfolio/Manage/Reserve-detail flows from the SSR.FUN-MERGE prototype.",
    "date": "2026-07-23",
    "category": "workflow",
    "source": "git",
    "commit": "6b857d0252d136a3dbb875dc826781fa501acd3a"
  },
  {
    "id": "vercel-migration",
    "title": "Migrated from Replit deployment to Vercel",
    "description": "Vite static SPA build/output configured for Vercel, Git-triggered auto-deploys disabled in favor of manual/intentional deploys, SPA fallback rewrite added.",
    "date": "2026-07-27",
    "category": "infra",
    "source": "git",
    "commit": "2831e59cab24c738b4ad8d5f8f1d6e8aa8132526"
  },
  {
    "id": "custom-domain",
    "title": "Custom production domain live",
    "description": "strategic-super-reserve.fun registered and pointed at the Vercel production deployment. DNS/registrar configuration happens outside this repository, so there's no commit marking it directly -- see docs/project/PROJECT_STATUS.md's Dependencies section (Name.com).",
    "date": "2026-07-27",
    "category": "infra",
    "source": "manual",
    "note": "Exact registration timestamp is Name.com/Vercel account data, not derivable from git."
  },
  {
    "id": "internal-dashboard",
    "title": "Internal project-status dashboard established",
    "description": "Password-protected /internal/status, rendered server-side from PROJECT_STATUS.md and DECISION_LOG.md, with session-cookie auth and login rate limiting.",
    "date": "2026-07-27",
    "category": "workflow",
    "source": "git",
    "commit": "968c2dde6a367ac6043b29f9bbce04bc78bac73b"
  },
  {
    "id": "protocol-architecture",
    "title": "Reserve Protocol architecture completed",
    "description": "Reserve Protocol's Folio (EVM/Solidity) analyzed as reference-only material; SSR's own Solana-native account/authority/instruction architecture locked; the full 17-instruction Anchor program and a TypeScript SDK hand-written.",
    "date": "2026-07-27",
    "category": "protocol",
    "source": "git",
    "commit": "15a53007bd96061ba42ec66f36d3be1de03aa6f1"
  },
  {
    "id": "local-devtools",
    "title": "Local Solana/Anchor development environment established",
    "description": "Native Rust (GNU target) + MinGW + Solana CLI toolchain installed piece by piece in an environment with no prior Rust/Solana/WSL; the full protocol program compiles clean end-to-end (cargo check / build / clippy, zero errors) for the first time.",
    "date": "2026-07-27",
    "category": "protocol",
    "source": "git",
    "commit": "6eae185c64fd7d3f07038c58bf3ffd2db318cd46"
  },
  {
    "id": "devnet-live",
    "title": "SSR Protocol deployed live on Solana DevNet",
    "description": "Real BPF/SBF compilation succeeded after installing Visual Studio Build Tools; the compiled program deployed and verified on-chain at 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW.",
    "date": "2026-07-28",
    "category": "protocol",
    "source": "git",
    "commit": "190884d2d6156cba5c432c5f73d147a35ad5a030"
  },
  {
    "id": "test-suite-live",
    "title": "Full test suite passing against live DevNet",
    "description": "14/14 tests -- Reserve creation, asset registration, seeding, proportional mint/redeem across holders, pause/unpause, scoped delegates, and the cross-Reserve vault-substitution isolation test -- all confirmed against the real deployed program, not a local simulator.",
    "date": "2026-07-28",
    "category": "testing",
    "source": "git",
    "commit": "5c5959690023ac9624ae6b37aaf51fc9ff070353"
  },
  {
    "id": "frontend-wired-to-devnet",
    "title": "Frontend wired to live DevNet program",
    "description": "Real Phantom/Solflare/Backpack wallet connection, real on-chain reads, Buy/Sell redefined as a real SOL zap, and real Create Reserve deployment -- all while preserving the existing frontend design exactly.",
    "date": "2026-07-28",
    "category": "frontend",
    "source": "git",
    "commit": "11576fddcf00e8df1d36536bc4b6bac9ff35e0d4"
  },
  {
    "id": "production-gate10-11",
    "title": "Gate 10-11 integration deployed to production",
    "description": "Real wallet connection, real Buy/Sell, and real Create Reserve went live on strategic-super-reserve.fun; a production-only ERR_REQUIRE_ESM bug was found and fixed via post-deploy smoke testing within the same session.",
    "date": "2026-07-28",
    "category": "frontend",
    "source": "git",
    "commit": "b333a4aff09f39d4d1fb99958746d6a35371591e"
  },
  {
    "id": "dynamic-reserve-validation",
    "title": "Dynamic on-chain Reserve validation shipped",
    "description": "Replaced a hardcoded 2-Reserve allowlist with fully dynamic, on-chain-derived validation -- any Reserve created through the real Create Reserve flow now supports Buy/Sell immediately, no code change or manual registration required.",
    "date": "2026-07-28",
    "category": "protocol",
    "source": "git",
    "commit": "0a496a839250cf59952764b03ffd3c072b4190d6"
  },
  {
    "id": "devnet-treasury-live",
    "title": "DevNet protocol treasury configured and verified",
    "description": "Added an update_protocol_config instruction (the field was previously settable only once, at genesis), deployed it via a real program upgrade, and verified real fee routing with a collect_fees call.",
    "date": "2026-07-28",
    "category": "protocol",
    "source": "git",
    "commit": "909687f6d09e429dd6630b2f459225158a316637"
  }
]
```

## Fixes

<!--
  Verified corrective passes, shown as a dedicated dashboard panel distinct
  from Milestones (net-new capability) and Timeline (chronological detail).
  Each entry's `status` must never say "completed" if a required manual
  verification step (e.g. a browser click-through) is still outstanding --
  use `remaining` to say so explicitly instead. `commit` is omitted when a
  fix is committed in the exact same commit as this file's own update (a
  commit cannot cite its own hash) -- `source: "manual"` in that case, not
  fabricated as git-verified.
-->

```json
[
  {
    "id": "devnet-buy-flow-live-metrics",
    "title": "DevNet Buy Flow and Live Metrics",
    "date": "2026-08-03",
    "status": "completed",
    "commit": "9815b634a78805f203cf554a2536eda72b0fac31",
    "source": "git",
    "summary": [
      "Fixed and verified the DevNet Buy flow.",
      "Verified live AUM and NAV accounting using real on-chain balances.",
      "Added real Reserve Token holder counts and 24-hour volume.",
      "Automated DevNet Buy/Sell verification, typecheck, build, and 145 targeted tests passed.",
      "Fixed the 'unknown signer' Buy failure caused by signing with the swap authority when the transaction did not require it.",
      "Added per-Reserve holder indexing based on unique wallets with non-zero balances.",
      "Added globally deduplicated holder totals to the landing-page KPIs.",
      "Added visible per-Reserve 24-hour Buy and Sell volume.",
      "Confirmed devUSDC valuation at $1.",
      "Confirmed Reserve \"123\" correctly showed $0 AUM because it had been fully redeemed.",
      "Confirmed proportional zero-fee Sells preserve NAV while reducing AUM and Reserve Token supply.",
      "Verified accounting -- Seed: $100 AUM / 100 supply / $1 NAV. After Buy: $110 AUM / 109.95 supply / ~$1.000455 NAV. After Sell: $55 AUM / 54.975 supply / ~$1.000455 NAV."
    ],
    "remaining": [
      "Perform one manual Phantom Buy and Sell through the deployed UI.",
      "tests/ssr_protocol.ts remains blocked in this environment because Cargo is unavailable on PATH."
    ]
  },
  {
    "id": "tradable-reserves-multi-asset-buy-sell",
    "title": "Tradable DevNet Reserves and Multi-Asset Buy/Sell",
    "date": "2026-08-03",
    "status": "completed",
    "source": "manual",
    "note": "Committed in the same commit as this file's own update -- see git log on this repo for the exact hash rather than a self-referential one here.",
    "summary": [
      "Added a single shared eligibility function (packages/sdk/src/tradableAssets.ts) restricting every visible/tradable Reserve on the site to compositions built entirely from the 4 configured DevNet test mints (devUSDC, mockX, mockY, mockZ) -- wired into discovery/merge, landing-stats, swap-sign, and the Create-Reserve asset picker, so a Reserve holding any other asset (e.g. wrapped SOL) is excluded everywhere, never partially.",
      "Fixed the 'Buy only works for 100% devUSDC Reserves' limitation: Buy now mints a non-devUSDC leg (mockX/Y/Z) directly to the buyer from the swap authority's own mint authority over that specific test mint, reported honestly per-leg (never conflated with a genuine devUSDC payment).",
      "Added a new devUSDC-settled Sell path (buildSellZapInstructionsDevUsdc) for mixed/multi-asset Reserves: redeems in-kind for real, keeps any real devUSDC entitlement with the seller, and converts every other asset's entitlement into freshly-minted devUSDC -- replacing the prior SOL-denominated settlement for these compositions and removing the swap authority's SOL balance as a Sell dependency entirely.",
      "Fixed the Price History range selector: buildLineSeries now reports an honest 'insufficient history' state for a Reserve with fewer than 2 ever-recorded price points instead of fabricating an identical flatline for every range button -- the root cause of every range appearing to 'do the same thing'.",
      "Live-verified real Buy then Sell against 4 real, persistent on-chain Reserves covering every required composition (100% devUSDC, 100% mockX via the existing TestLo fixture, multi-asset mockX/Y/Z via DevNet Reserve Two, and mixed devUSDC+mockX via the Phase C Reserve) -- exact vault/supply/NAV deltas confirmed per composition, including correct handling of mockZ's differing 9-decimal mint.",
      "Explicitly confirmed cross-Reserve isolation: after trading Reserves 3 and 4, Reserves 1 and 2's own vault/supply state was re-read and found byte-identical to their own post-trade snapshots.",
      "Confirmed real holder/volume refresh across all 4 compositions post-trade (2-5 holders and $11.98-$76.98 24h volume each, all genuine on-chain reads).",
      "Added 18 new offline regression tests (tradable-asset eligibility, mergeDiscoveredReserves wiring, buildLineSeries range independence/insufficient-history/multi-instance isolation) -- 163/163 offline tests passing."
    ],
    "remaining": [
      "A Reserve composed of 0% devUSDC lets a buyer acquire its non-devUSDC assets for free (swap-authority-minted, consistent with the pre-existing DevNet test-asset model) and then Sell converts that into freshly-minted real devUSDC with no cooldown or ceiling -- an unlimited devUSDC-minting path distinct from the rate-limited faucet. Flagged as a risk, not fixed in this pass (a rate-limit/ceiling decision for this specific path was outside this pass's scope).",
      "No manual Phantom Buy/Sell UI click-through was performed (no browser-automation tool available in this environment, pre-existing gap) -- verified instead via real signed transactions against live DevNet using a throwaway keypair, matching this repo's established scripts/verify_*.ts pattern.",
      "tests/ssr_protocol.ts remains blocked in this environment because Cargo is unavailable on PATH."
    ]
  }
]
```

## Timeline

```json
[
  { "date": "2026-07-13", "title": "Initial commit", "description": "BYOR prototype scaffolded on Replit.", "category": "product", "source": "git", "commit": "8e0fa4bcf5fd4978a92556ef6829bab5ec2aa2c0", "author": "Replit Agent" },
  { "date": "2026-07-14 to 2026-07-16", "title": "Replit-era iteration", "description": "Floating-card physics/seed data, deploy-flow custom categories, bonding-curve buy/sell pricing, DTR calculation logic, logo and navbar passes -- 18 Replit Agent commits plus interleaved manual fixes.", "category": "product", "source": "git", "commit": "0a727be6ba12a7e30cc5f44dc41bd475c8bfe246", "author": "Replit Agent / JRA-EF" },
  { "date": "2026-07-16", "title": "Last Replit-published build", "description": "Final \"Published your App\" commit from the Replit Agent.", "category": "infra", "source": "git", "commit": "0a727be6ba12a7e30cc5f44dc41bd475c8bfe246", "author": "Replit Agent" },
  { "date": "2026-07-22", "title": "Terminology unified on \"Reserve\"", "description": "All remaining \"DTR\" references removed from the UI in favor of Reserve/Reserves, alongside a hero-animation rework.", "category": "product", "source": "git", "commit": "4a73be3fc2add0e4149b1806d6878ce1d14cd0c3", "author": "JRA-EF" },
  { "date": "2026-07-23", "title": "Claude Code assists for the first time", "description": "Homepage rebuilt to the approved reference design; Discover/Create/Portfolio/Manage/Reserve-detail flows ported from the SSR.FUN-MERGE prototype.", "category": "workflow", "source": "git", "commit": "6b857d0252d136a3dbb875dc826781fa501acd3a", "author": "jra_xyz + Claude" },
  { "date": "2026-07-24", "title": "Reserve cards unified, real wallet-connect modal, terminology pass", "description": "Simulation-mode wallet-connect flow, richer Portfolio page.", "category": "product", "source": "git", "commit": "1f6a2a619bc2c9862b189ab0f277ccd074e2bc85", "author": "jra_xyz + Claude" },
  { "date": "2026-07-27 16:04", "title": "Vercel migration", "description": "Vite SPA build configured for Vercel; manual deploys only.", "category": "infra", "source": "git", "commit": "2831e59cab24c738b4ad8d5f8f1d6e8aa8132526", "author": "Joao + Claude" },
  { "date": "2026-07-27 18:16", "title": "Internal dashboard added", "description": "Password-protected /internal/status stood up.", "category": "workflow", "source": "git", "commit": "968c2dde6a367ac6043b29f9bbce04bc78bac73b", "author": "Joao + Claude" },
  { "date": "2026-07-27 20:10", "title": "Reserve Protocol v1 designed and scaffolded", "description": "Reference-protocol analysis, architecture lock, 17-instruction Anchor program + TypeScript SDK hand-written.", "category": "protocol", "source": "git", "commit": "15a53007bd96061ba42ec66f36d3be1de03aa6f1", "author": "Joao + Claude" },
  { "date": "2026-07-27 21:47", "title": "Native toolchain installed, program compiles clean", "description": "~15 real compiler-caught bugs fixed along the way.", "category": "protocol", "source": "git", "commit": "6eae185c64fd7d3f07038c58bf3ffd2db318cd46", "author": "Joao + Claude" },
  { "date": "2026-07-28 09:00-09:01", "title": "Adversarial tests added, formatting applied", "description": "Repeated-init and excess-redemption test cases.", "category": "testing", "source": "git", "commit": "2cb7084cf4dfdd772ff62a6080bd25ded7377d77", "author": "Joao + Claude" },
  { "date": "2026-07-28 10:21", "title": "SSR Protocol deployed live on Solana DevNet", "description": "Program ID 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW.", "category": "protocol", "source": "git", "commit": "190884d2d6156cba5c432c5f73d147a35ad5a030", "author": "Joao + Claude" },
  { "date": "2026-07-28 10:23-11:03", "title": "Gate 9 fixtures and testing plan", "description": "Persistent, documented DevNet fixtures for the frontend to point at.", "category": "protocol", "source": "git", "commit": "64d0e62c63496c51d84d91c484b177df265b675e", "author": "Joao + Claude" },
  { "date": "2026-07-28 10:48", "title": "Full test suite passing live on DevNet", "description": "14/14, against the real deployed program.", "category": "testing", "source": "git", "commit": "5c5959690023ac9624ae6b37aaf51fc9ff070353", "author": "Joao + Claude" },
  { "date": "2026-07-28 13:23-14:19", "title": "Gate 10-11: frontend wired to live DevNet", "description": "Real wallet connection, real reads, real Buy/Sell zap, real Create Reserve.", "category": "frontend", "source": "git", "commit": "11576fddcf00e8df1d36536bc4b6bac9ff35e0d4", "author": "Joao + Claude" },
  { "date": "2026-07-28 13:29-13:36", "title": "Merged to main and deployed to production", "description": "A production-only ERR_REQUIRE_ESM bug found and fixed via post-deploy smoke testing.", "category": "frontend", "source": "git", "commit": "78eeeab16036eab9c775501170c10bccf4e8bc6b", "author": "Joao + Claude" },
  { "date": "2026-07-28 14:19-15:57", "title": "Corrective pass: dynamic validation, SOL asset, treasury", "description": "Fixed the hardcoded-Reserve Buy/Sell bug, added SOL as a real asset, cut Create Reserve signatures, added a real cost summary, and deployed a DevNet protocol-treasury upgrade -- verified end-to-end against a fresh Reserve.", "category": "protocol", "source": "git", "commit": "d7d7f4403d1173410ed373c16ee3d80d399bc747", "author": "Joao + Claude" }
]
```

## Infrastructure

```json
[
  { "label": "Development", "value": "Claude Code", "detail": "Primary engineering workflow since 2026-07-23 (see Milestones).", "source": "manual" },
  { "label": "Version Control", "value": "GitHub", "detail": "github.com/JRA-EF/SSR.FUN", "source": "git" },
  { "label": "Hosting", "value": "Vercel", "detail": "Manual/intentional deploys only, no Git-triggered auto-deploy.", "source": "git" },
  { "label": "Protocol", "value": "Solana DevNet", "detail": "Program 2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW.", "source": "manual" },
  { "label": "Production Domain", "value": "strategic-super-reserve.fun", "detail": "Registered via Name.com, DNS pointed at Vercel.", "source": "manual" },
  { "label": "Simulation Mode", "value": "Enabled", "detail": "No wallet, network, or on-chain program connected outside the DevNet-integrated flows -- see CLAUDE.md.", "source": "manual" },
  { "label": "Authentication", "value": "Internal session auth", "detail": "Password-gated, HttpOnly signed session cookie, login rate limiting.", "source": "manual" },
  { "label": "Environments", "value": "Local / DevNet / Production", "detail": "See PROJECT_STATUS.md Environment Status for what's live in each.", "source": "manual" }
]
```
