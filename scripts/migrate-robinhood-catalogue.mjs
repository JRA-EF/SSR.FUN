// One-time (idempotent, safe to re-run) migration creating the Robinhood
// Chain asset catalogue tables (lib/robinhood/schema.sql). No seeding: run
// scripts/robinhood-catalogue-backfill.mts once afterwards, then the daily
// api/robinhood/catalogue-refresh-cron.ts keeps it fresh.
//
// Usage: node scripts/migrate-robinhood-catalogue.mjs
// Requires DATABASE_URL (from `vercel env pull .env.local`) -- mirrors
// scripts/migrate-launchpads.mjs's exact pattern.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function loadEnvLocal() {
  const envPath = path.join(root, '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '').replace(/\r$/, '')
  }
}
loadEnvLocal()

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (run `vercel env pull .env.local` first).')
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

async function main() {
  console.log(`Applying lib/robinhood/schema.sql to ${new URL(process.env.DATABASE_URL).host} ...`)
  const ddl = fs.readFileSync(path.join(root, 'lib', 'robinhood', 'schema.sql'), 'utf8')
  const statements = ddl
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const stmt of statements) await sql.query(stmt)
  const [{ n }] = await sql`select count(*)::int as n from robinhood_asset_catalogue`
  const [state] = await sql`select last_scanned_block::text as b from robinhood_catalogue_state where id = 1`
  console.log(`Done. ${n} token row(s); scan is at block ${state ? state.b : '(never run)'}.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
