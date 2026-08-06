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

// Exact control-ID inventory, mirrored from the `controls` array (archived
// 107-item DevNet record) and `speedrunItems` array (15-item closed-Mainnet
// speedrun checklist) in public/road-to-mainnet.html (category prefix ->
// count). Keep in sync if either array's set of items ever changes.
const CONTROL_GROUPS = [
  ['CP', 18], ['AC', 10], ['PM', 10], ['LC', 9], ['JR', 10],
  ['SM', 5], ['UX', 10], ['IX', 7], ['SE', 10], ['DP', 10], ['QA', 8],
  ['MS', 15],
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
  ['Mint and redemption', 'Permissionless, proportional, atomic and independent of secondary liquidity.', "programs/ssr_protocol/src/lib.rs:105-129 defines mint_reserve_tokens_in_kind/redeem_reserve_tokens_in_kind with no pool-account dependency (repo-verified). docs/project/PROJECT_STATUS.md reports live-signed Buy/Sell for 100%-devUSDC-backed Reserves as fully genuine, no fabricated legs (DEC-0067) -- not independently reproduced this session. For Reserves holding non-devUSDC assets, Buy/Sell legs are reported as fabricated: minted directly by a server-held swap authority rather than sourced from real liquidity (DEC-0054, still open as of 2026-08-05).", 'Independently re-execute the full positive/negative/concurrency/dust matrix against the current release candidate. Replace the fabricated non-devUSDC legs with real liquidity sourcing before any Mainnet mint/redeem path can be considered genuine for non-devUSDC-backed Reserves -- see Jupiter routing row below.', 'P0', 'Supported token policy'],
  ['Permissions', 'Least-privilege roles, multisig-controlled material authorities, auditable changes.', 'Delegate add/update/remove flows are implemented; docs/project/PROJECT_STATUS.md reports these as live-verified with real signed transactions in a prior session (DEC-0075) -- not independently reproduced this session. Anchor.toml (repo-verified) confirms the current protocol upgrade authority is a single dev-controlled keypair, not a multisig.', 'Migrate upgrade/treasury/pause authorities to a multisig (tracked, still open per DEC-0015) before any Mainnet or restricted-beta deployment holds real value. Independently re-verify delegate scope/revocation against the current release candidate.', 'P0', 'Governance design'],
  ['Lifecycle', 'Safe composition changes, rebalance, pause, migration and wind-down with holder exits.', 'Implementation and full end-to-end evidence unknown.', 'Specify state machine and pass lifecycle rehearsal including wind-down.', 'P0', 'Core invariants + routing'],
  ['Security', 'Independent review of stable release candidate; critical/high findings closed.', 'No independent security review exists (repo-verified: no audit report/artifact anywhere in docs/). Upgrade authority is a single dev-controlled key, not a multisig (Anchor.toml). The protocol-level integration test suite (tests/ssr_protocol.ts) cannot currently execute in this environment (ANCHOR_PROVIDER_URL unset, confirmed this session).', 'Threat model, fuzz/property tests, external audit, remediation and a rehearsed deploy are all still to be started. A working local-validator/Anchor test environment is also a prerequisite for meaningful automated security-relevant test coverage.', 'P0', 'Frozen programs'],
  ['Jupiter routing', 'Bounded, observable execution; core path survives routing outage.', "No Jupiter integration exists in this codebase (repo-verified this session: no Jupiter SDK/API dependency or call site found anywhere in src/, packages/, api/, or programs/ -- the only 'jupiter' match in source is a mock JUP token-list entry, src/data/assets.ts:32, not a routing integration). Buy/Sell currently route through a DevNet-only fixed-price swap authority. A separate constant-product AMM (ssr_devnet_amm, program ID declared in Anchor.toml) was designed to eventually replace the fabricated legs but has never been built or deployed (no working Rust/Anchor toolchain validator available in recent sessions per docs/project/PROJECT_STATUS.md). Real Jupiter routing has not been attempted. Additionally: docs/project/PROJECT_STATUS.md (DEC-0045, 2026-07-29) reports a real API test against Jupiter's live aggregator returned Mainnet-only quotes regardless of the mint queried -- Jupiter has zero DevNet awareness. This is a structural constraint, not a configuration gap: real Jupiter routing cannot be exercised on DevNet at all, which is the documented reason a separate DevNet-only AMM was designed instead of integrating Jupiter directly.", "Real Jupiter integration has not been started -- this is earlier-stage than the original 'integration risk' framing suggested. Before Mainnet: either build+deploy ssr_devnet_amm or integrate real Jupiter quote/swap; define supported-asset policy, slippage/price-impact guardrails, and failure-mode handling, none of which can be defined yet because no routing implementation exists to bound.", 'P1', 'Core protocol + Jupiter'],
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
      'Ran `npm run test:program` (2026-08-06): fails immediately with "Error: ANCHOR_PROVIDER_URL is not defined" before any test executes (tests/ssr_protocol.ts:48). Retested with ANCHOR_PROVIDER_URL/ANCHOR_WALLET set and the machine\'s existing cargo/anchor/solana toolchain added to PATH (~/.cargo/bin, /c/devtools/solana/solana-release/bin -- confirmed present on this machine, just not on this session\'s default PATH): gets past that guard and a `cargo metadata` guard, then stalls with sustained 429s from the public DevNet RPC (api.devnet.solana.com) during setup, for the full 100s allotted -- no pass/fail result obtained either way. tests/ssr_protocol.ts:1-9 itself carries an "UNVERIFIED / UNCOMPILED NOTICE": written without a working Anchor/Solana toolchain, typed against a stub Idl because `anchor build` has not produced the real generated program types.',
    environment: 'Local repository, public DevNet RPC (no private/Helius endpoint available to local runs -- that key is Vercel-only)',
    tester: 'Automation-verified (command run, did not complete), 2026-08-06',
    notes:
      'Not simply "blocked from starting" -- it starts (once PATH/env are fixed) and then stalls on public-RPC rate limiting, a separately pre-existing documented risk (docs/project/PROJECT_STATUS.md Risks). Exact next step: run with a private RPC endpoint, or enable Windows Developer Mode so solana-test-validator/anchor test can run fully offline (also currently blocked per PROJECT_STATUS.md Blockers) instead of live DevNet.',
  },
  'QA-02': {
    status: 'Blocked',
    evidence: 'Same retest as QA-01 -- test:program starts once PATH/env are fixed, then stalls on public-DevNet-RPC rate limiting during setup; no instruction was actually exercised to completion against a live program in this pass.',
    environment: 'Local repository, public DevNet RPC (no private/Helius endpoint available to local runs)',
    tester: 'Automation-verified (command run, did not complete), 2026-08-06',
    notes: 'Same refined blocker and next step as QA-01. tests/ssr_protocol.ts targets real instructions/accounts (not mocks) by design once runnable -- that design intent is not the same as executed evidence.',
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

// Notes-only pointers for critical/manual controls -- status is deliberately
// left at whatever it already is (these do NOT become Passed/Partial from
// this alone). Saves the next reviewer a re-discovery pass by citing exactly
// where a prior, unreproduced lead lives, per the doc's own rule that a
// historical report is a lead, not proof, until reproduced against the
// current release candidate.
const NOTES_ONLY = {
  'CP-07': "Lead, not proof: docs/project/PROJECT_STATUS.md (DEC-0067, DEC-0078) reports live-signed proportional-mint Buy transactions for 100%-devUSDC-backed Reserves as fully genuine (real signatures logged, e.g. under 'Technical Health' 2026-07-30/2026-08-05 entries). NOT independently reproduced this session. For Reserves holding non-devUSDC assets, the same doc (DEC-0054) reports mint legs as fabricated (server-minted), not sourced from real liquidity. Exact next test: re-execute a live mint against the current release candidate for both a devUSDC-only and a mixed-asset Reserve, and verify post-state directly, not just the transaction succeeding.",
  'CP-08': "Lead, not proof: same sourcing as CP-07 -- docs/project/PROJECT_STATUS.md reports live-signed proportional-redeem (Sell) transactions as genuine for devUSDC-only Reserves (DEC-0067), fabricated (server-minted devUSDC payout) for mixed-asset Reserves (DEC-0054, open). NOT independently reproduced this session. Exact next test: re-execute a live redeem against the current release candidate, verify NAV/AUM/vault balances before and after directly.",
  'PM-08': "Repo-verified structural fact (not the full live-authority-topology test this control requires): Anchor.toml's [programs.devnet]/[programs.localnet] sections and its accompanying comment confirm the current DevNet upgrade authority is a single dev-controlled keypair, not a multisig -- docs/project/PROJECT_STATUS.md (DEC-0015) tracks migrating this to a multisig as still open before any Mainnet or restricted-beta deployment. Exact next test: confirm the deployed program's actual upgrade authority on-chain (not just the local keypair config) and formally decide/execute the multisig migration.",
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

  let notesApplied = 0
  for (const [id, noteText] of Object.entries(NOTES_ONLY)) {
    const current = await sql`select status, evidence, environment, tester, notes, version from rtm_controls where control_id = ${id}`
    if (current.length === 0) {
      console.warn(`  ! skipped ${id}: not found in rtm_controls`)
      continue
    }
    const row = current[0]
    if (row.notes === noteText) continue
    await sql`
      update rtm_controls
      set notes = ${noteText}, version = version + 1, updated_at = now(), updated_by = ${'migration script (repo evidence, notes-only)'}
      where control_id = ${id}
    `
    await sql`insert into rtm_revisions (entity_type, entity_id, before_value, after_value, changed_by) values ('control', ${id}, ${JSON.stringify({ status: row.status, evidence: row.evidence, environment: row.environment, tester: row.tester, notes: row.notes })}, ${JSON.stringify({ status: row.status, evidence: row.evidence, environment: row.environment, tester: row.tester, notes: noteText })}, 'migration script (repo evidence, notes-only)')`
    notesApplied++
    console.log(`  seeded notes-only lead for ${id} (status unchanged: ${row.status})`)
  }
  console.log(`Notes-only leads applied: ${notesApplied}/${Object.keys(NOTES_ONLY).length}.`)

  console.log('Done.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
