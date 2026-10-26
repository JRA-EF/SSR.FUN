# In-app feedback: corner button, post-action star prompt, #/feedback page -> Google Sheet

- **Date:** 2026-10-26
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/user-feedback` (cut from main 15e59c8), not merged into main yet
- **Deployed to:** staging `dpl_8jW8KbkfcGguLnWK2HoKdv4ENscz` (strategic-super-reserve.fun, bundle assets/main-BwvjRTNI.js), branch @ 5276d46. Not production.
- **Decision log:** DEC-0258

## What shipped
- A **Feedback** button in the bottom-right corner of every app page. Its small x hides it for 7 days.
- After a confirmed **mint, redemption, rebalance, Reserve launch or liquidity action**, a centered "How did we do?" card with 5 stars appears, at most once a day per browser. Picking a star opens the feedback page with that rating filled in.
- **#/feedback**: 1-5 stars (required), an optional explanation capped at 500 characters with a counter, an optional screenshot (resized in the browser to 1600 px JPEG), then a thank-you screen that goes back to where the user was.
- Each submission becomes a row in the Google Sheet **SSR.FUN User Feedback Log** (Drive: SSR.FUN / SSR.FUN User Feedback), with screenshots saved to its **Snapshots** folder and linked from the row. Everything is owned by joao@enigma-fund.com.

## Code touched
- `src/merge/lib/feedback.ts`: prompt event, cooldowns, screenshot resize, submit call
- `src/merge/components/feedback/FeedbackLauncher.tsx`, `StarRating.tsx`: corner button + prompt card
- `src/merge/pages/Feedback.tsx`, `src/App.tsx`: the page and its route; launcher mounted once
- `DTRDetail.tsx`, `ManageDTR.tsx`, `CreateDTR.tsx`, `LiveLiquiditySection.tsx`: one `requestActionFeedback(...)` call on each success path
- `api/feedback/experience.ts` + `lib/agent-feedback/experiencePure.ts`: validation, rate limits, forward to the Apps Script
- `tools/feedback-sheet/Code.gs` + `README.md`: the Apps Script and its setup

## Repositories / environments adjusted
- Vercel `ssr-fun-staging`: new env `FEEDBACK_SHEET_SECRET` (Production). `FEEDBACK_SHEET_WEBHOOK_URL` is added once the Apps Script is deployed.
- Google Drive (joao@enigma-fund.com): folder `SSR.FUN User Feedback`, subfolder `Snapshots`, Sheet `SSR.FUN User Feedback Log`.

## Effect on others: READ THIS
- To add the prompt to another core action, call `requestActionFeedback("<action>")` from `@/lib/feedback` on its success path, and add the action to the lists in `feedback.ts` and `experiencePure.ts`.
- The endpoint sits behind the beta gate on purpose. Do not add it to the middleware's public list.
- The old public `/feedback` form (Telegram fixer pipeline) is separate and unchanged. `#/feedback` (hash route) is the new page.
- Production needs both env vars on `ssr-fun` and a merge of this branch into main.

## Verification
`tsc -b` clean, `vite build` clean, validation checks pass (rating range, 500-character cap, screenshot type and size, formula-safe cells). Headless Chrome renders of the corner button, the prompt and the page.

- **Follow-up 2026-10-26 (DEC-0259):** the page now has a required one-line summary ("What stood out?", 150 characters) and an optional "Tell us more" (1,000 characters). Everything sits behind the build flag `VITE_ENABLE_FEEDBACK=true`, which is set ONLY on the production project `ssr-fun` along with `FEEDBACK_SHEET_WEBHOOK_URL` and `FEEDBACK_SHEET_SECRET`. Staging has none of them and shows no feedback UI. Rows go to the Sheet "SSR.FUN feedback sheet" (1CcPwOu3...), and screenshots go to "SSR.FUN feedback snapshots". Merged into main; production and staging deploy ids are in the commit that follows.
- **Follow-up 2026-10-26 (deploys):** production `dpl_DkwadUwkXvfv3KEhWD6UBuKWdeq9` (ssr.fun, main 4710a57, bundle main-DaBJ6zoa.js includes the feedback UI). Staging `dpl_7AWkVmSrf7uFsPqQGD4jgfhjL3M9` (main b1bc3a5, bundle main-Cy9vlasq.js, no feedback UI, `FEEDBACK_SHEET_*` removed from ssr-fun-staging). b1bc3a5 only changes a type narrowing in api/feedback/experience.ts and goes to production with the next deploy.
