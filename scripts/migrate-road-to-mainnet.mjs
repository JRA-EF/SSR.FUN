// One-time (idempotent, safe to re-run) migration + seed for the Road to
// Mainnet collaborative checklist. Applies lib/road-to-mainnet/schema.sql,
// then seeds every control/gap-row/gate/meta key with its default value if
// (and only if) it doesn't already exist -- existing rows and their edit
// history are never touched by re-running this.
//
// Usage: node scripts/migrate-road-to-mainnet.mjs
// Requires DATABASE_URL (from `vercel env pull .env.local`, already present
// after the Neon Marketplace integration was connected to this project).

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

// Exact control-ID inventory, mirrored from the `controls` array in
// public/road-to-mainnet.html (category prefix -> count). Keep in sync if
// that array's set of controls ever changes.
const CONTROL_GROUPS = [
  ['CP', 18], ['AC', 10], ['PM', 10], ['LC', 9], ['JR', 10],
  ['SM', 5], ['UX', 10], ['IX', 7], ['SE', 10], ['DP', 10], ['QA', 8],
]
const CONTROL_IDS = CONTROL_GROUPS.flatMap(([prefix, count]) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
)

// Original placeholder text for the 12 gap-analysis rows, mirrored from the
// `gapRows` array in public/road-to-mainnet.html (Area, Mainnet requirement,
// Verified DevNet state, Gap/required action, Priority, Dependency).
const GAP_ROWS = [
  ['Program architecture', 'Auditable, versioned Solana programs with frozen invariants and explicit upgrade policy.', 'To verify: program IDs, deployed bytecode, source mapping and authority state.', 'Build a signed deployment inventory; freeze or document upgrade governance.', 'P0', 'Architecture decision'],
  ['Reserve discovery', 'Deterministic on-chain discovery with schema/version compatibility.', 'Reported live on-chain discovery exists; evidence and coverage not yet attached.', 'Verify all production-eligible Reserves and eliminate mock/unsupported entries.', 'P0', 'Program schema + indexer'],
  ['Reserve Token accounting', 'Exact supply, NAV, AUM, fees and pro-rata claims under all lifecycle states.', 'Reported fixes to NAV/AUM/buy behavior require transaction-level reconciliation.', 'Publish formulas and complete invariant/reconciliation suite.', 'P0', 'Price policy + core program'],
  ['Mint and redemption', 'Permissionless, proportional, atomic and independent of secondary liquidity.', 'Live DevNet behavior not yet evidenced in this document.', 'Execute positive, negative, concurrency and dust test matrix.', 'P0', 'Supported token policy'],
  ['Permissions', 'Least-privilege roles, multisig-controlled material authorities, auditable changes.', 'Delegate and pause flows reported; exact authority topology unverified.', 'Inventory keys; test scope/revocation; approve Mainnet custody model.', 'P0', 'Governance design'],
  ['Lifecycle', 'Safe composition changes, rebalance, pause, migration and wind-down with holder exits.', 'Implementation and full end-to-end evidence unknown.', 'Specify state machine and pass lifecycle rehearsal including wind-down.', 'P0', 'Core invariants + routing'],
  ['Security', 'Independent review of stable release candidate; critical/high findings closed.', 'Automated gates reported but not equivalent to an external security review.', 'Threat model, fuzz/property tests, audit, remediation and deploy rehearsal.', 'P0', 'Frozen programs'],
  ['Jupiter routing', 'Bounded, observable execution; core path survives routing outage.', 'DevNet route availability and prior signer issue indicate integration risk.', 'Define supported assets, failure modes, quote policy and Mainnet endpoints.', 'P1', 'Core protocol + Jupiter'],
  ['Indexer and metrics', 'Replayable history, freshness, reorg policy and reconciled user-facing KPIs.', 'Holder/volume/chart corrections reported; backfill and replay proof absent.', 'Implement deterministic backfill, freshness UX, alerts and reconciliation.', 'P1', 'Events/schema + RPC'],
  ['Frontend transaction UX', 'Truthful preview, signer clarity, network checks and finalized-state handling.', 'Requires full wallet matrix and failure-path verification.', 'Run browser/wallet E2E suite and attach signatures/screenshots.', 'P1', 'Stable frontend + programs'],
  ['Infrastructure', 'Redundant RPC/indexing, secrets, monitoring, incident response and recovery.', 'DevNet deployment exists; production SLOs and runbooks unverified.', 'Select providers, define SLOs, add alerts, rehearse incidents and restore.', 'P1', 'Budget + owners'],
  ['Optional market', 'Reserve Token liquidity separated from protocol NAV and redemption.', 'No Mainnet requirement should be inferred from UI or routing code.', 'Make an explicit launch decision; document venue, liquidity and manipulation risk.', 'P2', 'Launch strategy'],
]

