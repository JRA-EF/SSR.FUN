// /api/site/claim -- PUBLIC self-serve BETA key claim (DEC-0276), posted by
// the /beta page (beta.html, src/beta/main.ts).
//
//   GET  -> { open: boolean }   whether claiming is switched on here
//   POST { handle, email? } -> { ok, key, handle, alreadyClaimed }
//
// One key per X handle (case-insensitive): asking again for the same handle
// returns the same key, so a refresh never burns a second one. The key is an
// ISSUED key (lib/site/session.ts): the gate verifies it by its MAC, so this
// table is bookkeeping, not part of the access check. Handles are
// self-reported (Creator decision, 2026-11-02).
//
// Each claim is stored in Neon (beta_key_claims, the source of truth) and
// copied as a new row of the team's key inventory Sheet ("SSR.fun BETA Access
// Keys (master)", with X handle and Email columns) through the same
// Apps Script web app as api/feedback/experience.ts. A failed Sheet write
// never withholds the key; the row stays sheet_synced = false and is copied
// later (when that handle asks again, or as catch-up after a later claim).
//
// Env:
//   SSR_BETA_CLAIM_ENABLED = 'true'  switches claiming on (ssr.fun Production only)
//   SSR_BETA_ISSUE_SECRET            signs issued keys (also read by login + middleware)
//   SSR_BETA_CLAIM_CAP (optional)    stop issuing NEW keys after this many claims
//   FEEDBACK_SHEET_WEBHOOK_URL / FEEDBACK_SHEET_SECRET  the Sheet copy (optional)
//
// Protected like api/feedback/submit.ts: Vercel BotID (invisible human check)
// plus per-IP and global rate limits held in Neon.
import type { IncomingHttpHeaders } from 'node:http'
import { checkBotId } from 'botid/server'
import { checkBurstWindow, checkDurableWindow } from '../../lib/agent-feedback/rateLimit.js'
import { parseBetaClaim, sheetSafe } from '../../lib/site/claimPure.js'
import { generateIssuedKey, issuedKeySecret } from '../../lib/site/session.js'
import { addEmailIfMissing, countClaims, findClaim, insertClaim, listUnsynced, markSheetSynced, type ClaimRow } from '../../lib/site/betaClaims.js'

interface Req { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> }
interface Res {
  status: (n: number) => Res
  json: (b: unknown) => void
  setHeader: (k: string, v: string) => void
  end: () => void
}

const BURST_WINDOW_MS = 10 * 60_000
const BURST_MAX = 5
const IP_DAY_WINDOW_MS = 24 * 60 * 60_000
const IP_DAY_MAX = 10
const GLOBAL_WINDOW_MS = 60 * 60_000
const GLOBAL_MAX = 2000
const SHEET_CATCHUP = 3

function parseBody(req: Req): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return {} } }
  return {}
}
function header(req: Req, name: string): string {
  const v = req.headers?.[name]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}
