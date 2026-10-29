# Command center tracks Helius credit usage

- **Date:** 2026-10-29
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` @ `b6a664b` (+ this entry)
- **Deployed to:** production `dpl_4KrwdK9xSWBbnQuQTUSeZxczsvwF` (2026-10-29; `--skip-domain` checks: cron dry run 200, command center 401). Rollback: `vercel promote dpl_41Q6htYicCrzZusojV7VKCacYAeR`.
- **Env:** new Production var `HELIUS_PROJECT_ID` (the project id in the Helius dashboard URL; not a secret).
- **Decision log:** none

## What shipped
- `lib/command-center/probes.ts` `probeHeliusUsage()`: `GET admin-api.helius.xyz/v0/admin/projects/{id}/usage` using the existing RPC key, sent as the `X-Api-Key` header (never in the URL or on the page).
- Helius card: credits used / plan limit (%), the projected total at the reset at this pace, the reset date, prepaid credits left, top products, and the plan name. The plan's billing date is added to Renewals.
- Tones (`creditTone` in `model.ts`): warn at 80% used or when the pace runs out before the reset; down once the plan and prepaid credits are both used up (RPC then returns 429).

## Found on the first read
- Cycle 2026-10-11 to 2026-11-11, plan `developer_v4`: 7.93M of 10M credits used (79%), almost all RPC. At this pace the plan runs out around 2026-11-04. The 1.65M prepaid credits then cover about 2 more days. The card is amber now.

## Effect on others
- None in the app.
