// One-time (idempotent, safe to re-run) migration adding the `cluster`
// column to reserve_activity_log / reserve_activity_cursor (DEC-0175) --
// re-applies lib/reserve-activity/schema.sql, whose statements are all
// IF NOT EXISTS / ADD COLUMN IF NOT EXISTS. Existing rows default to
// 'devnet' (they all genuinely came from DevNet indexing); no seeding.
//
// Usage: node scripts/migrate-reserve-activity-cluster.mjs
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

async function main() {
  console.log(`Applying schema to ${new URL(process.env.DATABASE_URL).host} ...`)
  const schemaSql = fs.readFileSync(path.join(root, 'lib/reserve-activity/schema.sql'), 'utf8')
  const statements = schemaSql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) await sql.query(stmt)
  console.log('Schema applied.')

  const logCols = await sql`select column_name from information_schema.columns where table_name = 'reserve_activity_log' and column_name = 'cluster'`
  const curCols = await sql`select column_name from information_schema.columns where table_name = 'reserve_activity_cursor' and column_name = 'cluster'`
  if (logCols.length !== 1 || curCols.length !== 1) {
    console.error('Verification failed: cluster column missing after migration.')
    process.exit(1)
  }
  const [counts] = await sql`
    select
      (select count(*)::int from reserve_activity_log) as log_rows,
      (select count(*)::int from reserve_activity_log where cluster = 'devnet') as log_devnet,
      (select count(*)::int from reserve_activity_cursor) as cursor_rows,
      (select count(*)::int from reserve_activity_cursor where cluster = 'devnet') as cursor_devnet
  `
  console.log(`Verified: cluster column present on both tables. log rows ${counts.log_rows} (${counts.log_devnet} devnet), cursor rows ${counts.cursor_rows} (${counts.cursor_devnet} devnet).`)
}

main().catch((e) => {
  console.error('Migration failed:', e)
  process.exit(1)
})