function claimingOpen(): boolean {
  return process.env.SSR_BETA_CLAIM_ENABLED === 'true' && !!issuedKeySecret()
}
function claimCap(): number | null {
  const n = Number(process.env.SSR_BETA_CLAIM_CAP)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

async function copyToSheet(row: ClaimRow, site: string, userAgent: string): Promise<boolean> {
  const webhook = process.env.FEEDBACK_SHEET_WEBHOOK_URL
  const secret = process.env.FEEDBACK_SHEET_SECRET
  if (!webhook || !secret) return false
  try {
    // Apps Script answers a POST with a 302 to a one-time result URL; fetch follows it.
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        action: 'beta-claim',
        claimedAt: row.createdAt,
        handle: sheetSafe('@' + row.handle),
        email: sheetSafe(row.email ?? ''),
        key: row.betaKey,
        site,
        userAgent: sheetSafe(userAgent.slice(0, 300)),
      }),
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    })
    const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!r.ok || !j?.ok) {
      console.error('[site/claim] sheet write failed:', r.status, j?.error ?? '(no JSON reply)')
      return false
    }
    return true
  } catch (e) {
    console.error('[site/claim] sheet request failed:', e instanceof Error ? e.message : e)
    return false
  }
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET') { res.status(200).json({ open: claimingOpen() }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return }
  if (!claimingOpen()) { res.status(503).json({ error: 'BETA keys aren’t being handed out right now. Check back soon.' }); return }

  // --- Rate limits: in-memory burst first, then the Neon windows ---
  const ip = header(req, 'x-forwarded-for').split(',')[0].trim() || 'unknown'
  const refuse = (retryAfterS: number, error: string) => {
    res.setHeader('Retry-After', String(retryAfterS))
    res.status(429).json({ error })
  }
  if (!checkBurstWindow(`beta-claim:${ip}`, BURST_WINDOW_MS, BURST_MAX)) return refuse(600, 'Too many tries from your network. Please wait a few minutes.')
  if (!(await checkDurableWindow(`beta-claim:ipday:${ip}`, IP_DAY_WINDOW_MS, IP_DAY_MAX)).allowed) return refuse(86_400, 'Your network has claimed the most keys allowed today. Please try again tomorrow.')
  if (!(await checkDurableWindow('beta-claim:global', GLOBAL_WINDOW_MS, GLOBAL_MAX)).allowed) return refuse(3600, 'Lots of people are claiming keys right now. Please try again in a little while.')

  // --- Human check (Vercel BotID) ---
  try {
    const bot = await checkBotId({ advancedOptions: { headers: req.headers as IncomingHttpHeaders } })
    if (bot.isBot && !bot.isVerifiedBot) { res.status(403).json({ error: 'We couldn’t confirm you’re human. Reload the page and try again.' }); return }
  } catch (e) {
    // Fail closed: a misconfigured check must never hand keys to bots.
    console.error('[site/claim] BotID check failed:', e instanceof Error ? e.message : e)
    res.status(503).json({ error: 'Key claiming is temporarily unavailable. Please try again shortly.' })
    return
  }

  const parsed = parseBetaClaim(parseBody(req))
  // Explicit `=== false`: Vercel's build typecheck does not narrow on `!parsed.ok`.
  if (parsed.ok === false) { res.status(400).json({ error: parsed.error }); return }
  const input = parsed.value
  const site = header(req, 'host')
  const userAgent = header(req, 'user-agent')

  try {
    let row = await findClaim(input.handleLower)
    let created = false
    if (row) {
      if (input.email && !row.email) { await addEmailIfMissing(input.handleLower, input.email); row = { ...row, email: input.email } }
    } else {
      const cap = claimCap()
      if (cap !== null && (await countClaims()) >= cap) {
        res.status(410).json({ error: 'All BETA keys for this round have been claimed. Follow us on X for the next drop.' })
        return
      }
      const result = await insertClaim({ ...input, betaKey: await generateIssuedKey(issuedKeySecret()), site, userAgent })
      row = result.row
      created = result.created
    }

    // Copy this claim to the Sheet, then catch up a few older ones that missed
    // it (Sheet or script was down). Never blocks or fails the key.
    if (!row.sheetSynced && (await copyToSheet(row, site, userAgent))) {
      await markSheetSynced(input.handleLower)
      for (const old of await listUnsynced(SHEET_CATCHUP)) {
        if (!(await copyToSheet(old.row, '', ''))) break
        await markSheetSynced(old.handleLower)
      }
    }

    res.status(created ? 201 : 200).json({ ok: true, key: row.betaKey, handle: row.handle, alreadyClaimed: !created })
  } catch (e) {
    console.error('[site/claim] claim failed:', e instanceof Error ? e.message : e)
    res.status(500).json({ error: 'We couldn’t create your key just now. Please try again.' })
  }
}
