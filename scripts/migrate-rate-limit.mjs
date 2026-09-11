// One-time (idempotent, safe to re-run) migration for the durable rate
// limiter. Applies lib/rate-limit/schema.sql (the rate_limit_window table).
// No seeding -- rows are created lazily on first request per key.
//
// Usage: node scripts/migrate-rate-limit.mjs
// Requires DATABASE_URL (from `vercel env pull .env.local`, already present
// after the Neon Marketplace integration was connected to this project --
// see scripts/migrate-road-to-mainnet.mjs, which uses the exact same
// DATABASE_URL and migration pattern this mirrors).

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
  const schemaSql = fs.readFileSync(path.join(root, 'lib/rate-limit/schema.sql'), 'utf8')
  const statements = schemaSql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) await sql.query(stmt)
  console.log('Schema applied.')

  const tables = await sql.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('rate_limit_window') order by table_name`,
  )
  console.log(`Confirmed tables present: ${tables.map(t => t.table_name).join(', ') || '(none found!)'}`)
  console.log('Done.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
