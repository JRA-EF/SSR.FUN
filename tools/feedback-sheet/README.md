# In-app feedback -> Google Sheet

The "How did we do?" prompt, the corner Feedback button and the `#/feedback`
page (DEC-0258) post to `api/feedback/experience.ts`. That function forwards
each submission to a Google Apps Script web app, `Code.gs` here, which runs as
joao@enigma-fund.com. The script:

- saves the snapshot, if there is one, to the Drive folder `SSR.FUN / SSR.FUN feedback snapshots`
- appends one row to the Sheet `SSR.FUN / SSR.FUN feedback sheet`, with a link to the snapshot

Snapshots stay private to the folder's owner and the people it is shared with.

| What | Drive id |
|---|---|
| Sheet `SSR.FUN feedback sheet` | `1CcPwOu3bZqECxNbE4neOkEeBY0mX1UD70SvBnB08Ygc` |
| Folder `SSR.FUN feedback snapshots` | `1jYSgFDtBzItcoSdnSlaxJgZ4asVxWo98` |
| Apps Script `SSR.FUN feedback webhook` (standalone, in the SSR.FUN folder) | `1kl5ED_G-fPaeRnu9d0ifi8X91QUYc4_k9Wxl8cThwcjIDHgQ9JBzK5z_` |

The web app deployment id is `AKfycbwu1Q2WVwTLvzvPjexjUjEsyT6Y1tkpzNIhS6gw3GXosTgxjf2DSYaKdiQ9L0_o0zVCkg`; its `/exec` URL is in the Vercel env.

## Updating the deployed script (how it was set up on 2026-10-26)
With `npx @google/clasp@2.4.2` logged in as the owner (Apps Script API switched on at script.google.com/home/usersettings): put `Code.gs`, a `Secret.gs` holding `var FEEDBACK_SECRET_INLINE = "<FEEDBACK_SHEET_SECRET>";` (never commit it) and an `appsscript.json` with scopes `spreadsheets` + `drive` and `webapp: {executeAs: USER_DEPLOYING, access: ANYONE_ANONYMOUS}` in a folder with `.clasp.json` = `{"scriptId":"1kl5ED_G-..."}`, then `clasp push --force` and `clasp deploy -i <deployment id>` (keeps the same URL). Opening the `/exec` URL once as the owner grants the Sheets/Drive permission.

## Other actions (same secret)
- `{action: "stats"}` returns the counts the command center shows; each open row carries its Sheet `row` (v6, 2026-10-30) so the command center's Resolve buttons can call `set-status`.
- `{action: "set-status", status, rows: [{row, at}]}` sets the Status column. `status` must be one of the dropdown choices, and a row is written only when its Received cell still equals `at`. Live as version 5, 2026-10-27; the 5 setup and test rows were marked Test with it.

## Manual alternative (no clasp, from the Sheet)

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
| `VITE_ENABLE_FEEDBACK` | Vercel `ssr-fun` Production ONLY | `true` (build-time; shows the button, prompt and page) |

Without both, the endpoint answers 503 and the page shows "Feedback is temporarily unavailable".
