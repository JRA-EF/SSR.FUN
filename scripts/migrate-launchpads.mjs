// One-time (idempotent, safe to re-run) migration adding launchpad
// provenance columns to ledger_asset_catalogue (see lib/ledger/schema.sql,
// lib/ledger/launchpadClassification.ts, packages/sdk/src/launchpads.ts).
// No seeding: api/ledger/launchpad-classify-cron.ts fills the columns from
// on-chain data over its first few runs.
//
// Usage: node scripts/migrate-launchpads.mjs
// Requires DATABASE_URL (from `vercel env pull .env.local`) -- mirrors
// scripts/migrate-reserve-image.mjs's exact pattern.

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
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}
loadEnvLocal()

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (run `vercel env pull .env.local` first).')
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const STATEMENTS = [
  `alter table ledger_asset_catalogue add column if not exists launchpad text check (launchpad in ('pump.fun', 'letsbonk.fun', 'bags.fm'))`,
  `alter table ledger_asset_catalogue add column if not exists launchpad_stage text check (launchpad_stage in ('bonding', 'graduated'))`,
  `alter table ledger_asset_catalogue add column if not exists launchpad_venue text check (launchpad_venue in ('pumpswap', 'raydium-cpmm', 'raydium-amm-v4', 'meteora-damm-v1', 'meteora-damm-v2'))`,
  `alter table ledger_asset_catalogue add column if not exists launchpad_evidence jsonb`,
  `alter table ledger_asset_catalogue add column if not exists launchpad_checked_at timestamptz`,
  `create index if not exists ledger_asset_catalogue_launchpad_idx on ledger_asset_catalogue (launchpad)`,
]

async function main() {
  console.log(`Applying launchpad columns to ${new URL(process.env.DATABASE_URL).host} ...`)
  for (const stmt of STATEMENTS) await sql.query(stmt)
  const [{ n }] = await sql`select count(*)::int as n from ledger_asset_catalogue where launchpad_checked_at is null and removed_from_catalogue_at is null`
  console.log(`Done. ${n} catalogue mint(s) await classification by /api/ledger/launchpad-classify-cron.`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
