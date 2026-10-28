# Incident: fee keeper's 12:15 UTC run crashed on load (fixed 12:42)

- **Date:** 2026-10-28
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` @ `99d5c76` (fix); cause in `a897263` / `f01f93b`
- **Deployed to:** production `dpl_Cg2mn3ppRet79dnYt5iYKRccrqoW` (promoted 12:42 UTC after a `--skip-domain` build was checked). Rollback in between: promoted `dpl_GBqCp45D` at 12:35.
- **Decision log:** none

## What happened
- The burn-rate work (`a897263`, live 11:49) imported `lib/command-center/balances` into `api/mainnet/fee-settlement-cron.ts`.
- `api/mainnet` is CommonJS (`{"type":"commonjs"}`). `lib/command-center` is an ES module folder (the root package.json). Vercel's runtime refused the import at load (`ERR_REQUIRE_ESM`), so the hourly keeper run at **12:15 UTC crashed before doing anything**: no settlement, accrual, transfer-fee sweep or basket feed that hour.
- No ops alert fired: the process died before the alert code could load. It was found by checking the runtime logs for the first balance sample.
- tsc (both `tsconfig.node.json` and `api/mainnet/tsconfig.json`) and the tests all passed, because neither models Node's package `type` rule.

## What shipped
- The keeper writes its balance sample with an inline `INSERT` and imports nothing from `lib/command-center`.
- **New guard, `tests/phase_cjs_import_boundary.ts`:** every relative import from a CommonJS API folder (`api/devnet`, `kpis`, `ledger`, `mainnet`, `robinhood`) must land in a `{"type":"commonjs"}` folder. It was checked to fail on the original import.

## Effect on others: READ THIS
- **Code imported by `api/mainnet` and the other CommonJS API folders must live in a folder whose package.json says `{"type":"commonjs"}`** (`lib/ops-alerts`, `lib/ledger`, `lib/mainnet`, `src/merge/lib`, ...). The new test enforces this.
- **A cheap way to prove a function loads before going live:** `vercel --prod --skip-domain`, then `vercel curl "/api/mainnet/fee-settlement-cron?dryRun=true" --deployment <url>`. A crash answers 500; a loaded function answers 200 (or 401 for authenticated routes). Then `vercel promote <dpl>`.
- The 13:15 run loaded and ran on the fixed deploy (logs from 13:15:34). Settlement work is idempotent and retried each hour, so the skipped 12:15 run only delays it.
- **Separate, pre-existing problem found while checking:** the keeper's Jupiter quotes and swap builds get HTTP 429 "Too many requests" constantly: 431 of them on yesterday's deploy between 06:00 and 11:50 today, before any of this, and again in the 13:15 run. The production `JUPITER_API_KEY` is probably not on the paid Developer plan (its billing page showed 0 credits used). Fee swaps that hit 429 are retried next run, but they may be stuck. Being looked at with the Creator.

## Verification
- Before promoting: dry-run on the new build answered 200 (the broken build answers 500); `/api/dashboard/commandcenter?check=1` answered 401 (handler loaded).
- After promoting: the live ssr.fun dry run answered 200, and the 13:15 cron run executed on `dpl_Cg2mn3pp` (no load error).
- 25 tests passing (boundary, command center, burn rate, ops alerts); both tsc projects clean; oxlint clean.
