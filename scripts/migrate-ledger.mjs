// One-time (idempotent, safe to re-run) migration for the SSR Ledger.
// Applies lib/ledger/schema.sql. Mirrors scripts/migrate-reserve-activity.mjs
// exactly (same DATABASE_URL, same migration pattern).
//
// Usage: node scripts/migrate-ledger.mjs
// Requires DATABASE_URL (from `vercel env pull .env.local`).

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

const EXPECTED_TABLES = [
  'ledger_deployments',
  'ledger_reserves',
  'ledger_reserve_delegates',
  'ledger_asset_catalogue',
  'ledger_jupiter_snapshots',
  'ledger_jupiter_snapshot_mints',
  'ledger_events',
  'ledger_product_events',
  'ledger_daily_rollups',
  'ledger_incidents',
  'ledger_ingestion_cursors',
  'ledger_reconciliation_runs',
]

async function main() {
  console.log(`Applying SSR Ledger schema to ${new URL(process.env.DATABASE_URL).host} ...`)
  const schemaSql = fs.readFileSync(path.join(root, 'lib/ledger/schema.sql'), 'utf8')
  const statements = schemaSql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) await sql.query(stmt)
  console.log(`Applied ${statements.length} statements.`)

  const tables = await sql.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_name = ANY($1) order by table_name`,
    [EXPECTED_TABLES],
  )
  const found = tables.map(t => t.table_name)
  const missing = EXPECTED_TABLES.filter(t => !found.includes(t))
  console.log(`Confirmed present: ${found.join(', ')}`)
  if (missing.length > 0) {
    console.error(`MISSING (migration did not fully apply): ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log('Done -- all ledger tables present.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
