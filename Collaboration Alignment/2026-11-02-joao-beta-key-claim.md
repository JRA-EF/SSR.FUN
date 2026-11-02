# Self-serve BETA keys at ssr.fun/beta

- **Date:** 2026-11-02
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/beta-key-claim` (off `main` @ `80fc4c8`)
- **Deployed to:** none yet
- **Decision log:** DEC-0276

## What shipped
A public page at `ssr.fun/beta` (the link for the X announcement). A visitor gives their X handle (email optional) and passes an invisible Vercel BotID check. They get their own BETA key on screen, with Copy, "Enter SSR.fun" (signs them in through the existing gate) and "Share on X". One key per handle: asking again returns the same key. The Coming Soon page's Kit email sign-up is replaced by a "Get your BETA key" button, and its pill now reads "BETA is live".

## Code touched
- `lib/site/session.ts`: issued keys (`generateIssuedKey`, `verifyIssuedKey`, `normalizeIssuedKey`, `issuedSessionAnchor`, `sessionVerificationKeys`). Each key carries an HMAC under `SSR_BETA_ISSUE_SECRET`, so neither the gate nor login reads a database.
- `api/site/login.ts`: accepts issued keys and records first and last redemption on the claim row.
- `middleware.ts`: verifies cookies against `sessionVerificationKeys()`; `/beta`, `/beta.html` and `/api/site/claim` are public.
- `api/site/claim.ts` (new): GET `{open}`; POST claim. BotID, rate limits (5 per 10 min per IP in memory, 10 per day per IP, 2,000 per hour site-wide) and an optional cap.
- `lib/site/betaClaims.ts` and `lib/site/claimPure.ts` (new): Neon table `beta_key_claims` (created on demand; already created in the shared DB) and the input rules.
- `beta.html` and `src/beta/main.ts` (new Vite entry), `vite.config.ts`, `vercel.json` (`/beta` rewrite), `public/coming-soon.html`.
- `tools/feedback-sheet/Code.gs` and README: `beta-claim` action, which writes to a "Beta keys" tab.
- `tests/phase_beta_claim.mjs` (new).

## Repositories / environments adjusted
- Neon: table `beta_key_claims` created (empty).
- Vercel env, still TO DO, `ssr-fun` Production only: `SSR_BETA_ISSUE_SECRET` (random), `SSR_BETA_CLAIM_ENABLED=true`, optionally `SSR_BETA_CLAIM_CAP`. Never on staging; without the secret the page shows "not open yet".
- Apps Script: the updated `Code.gs` is NOT pushed yet (clasp login expired). Until it is, claims stay in Neon with `sheet_synced=false`; after the push, each new claim copies up to 3 missed rows.

## Effect on others — READ THIS
- Rotating or removing `SSR_BETA_ISSUE_SECRET` revokes every issued key and session at once. `SSR_REVOKED_BETA_KEYS` (comma list) refuses single keys at login.
- Handles are self-reported (Creator's call): typing a handle that already has a key shows that key.
- `SSR_BETA_KEYS` and `SSR_TEAM_KEYS` and their sessions are unchanged.

## Verification
- `tsc -b` clean. `tests/phase_beta_claim.mjs` and `tests/phase_beta_gate.mjs`: 29 passing. Offline suite: 1,796 passing, the 5 known baseline failures.
- Local end-to-end run of the claim and login handlers against Neon: new claim 201; same handle in other case returns the same key; bad handle 400; a typed key (lowercase, spaces) logs in; a tampered key 401. Test rows deleted.
- Headless Edge screenshots of `/beta` (desktop, 520px) and Coming Soon.
