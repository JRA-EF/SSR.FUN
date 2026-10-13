# Full liquidity preview deployed on existing SSR hosting

- **Date:** 2026-10-12
- **Author:** Yeh via Codex
- **Branch / commits:** design 0caca75 deployed; this documentation commit records result
- **Deployed to:** preview dpl_TF86u5YuR1V7iDS176esAVf7mfr5, https://ssr-9n5xot45x-ssr14.vercel.app
- **Decision log:** DEC-0237

## What shipped
Full app/API preview with liquidity execution disabled. Existing SSR-team access resolves hosting blocker. Production remains dpl_8fi1xHmGUxJPk3hKtqJJCLcVsHWF at ssr.fun; no main/staging merge or Mainnet upgrade.

## Code touched
Only status, decision, runbook and JSON evidence. No functional code changes.

## Repositories / environments adjusted
Isolated git archive linked to existing ssr14/ssr-fun and deployed as preview with unchanged repository vercel.json. No new paid service, cron omission, endpoint removal, env changes or secret values read. Current working-tree project link remains design. Heartbeat finish-ssr-liquidity-launch returned to PAUSED per its stop condition.

## Effect on others — READ THIS
No need to ask Yeh which production project: current authenticated login has access to ssr14/ssr-fun. Its preview endpoint is Vercel-auth protected; authenticated CLI checks work. No JUPITER_API_KEY or HELIUS_MAINNET_RPC_URL in preview environment names. Documented local signer files remain unavailable. Need legitimate upload/Squads/approved-payer signatures, real eligible pool lifecycle checks and complete Jupiter evidence before release. Do not promote design preview around main-only production policy. Unrelated .claude/launch.json remains untouched.

## Verification
READY deployment; release endpoint executionEnabled false. Empty preparation requests to four endpoints produce 400. Browser homepage displays Mainnet; stopped at Terms modal, no acceptance or wallet interaction. Remote build retains known feedback type diagnostics and dependency advisories. Evidence: docs/project/evidence/2026-10-12-liquidity-preview.json.
