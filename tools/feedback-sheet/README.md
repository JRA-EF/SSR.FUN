# In-app feedback -> Google Sheet

The "How did we do?" prompt, the corner Feedback button and the `#/feedback`
page (DEC-0258) post to `api/feedback/experience.ts`. That function forwards
each submission to a Google Apps Script web app, `Code.gs` here, which runs as
joao@enigma-fund.com. The script:

- saves the snapshot, if there is one, to Drive: `SSR.FUN / SSR.FUN User Feedback / Snapshots`
- appends one row to the Sheet `SSR.FUN User Feedback Log`, in the same folder, with a link to the snapshot

Snapshots stay private to the folder's owner and the people it is shared with.

| What | Drive id |
|---|---|
| Folder `SSR.FUN User Feedback` | `1kCU5hGBYt9HdEWD8Jfk-d6IWSW5uyTXj` |
| Folder `Snapshots` | `1jYSgFDtBzItcoSdnSlaxJgZ4asVxWo98` |
| Sheet `SSR.FUN User Feedback Log` | `1cUIdeTSDXWCrr-2ueiq0AvjXN0hAYc-T0cp6N71Zf3U` |

## One-time setup (owner's Google account)

1. Open the Sheet, then **Extensions -> Apps Script**. Replace the editor's contents with `Code.gs` and save.
2. **Project Settings -> Script Properties -> Add**: `FEEDBACK_SECRET` = the same value as the Vercel env `FEEDBACK_SHEET_SECRET`.
3. **Deploy -> New deployment -> Web app**. Execute as **Me**, who has access **Anyone**. Authorize when asked (Drive + Sheets).
4. Copy the `https://script.google.com/macros/s/.../exec` URL into the Vercel env `FEEDBACK_SHEET_WEBHOOK_URL` (Production) on `ssr-fun-staging`, and later `ssr-fun`, then redeploy.

"Anyone" is required so the Vercel function can call the script without a
Google login; the shared secret is what keeps other callers out.

After editing `Code.gs`, use **Deploy -> Manage deployments -> Edit -> New
version** so the `/exec` URL stays the same.

## Env vars

| Name | Where | Value |
|---|---|---|
| `FEEDBACK_SHEET_WEBHOOK_URL` | Vercel (per project) | the script's `/exec` URL |
| `FEEDBACK_SHEET_SECRET` | Vercel (per project) + Script Properties | a random string, same in both places |

Without both, the endpoint answers 503 and the page shows "Feedback is temporarily unavailable".
