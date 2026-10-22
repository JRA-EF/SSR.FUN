// One-time (idempotent, safe to re-run) migration for the DEX volume index (DEC-0254)
// store. Applies lib/dex-volume/schema.sql. No seeding -- rows are
// filled by api/kpis/dex-volume-cron.ts from its next run onward.
//
// Usage: node scripts/migrate-dex-volume.mjs
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

async function main() {
  console.log(`Applying dex-volume schema to ${new URL(process.env.DATABASE_URL).host} ...`)
  const schemaSql = fs.readFileSync(path.join(root, 'lib/dex-volume/schema.sql'), 'utf8')
  // Same split as scripts/migrate-warm-cache.mjs -- one statement per
  // `;\n`; leading `--` comments stay attached and Postgres ignores them.
  const statements = schemaSql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)
  for (const stmt of statements) await sql.query(stmt)
  const tables = await sql.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('dex_pools','dex_pool_swaps')`,
  )
  console.log(`Done. Confirmed table present: ${tables.map((t) => t.table_name).join(', ') || '(none found!)'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
