# In-app feedback: corner button, post-action star prompt, #/feedback page -> Google Sheet

- **Date:** 2026-10-26
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/user-feedback` (cut from main 15e59c8), not merged into main yet
- **Deployed to:** staging (strategic-super-reserve.fun), deploy id in the follow-up commit. Not production.
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
