# Liquidity delivery and remaining external release gates

- **Date:** 2026-10-11
- **Author:** Yeh via Codex
- **Branch / commits:** feature/raydium-permissioned-cpmm @ d9196c9, plus this evidence/status commit; PR https://github.com/JRA-EF/SSR.FUN/pull/14 into design
- **Deployed to:** none successfully. Preview attempt dpl_BdzFahQtCXnueLevreMG5wqsTJQT failed at Vercel output deployment.
- **Decision log:** DEC-0236

## What shipped
Source pushed and PR opened. Final 28 focused regressions and app/Mainnet API typechecks passed after the last changes. Existing IDL definitions compared to prior commit: unchanged; six instructions, one account/event and two errors added. Local validator stopped; runtime evidence retained.

## Code touched
Docs/evidence only in this follow-up; implementation remains d9196c9. Added latest read-only permission/Jupiter results and deployment limits to the runbook.

## Repositories / environments adjusted
Only feature branch and isolated /tmp preview packaging. First preview rejected frequent production crons on the Hobby plan. Retried with crons omitted only from the isolated copy (repository unchanged). Build completed, but deployment failed because Hobby permits at most 12 serverless functions. No production alias, env, paid plan, keys or Mainnet state changed. No successful preview URL to advertise.

## Effect on others — READ THIS
Raydium permission/config still verified at slot 455814752; no eligible new Token-2022 Mainnet Reserve among 38 existing Reserves. Partial Jupiter quotes are not full 1/5/10 evidence: unsupported ExactOut routes/429s persist. Program release needs funded upload plus authorized Squads upgrade/IDL authority; pool release needs approved payer operational co-sign access and real eligible pool tests. Browser-wallet verification remains pending. Full preview needs an existing deployment destination with sufficient function capacity or an approved hosting-plan change. Do not silently remove app endpoints to pretend full deployment succeeded.

General repository warnings: four pre-existing chart failures; feedback API unknown-value type diagnostics; dependency audit 31 advisories including inherited shell-quote critical via react-native developer tooling. No direct source imports found; not proof of safety. No dependency updates attempted in this liquidity release.

The finish-ssr-liquidity-launch heartbeat is to be paused after source integration and final status recording because the remaining liquidity release work requires unavailable signer/access/hosting prerequisites. Resume once those are available. Unrelated .claude/launch.json and ManageDTR bug untouched.

## Verification
See docs/project/LIQUIDITY_LAUNCH_RUNBOOK.md and both 2026-10-11 runtime/read-only-refresh evidence files. No Mainnet financial transaction or successful deployment is claimed.