const GATE_COUNT = 7
const META_DEFAULTS = { owner: 'Unassigned', release: 'TBD' }

// Repository-evidence-backed prefill: only non-critical items conclusively
// verifiable from repo inspection / safe automated commands, run 2026-08-06.
// Every other control is left at its 'Not tested' default -- see the
// terminal report for why the checklist's own evidence standard rules out
// auto-passing nearly everything else in this document.
const EVIDENCE = {
  'DP-01': {
    status: 'Passed',
    evidence:
      'Anchor.toml defines separate [programs.localnet] and [programs.devnet] sections with distinct program IDs; no [programs.mainnet-beta] section exists in the repo. Anchor.toml line 21 comment: "never intended for Mainnet" (current deploy keypair). src/merge/lib/solana-config.ts: SOLANA_CLUSTER defaults to "devnet" (VITE_SOLANA_CLUSTER fallback), SOLANA_RPC_URL defaults to the DevNet public endpoint or same-origin /api/devnet/rpc-proxy in production -- no Mainnet endpoint is reachable by default or accidentally bundled.',
    environment: 'Repository inspection, branch feature/road-to-mainnet',
    tester: 'Repository-verified (automated), 2026-08-06',
    notes:
      'Repo-verified, not live-tested: confirms configs cannot be confused by default/at build time. Does not verify runtime operator behavior (e.g. someone manually overriding VITE_SOLANA_CLUSTER in a Mainnet deploy) -- that remains an operational/process control, not a code guarantee.',
  },
  'DP-03': {
    status: 'Partial',
    evidence:
      'grep across src/**, api/**, scripts/**, tests/** for VITE_-prefixed secret-shaped names: no matches. DEVNET_SWAP_AUTHORITY_SECRET_KEY is referenced only in api/devnet/_lib/authority.ts and server-side scripts/tests -- never in src/ or any VITE_ variable. devnet-fixtures/ (holds the real DevNet manager keypair file) is gitignored. tests/phase_b_devusdc.ts:113-115 asserts loadDevnetAuthority() throws rather than falling back to a hardcoded keypair when the env var is unset. grep of the built dist/ bundle (npm run build, 2026-08-06) for DEVNET_SWAP_AUTHORITY_SECRET_KEY / SSR_DASHBOARD_PASSWORD: no matches.',
    environment: 'Repository inspection + production build output (dist/), branch feature/road-to-mainnet',
    tester: 'Repository-verified + automation-verified, 2026-08-06',
    notes:
      'Covers source, client bundle and build artifacts only. "...or logs" in this criterion is NOT covered -- no live/deployed runtime logs were inspected in this pass. Marked Partial rather than Passed for that reason alone.',
  },
  'QA-01': {
    status: 'Blocked',
    evidence:
      'Ran `npm run test:program` (2026-08-06): fails immediately with "Error: ANCHOR_PROVIDER_URL is not defined" before any test executes (tests/ssr_protocol.ts:48). tests/ssr_protocol.ts:1-9 itself carries an "UNVERIFIED / UNCOMPILED NOTICE": written without a working Anchor/Solana toolchain, typed against a stub Idl because `anchor build` has not produced the real generated program types.',
    environment: 'Local repository, no Anchor local-validator/provider configured',
    tester: 'Automation-verified (command run, failed to start), 2026-08-06',
    notes:
      'Blocked by missing local-validator/ANCHOR_PROVIDER_URL setup, not a code defect. Exact next step: stand up `solana-test-validator` (or run via `anchor test`), set ANCHOR_PROVIDER_URL/ANCHOR_WALLET, run `anchor build` to generate real IDL types, then re-run and record pass/fail per test with output.',
  },
  'QA-02': {
    status: 'Blocked',
    evidence: 'Same run as QA-01 -- test:program cannot start (ANCHOR_PROVIDER_URL undefined), so no instruction was actually exercised against a live program in this pass.',
    environment: 'Local repository, no Anchor local-validator/provider configured',
    tester: 'Automation-verified (command run, failed to start), 2026-08-06',
    notes: 'Same blocker and next step as QA-01. tests/ssr_protocol.ts targets real instructions/accounts (not mocks) by design once runnable -- that design intent is not the same as executed evidence.',
  },
  'SM-01': {
    status: 'Partial',
    evidence:
      'programs/ssr_protocol/src/lib.rs:105-129: mint_reserve_tokens_in_kind and redeem_reserve_tokens_in_kind take Context<MintReserveTokensInKind>/Context<RedeemReserveTokensInKind> with no pool/AMM account in their instruction signature. The only AMM CPI in the program is execute_rebalance_leg (lib.rs:189-194, doc comment: "genuinely moving this Reserve\'s own vault assets... coexists with record_rebalance, does not replace it") -- a separate internal rebalance instruction, not mint/redeem.',
    environment: 'Repository inspection (programs/ssr_protocol/src/lib.rs), branch feature/road-to-mainnet',
    tester: 'Repository-verified (automated), 2026-08-06',
    notes:
      'Static evidence that mint/redeem have no structural pool dependency. Does not prove runtime behavior under all conditions (e.g. with zero liquidity pools actually deployed) -- exact next test: execute mint and redeem live on DevNet with no secondary-market pool for the Reserve present, confirm both succeed normally.',
  },
}

