# Feedback anti-spam cap: 1 per 5 minutes, 3 per day, per IP

- **Date:** 2026-10-26
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (follow-up to the in-app feedback entry of the same day)
- **Deployed to:** production `dpl_HCqAdtWumjFCiuRiC6i5N8pGE7Ke` (ssr.fun, main ea593e9). Staging has feedback switched off, so nothing changes there.
- **Decision log:** DEC-0260

## What shipped
In-app feedback (`POST /api/feedback/experience`) now accepts at most 1 submission per IP every 5 minutes and 3 per IP every 24 hours. People who hit a limit see "You can send feedback once every 5 minutes" or "You can send up to 3 pieces of feedback a day" on the page.

## Code touched
- `api/feedback/experience.ts`: new windows, checked shortest first so a refused attempt does not use a daily slot

## Repositories / environments adjusted
- None (same Neon `rate_limit_window` table, new keys `feedback-experience:ip5m:*`, `feedback-experience:ipday:*`).

## Effect on others: READ THIS
- People sharing one IP (an office, a VPN) share the 3 per day.
- The old public `/feedback` form keeps its own limits (api/feedback/submit.ts); this change does not touch it.

## Verification
Ran the real handler against Neon with a local stub in place of the Sheet: 201, then 429 (Retry-After 300); an invalid body gets 400 without using a slot; the 4th request in a day is refused. `tsc -b` clean.
