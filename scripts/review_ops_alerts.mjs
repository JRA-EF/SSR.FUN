#!/usr/bin/env node
// DEC-0264: the review queue behind /internal/commandcenter's "not yet reviewed
// by Claude" count. Each kind of failure (an ops_alerts fingerprint) stays in
// the queue until someone investigates it and marks it reviewed here; if it
// happens again after the review, it comes back.
//
//   node scripts/review_ops_alerts.mjs                 list what is waiting, newest first
//   node scripts/review_ops_alerts.mjs --show <n>      full recent events of item n
//   node scripts/review_ops_alerts.mjs --ack <n|all> --note "what it was, what was done" [--by name]
//
// Needs DATABASE_URL (read from the repo's .env.local when not set).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.DATABASE_URL) {
  try {
    // A worktree has no .env.local of its own; fall back to the main checkout's.
    const common = path.resolve(repo, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim())
    const file = [path.join(repo, '.env.local'), path.join(path.dirname(common), '.env.local')].find((p) => fs.existsSync(p))
    const m = file && fs.readFileSync(file, 'utf8').match(/^DATABASE_URL="?(.*?)"?$/m)
    if (m) process.env.DATABASE_URL = m[1]
  } catch { /* handled below */ }
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set and .env.local has none.'); process.exit(1) }
const { neon } = createRequire(path.join(repo, 'package.json'))('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL)

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

await sql`CREATE TABLE IF NOT EXISTS ops_alert_reviews (
  fingerprint text PRIMARY KEY, reviewed_at timestamptz NOT NULL DEFAULT now(), reviewed_by text NOT NULL, note text)`
const queue = await sql`
  SELECT a.fingerprint, a.source, a.step, a.first_seen, a.last_seen,
    (SELECT count(*) FROM ops_alert_events e WHERE e.fingerprint = a.fingerprint AND (r.reviewed_at IS NULL OR e.at > r.reviewed_at))::int AS since,
    (SELECT message FROM ops_alert_events e WHERE e.fingerprint = a.fingerprint ORDER BY e.at DESC LIMIT 1) AS message,
    r.reviewed_at, r.note
  FROM ops_alerts a LEFT JOIN ops_alert_reviews r ON r.fingerprint = a.fingerprint
  WHERE r.reviewed_at IS NULL OR a.last_seen > r.reviewed_at
  ORDER BY a.last_seen DESC`

const show = arg('--show')
const ack = arg('--ack')
if (show) {
  const q = queue[Number(show) - 1]
  if (!q) { console.error('No such item.'); process.exit(1) }
  const events = await sql`SELECT at, site, reserve, ticker, wallet, signature, page, message FROM ops_alert_events WHERE fingerprint = ${q.fingerprint} ORDER BY at DESC LIMIT 10`
  console.log(`${q.source} · ${q.step}\nfingerprint: ${q.fingerprint}\n`)
  for (const e of events) console.log(JSON.stringify(e))
} else if (ack) {
  const note = arg('--note')
  if (!note) { console.error('--note is required: say what it was and what was done.'); process.exit(1) }
  const by = arg('--by') ?? 'Claude'
  const targets = ack === 'all' ? queue : [queue[Number(ack) - 1]].filter(Boolean)
  if (!targets.length) { console.error('Nothing to mark.'); process.exit(1) }
  for (const q of targets) {
    await sql`INSERT INTO ops_alert_reviews (fingerprint, reviewed_at, reviewed_by, note) VALUES (${q.fingerprint}, now(), ${by}, ${note})
      ON CONFLICT (fingerprint) DO UPDATE SET reviewed_at = now(), reviewed_by = EXCLUDED.reviewed_by, note = EXCLUDED.note`
  }
  console.log(`Marked ${targets.length} reviewed by ${by}.`)
} else {
  if (!queue.length) console.log('Nothing waiting: every error kind has been reviewed since it last happened.')
  queue.forEach((q, i) => {
    console.log(`${i + 1}. [${q.source}/${q.step}] ${q.since}x since ${q.reviewed_at ? 'last review' : 'first seen'} · last ${new Date(q.last_seen).toISOString().slice(0, 16)}Z`)
    console.log(`   ${String(q.message ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
    if (q.note) console.log(`   previous review: ${q.note}`)
  })
}
