# Keeper: basket feed no longer fails on "Block not available"

- **Date:** 2026-11-16
- **Author:** Boss via Claude Code (Fable 5.2)
- **Branch / commits:** `main` (this commit); `design` fast-forwarded
- **Deployed to:** none yet. Production still runs `dpl_CRAF6KAuAXmxdR6CQyxffsUfiDPt` (`main` @ `01b6ffa`), so the hourly failures continue until the next production deploy.
- **Decision log:** none (bug fix, no behaviour decision)

## What shipped
The hourly fee keeper's basket-feed step asked for the block time of the slot it had just read at `confirmed`. The RPC often cannot serve that block yet, so 0 to 3 Reserves an hour failed with "failed to get block time for slot N: Block not available" and waited for the next run. The step now steps back to an older slot (4, 16, then 64 slots) before falling back to the wall clock.

## Code touched
- `lib/mainnet/basketFeed.ts` — new exported `recentBlockTime(connection, slot)`; the feed uses it for the release maths.
- `tests/phase_basket_feed_block_time.ts` — new, 4 tests.

## Repositories / environments adjusted
- SSR.FUN only. No env, database or on-chain change.

## Effect on others — READ THIS
- An older slot's time is at most about 26 seconds behind, so a run can release marginally less than before; the next run picks up the rest. It never releases more.
- `isTransientRpcError` still treats this message as transient. Once this is live the keeper summary should read `failures 0` on most runs; a non-zero count then deserves a look.
- Evidence of the old pattern: function logs for `/api/mainnet/fee-settlement-cron`, 2026-11-15 15:15 UTC to 2026-11-16 15:15 UTC, 21 of 25 runs with 1 to 3 such failures across seven Reserves.

## Verification
- New tests 4 passing; offline suite 1839 passing, the 5 known failures (`-t 1000000`); `tsc -b`, oxlint and `npm run build` clean.
- Not yet observed in production (not deployed).

- **Follow-up 2026-11-16 (same author): deployed.** Production `dpl_3kV2SEFja7EXZszHziDUscwnX9gv` (`main` @ `24f3560`, 15:49 UTC); rollback `dpl_CRAF6KAuAXmxdR6CQyxffsUfiDPt`. The 16:15 UTC keeper run reported `settled 3/53, failures 0`. 4 of the previous 25 runs were also clean, so watch the count over the next day before calling it confirmed.
