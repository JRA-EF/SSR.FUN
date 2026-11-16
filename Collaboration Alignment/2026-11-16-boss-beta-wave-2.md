# BETA wave 2: 30 more self-serve keys, plus the RPC 403 failover and /feedback redirect

- **Date:** 2026-11-16
- **Author:** Boss via Claude Code (Fable 5.2), from a brief prepared on Joao's side
- **Branch / commits:** `main` @ `01b6ffa` (fast-forward of `claude/ssr-fun-main-watcher-hb10va` `6a5e678` + `0408e50`, plus one commit); `design` fast-forwarded to the same commit. Status commit follows.
- **Deployed to:** production `dpl_CRAF6KAuAXmxdR6CQyxffsUfiDPt` (2026-11-16 15:06 UTC). Rollback target `dpl_pwDMtR6tWeaFpWMwbupT6qHXPjTX`.
- **Decision log:** DEC-0291 (supersedes DEC-0278's switch-off). Next free id: DEC-0292.

## What shipped
1. Self-serve BETA keys at `ssr.fun/beta` are open for exactly 30 more people. The gated landing page shows "Get your BETA key" again and hides it by itself once the 30 are claimed.
2. Reserve launches no longer fail with "502 Mainnet RPC endpoint unreachable" when Helius refuses the key with a plain-text 403: the proxy now goes to the public endpoint, sends included (`6a5e678`, the 2026-11-14 watcher alerts).
3. `ssr.fun/feedback` and `/feedback.html` redirect to the in-app flow at `/#/feedback` (`0408e50`).

## Code touched
- `public/coming-soon.html` — the button shows only when `/api/site/claim` reports `open` and not `full` (was `open` only).
- `api/mainnet/rpc-proxy.ts` — a refused non-JSON upstream answer keeps its status and fails over at once.
- `api/kpis/dex-volume-cron.ts`, `api/ledger/jupiter-snapshot-cron.ts`, `api/ledger/known-asset-mints.ts`, `api/mainnet/reserve-activity.ts`, `lib/reserve-activity/activityRoute.ts` — use the Mainnet failover connection.
- `vercel.json` — `/feedback` rewrite replaced by two 307 redirects.
- `tests/phase_rpc_failover.ts`, `tests/phase_feedback_redirect.ts` — new.

## Repositories / environments adjusted
- Vercel `ssr-fun` Production: `SSR_BETA_CLAIM_CAP` = 61 (was at or below 31), `SSR_BETA_CLAIM_ENABLED` = true (re-saved, was already on). `SSR_BETA_ISSUE_SECRET` not touched. Nothing on staging.
- Neon: read only. `beta_key_claims` had 31 rows before (first 2026-11-03, last 2026-11-15). No test claim was made.

## Effect on others — READ THIS
- The cap counts TOTAL rows. For another wave set `SSR_BETA_CLAIM_CAP` to the current count plus the wave size and redeploy; no code change is needed.
- Never rotate or remove `SSR_BETA_ISSUE_SECRET`: that revokes every issued key.
- Run the offline suite with `-t 1000000` (as `npm run test:program` does). At mocha's 2 s default, five Jupiter retry tests in `tests/phase_mainnet_production_fixes.ts` time out and look like new failures. Baseline here: 1835 passing, 5 failing (chart selector x2, native-control reset x2, IDL pinning). The two "$0 vs $0.00" failures seen elsewhere did not occur on this machine (Node 24.22.1).
- `claude/ssr-fun-main-watcher-hb10va` is fully merged and can be deleted.
- Not checked from this session because it needs a signed-in BETA session: an existing key signing in, and a `getSlot` POST through `/api/mainnet/rpc-proxy` (it answers 401 without a session, as expected).

## Verification
- `tests/phase_beta_claim.mjs` + `tests/phase_beta_gate.mjs`: 29 passing. Offline suite as above. `npm run build` clean.
- Live after deploy: `GET /api/site/claim` returns `{"open":true,"full":false}` (was `full:true`); logged-out `ssr.fun` serves the page with "BETA is live", the button and the new `j.full` check; `/beta` 200; `/feedback` and `/feedback.html` 307 to `/#/feedback`.
- Keeper on the new deployment: the 15:15 UTC fee-settlement run completed (`/api/mainnet/keeper-watchdog?dryRun=true`: `lastOkAt` 15:15:51, `staleMinutes` null). Its summary reports `failures 2` against `failures 1` in the 14:15 run on the previous deployment; not investigated here.

- **Follow-up 2026-11-16 (same author): rollback target corrected, keeper failures explained.**
  - The rollback target is `dpl_6tD4jfeLZbzGPuZYaUSfiK2dTfh3` (`main` @ `82f94b3`), not `dpl_pwDMtR6t`. Function logs show ssr.fun's crons running on `dpl_6tD4jfeL` until 14:15 UTC today; `dpl_pwDMtR6t` (2026-11-14) has no ssr.fun alias. So this deployment is also the first to serve `ab8e41b` (the first RPC failover commit). Why the 2026-11-14 deployment was never promoted is not known.
  - The keeper's `failures 2` is not from this deploy. Every hourly run since at least 2026-11-15 15:15 UTC logs 0 to 3 `basket-feed` failures, all "failed to get block time for slot N: Block not available", on a rotating set of seven Reserves. Cause: `lib/mainnet/basketFeed.ts:147` asks for the block time of the slot it just read at `confirmed`, which the RPC often cannot serve yet. The error is classed transient, so no alert is raised; the Reserve's feed step is skipped for that hour and retried the next. Settlement and accruals are unaffected (3 settled, 0 settlement failures in every run). Not fixed here.