async function main() {
  console.log(`Applying schema to ${new URL(process.env.DATABASE_URL).host} ...`)
  const schemaSql = fs.readFileSync(path.join(root, 'lib/road-to-mainnet/schema.sql'), 'utf8')
  const statements = schemaSql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) await sql.query(stmt)
  console.log('Schema applied.')

  let insertedControls = 0
  for (const id of CONTROL_IDS) {
    const r = await sql`insert into rtm_controls (control_id) values (${id}) on conflict (control_id) do nothing returning control_id`
    if (r.length) insertedControls++
  }
  console.log(`Controls seeded: ${insertedControls} new / ${CONTROL_IDS.length} total.`)

  let insertedGaps = 0
  for (let i = 0; i < GAP_ROWS.length; i++) {
    const r = await sql`insert into rtm_gap_rows (row_index, cells) values (${i}, ${JSON.stringify(GAP_ROWS[i])}) on conflict (row_index) do nothing returning row_index`
    if (r.length) insertedGaps++
  }
  console.log(`Gap rows seeded: ${insertedGaps} new / ${GAP_ROWS.length} total.`)

  let insertedGates = 0
  for (let i = 0; i < GATE_COUNT; i++) {
    const r = await sql`insert into rtm_gates (gate_index) values (${i}) on conflict (gate_index) do nothing returning gate_index`
    if (r.length) insertedGates++
  }
  console.log(`Gates seeded: ${insertedGates} new / ${GATE_COUNT} total.`)

  let insertedMeta = 0
  for (const [key, value] of Object.entries(META_DEFAULTS)) {
    const r = await sql`insert into rtm_meta (key, value) values (${key}, ${value}) on conflict (key) do nothing returning key`
    if (r.length) insertedMeta++
  }
  console.log(`Meta keys seeded: ${insertedMeta} new / ${Object.keys(META_DEFAULTS).length} total.`)

  let evidenceApplied = 0
  for (const [id, ev] of Object.entries(EVIDENCE)) {
    const current = await sql`select status, evidence, environment, tester, notes, version from rtm_controls where control_id = ${id}`
    if (current.length === 0) {
      console.warn(`  ! skipped ${id}: not found in rtm_controls`)
      continue
    }
    const row = current[0]
    const alreadyApplied = row.evidence === ev.evidence && row.status === ev.status
    if (alreadyApplied) continue
    await sql`
      update rtm_controls
      set status = ${ev.status}, evidence = ${ev.evidence}, environment = ${ev.environment},
          tester = ${ev.tester}, notes = ${ev.notes}, version = version + 1, updated_at = now(), updated_by = ${'migration script (repo evidence)'}
      where control_id = ${id}
    `
    await sql`insert into rtm_revisions (entity_type, entity_id, before_value, after_value, changed_by) values ('control', ${id}, ${JSON.stringify({ status: row.status, evidence: row.evidence, environment: row.environment, tester: row.tester, notes: row.notes })}, ${JSON.stringify(ev)}, 'migration script (repo evidence)')`
    evidenceApplied++
    console.log(`  seeded evidence for ${id}: ${ev.status}`)
  }
  console.log(`Evidence-backed prefill applied: ${evidenceApplied}/${Object.keys(EVIDENCE).length}.`)

  console.log('Done.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
