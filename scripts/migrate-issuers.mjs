// One-time (idempotent, safe to re-run) migration adding tokenised-asset
// issuer columns to ledger_asset_catalogue (see lib/ledger/schema.sql,
// packages/sdk/src/issuers.ts). No seeding: lib/ledger/markIncompatibleMints.ts
// fills them from on-chain data on its next run, in the same account read it
// already does for extension compatibility.
//
// Usage: node scripts/migrate-issuers.mjs
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
  `alter table ledger_asset_catalogue add column if not exists issuer text check (issuer in ('xstocks'))`,
  `alter table ledger_asset_catalogue add column if not exists issuer_checked_at timestamptz`,
  `create index if not exists ledger_asset_catalogue_issuer_idx on ledger_asset_catalogue (issuer)`,
]

async function main() {
  console.log(`Applying issuer columns to ${new URL(process.env.DATABASE_URL).host} ...`)
  for (const stmt of STATEMENTS) await sql.query(stmt)
  const [{ n }] = await sql`select count(*)::int as n from ledger_asset_catalogue where issuer_checked_at is null and removed_from_catalogue_at is null`
  console.log(`Done. ${n} catalogue mint(s) await issuer classification by markIncompatibleMints.`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
