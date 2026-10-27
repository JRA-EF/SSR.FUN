// Command center (DEC-0264): live probes of every integration ssr.fun depends
// on, run ONLY by the production deployment (api/dashboard/commandcenter.ts
// forwards every other deployment's request here), so each value is
// ssr.fun's: its keys, its env, its wallets.
//
// Rules: a probe never throws (its failure is the finding), never returns a
// secret value (keys are reported by name, age and whether the service
// answers), and every external call has a timeout.
import { neon } from '@neondatabase/serverless'
import {
  daysBetween, daysUntil, formatAge, formatSol, formatUsd, latencyTone, renewalTone, secretTone, solTone, summarize, worst,
  type CcEdge, type CcNode, type CommandCenterState, type ManualFacts, type Metric, type Renewal, type SecretInfo, type Tone,
} from './model.js'

const TIMEOUT_MS = 8_000
const VERCEL_TEAM_SLUG = 'ssr14'
const VERCEL_PROJECT = 'ssr-fun'
const PROGRAM_ID = '8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'
const PROGRAM_DATA = '2YF7aofgPbNj96pJJh1uzLtCk4H2fUq1FVLxFf9TAwow'
const SQUADS_MULTISIG = 'G8pgvV8wGrscorppA3VrcAWrV6QGP4TvTps1czaejzH8'
const SQUADS_VAULT = 'HFmqpPVVdMRcwaSKkbxLNga8byBJb3LK1FsURsDQqYoW'
const POOL_PAYER = '6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS'
const RAYDIUM_PERMISSION = 'HqMmvmtRUHup5ACL7mTf5bCj6STYB6ZUMgnd4CN8LmLB'
const GITHUB_REPO = 'JRA-EF/SSR.FUN'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export const NODE_IDS = [
  'site', 'vercel', 'domain-ssr', 'domain-test', 'github', 'neon', 'helius', 'jupiter', 'telegram', 'sheets',
  'program', 'squads', 'raydium', 'keeper', 'pool-payer',
] as const

/** Paid services whose plan and renewal date only a person knows; the page edits these. */
const EDITABLE = new Set(['vercel', 'neon', 'helius', 'jupiter', 'domain-ssr', 'domain-test', 'github', 'telegram', 'sheets'])

/** Which env secrets belong to which integration, and when to call them overdue for rotation. */
const SECRETS: { name: string; node: string; rotateAfterDays: number }[] = [
  { name: 'JUPITER_API_KEY', node: 'jupiter', rotateAfterDays: 90 },
  { name: 'HELIUS_MAINNET_RPC_URL', node: 'helius', rotateAfterDays: 180 },
  { name: 'HELIUS_RPC_URL', node: 'helius', rotateAfterDays: 180 },
  { name: 'HELIUS_ALERT_WEBHOOK_SECRET', node: 'helius', rotateAfterDays: 180 },
  { name: 'TELEGRAM_ALERT_BOT_TOKEN', node: 'telegram', rotateAfterDays: 180 },
  { name: 'FEEDBACK_SHEET_WEBHOOK_URL', node: 'sheets', rotateAfterDays: 365 },
  { name: 'FEEDBACK_SHEET_SECRET', node: 'sheets', rotateAfterDays: 180 },
  { name: 'DATABASE_URL', node: 'neon', rotateAfterDays: 365 },
  { name: 'CRON_SECRET', node: 'vercel', rotateAfterDays: 180 },
  { name: 'VERCEL_API_TOKEN', node: 'vercel', rotateAfterDays: 180 },
  { name: 'COMMAND_CENTER_TOKEN', node: 'vercel', rotateAfterDays: 180 },
  { name: 'SSR_SITE_PASSWORD', node: 'site', rotateAfterDays: 120 },
  { name: 'SSR_BETA_KEYS', node: 'site', rotateAfterDays: 120 },
  { name: 'SSR_TEAM_KEYS', node: 'site', rotateAfterDays: 120 },
  { name: 'SSR_DASHBOARD_PASSWORD', node: 'site', rotateAfterDays: 120 },
  { name: 'SSR_FEE_SETTLEMENT_KEEPER_SECRET', node: 'keeper', rotateAfterDays: 365 },
  { name: 'SSR_RAYDIUM_POOL_PAYER_SECRET', node: 'pool-payer', rotateAfterDays: 365 },
]

// ---------------------------------------------------------------- helpers

interface Timed<T> { ok: boolean; ms: number; value?: T; error?: string; status?: number }

async function timed<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs = TIMEOUT_MS): Promise<Timed<T>> {
  const t0 = Date.now()
  try {
    const value = await fn(AbortSignal.timeout(timeoutMs))
    return { ok: true, ms: Date.now() - t0, value }
  } catch (e) {
    const err = e as Error & { status?: number }
    return { ok: false, ms: Date.now() - t0, error: scrub(err?.message ?? String(e)), status: err?.status }
  }
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function getJson<T>(url: string, init: RequestInit & { signal: AbortSignal }): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status}`)
  return (await r.json()) as T
}

/** Error text may echo a URL that carries a key; strip anything key-shaped before it reaches the page. */
export function scrub(message: string): string {
  return message
    .replace(/(api-key|apikey|key|token|secret)=[^&\s"']+/gi, '$1=…')
    .replace(/bot\d+:[\w-]+/g, 'bot…')
    .slice(0, 240)
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}

/** Public key of a keypair secret stored as a JSON byte array or base64 (the keeper's format). */
export function publicKeyFromSecret(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const bytes = raw.trim().startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : Uint8Array.from(Buffer.from(raw, 'base64'))
    return bytes.length === 64 ? base58Encode(bytes.subarray(32)) : null
  } catch {
    return null
  }
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function rpcUrl(): string | null {
  return process.env.HELIUS_MAINNET_RPC_URL || process.env.HELIUS_RPC_URL || null
}

async function rpc<T>(method: string, params: unknown[], signal: AbortSignal): Promise<T> {
  const url = rpcUrl()
  if (!url) throw new Error('No Mainnet RPC URL configured')
  const j = await getJson<{ result?: T; error?: { message: string } }>(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal,
  })
  if (j.error) throw new Error(j.error.message)
  return j.result as T
}

// ----------------------------------------------------------------- probes

interface ChainAccount { lamports: number; data: Buffer; owner: string }

async function probeChain(keeper: string | null) {
  const addrs = [PROGRAM_DATA, SQUADS_MULTISIG, SQUADS_VAULT, POOL_PAYER, RAYDIUM_PERMISSION, ...(keeper ? [keeper] : [])]
  const health = await timed((signal) => rpc<string>('getHealth', [], signal))
  const accounts = await timed(async (signal) => {
    const r = await rpc<{ value: ({ lamports: number; owner: string; data: [string, string] } | null)[] }>(
      'getMultipleAccounts', [addrs, { encoding: 'base64', dataSlice: { offset: 0, length: 200 }, commitment: 'confirmed' }], signal)
    const map = new Map<string, ChainAccount | null>()
    addrs.forEach((a, i) => {
      const v = r.value[i]
      map.set(a, v ? { lamports: v.lamports, owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null)
    })
    return map
  })
  let upgradeSlot: number | null = null
  let upgradeAuthority: string | null = null
  const pd = accounts.value?.get(PROGRAM_DATA)
  if (pd && pd.data.length >= 45) {
    upgradeSlot = Number(pd.data.readBigUInt64LE(4))
    upgradeAuthority = pd.data[12] === 1 ? base58Encode(pd.data.subarray(13, 45)) : null
  }
  const upgradeTime = upgradeSlot === null ? null : await timed((signal) => rpc<number | null>('getBlockTime', [upgradeSlot], signal))
  let threshold: number | null = null
  let members: number | null = null
  const ms = accounts.value?.get(SQUADS_MULTISIG)
  if (ms && ms.data.length >= 140) {
    threshold = ms.data.readUInt16LE(72)
    // Squads v4 Multisig: rent_collector is an Option<Pubkey> at byte 94, then bump, then the member vec.
    const membersAt = 94 + (ms.data[94] === 1 ? 33 : 1) + 1
    if (ms.data.length >= membersAt + 4) members = ms.data.readUInt32LE(membersAt)
  }
  return { health, accounts, upgradeSlot, upgradeAuthority, upgradeTime: upgradeTime?.value ?? null, threshold, members }
}

async function probeJupiter() {
  const key = process.env.JUPITER_API_KEY
  const base = (process.env.JUPITER_API_BASE || 'https://api.jup.ag').replace(/\/+$/, '')
  if (!key) return { configured: false as const }
  const t0 = Date.now()
  try {
    const r = await fetch(`${base}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=10000000&slippageBps=50`, {
      headers: { 'x-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const remaining = r.headers.get('x-ratelimit-remaining')
    const limit = r.headers.get('x-ratelimit-limit')
    return { configured: true as const, status: r.status, ms: Date.now() - t0, remaining, limit }
  } catch (e) {
    return { configured: true as const, status: 0, ms: Date.now() - t0, error: scrub((e as Error).message) }
  }
}

async function probeTelegram() {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
  if (!token) return { configured: false as const }
  const r = await timed((signal) => getJson<{ ok: boolean; result?: { username?: string } }>(`https://api.telegram.org/bot${token}/getMe`, { signal }))
  return { configured: true as const, ok: r.ok && !!r.value?.ok, ms: r.ms, username: r.value?.result?.username ?? null, error: r.error }
}

async function probeSheets() {
  const url = process.env.FEEDBACK_SHEET_WEBHOOK_URL
  if (!url) return { configured: false as const }
  const r = await timed((signal) => getJson<{ ok?: boolean }>(url, { signal, redirect: 'follow' }), 12_000)
  return { configured: true as const, ok: r.ok && r.value?.ok === true, ms: r.ms, error: r.error }
}

async function probeHeliusWebhook() {
  const url = rpcUrl()
  const key = url ? new URL(url).searchParams.get('api-key') : null
  if (!key) return { known: false as const }
  const r = await timed((signal) => getJson<{ webhookURL: string; txnStatus?: string; accountAddresses?: string[] }[]>(
    `https://api-mainnet.helius-rpc.com/v0/webhooks?api-key=${key}`, { signal }))
  if (!r.ok || !Array.isArray(r.value)) return { known: true as const, ok: false, error: r.error }
  const hook = r.value.find((w) => w.webhookURL?.endsWith('/api/mainnet/alert-helius'))
  return { known: true as const, ok: true, registered: !!hook, pointsAt: hook ? new URL(hook.webhookURL).host : null, watchesProgram: !!hook?.accountAddresses?.includes(PROGRAM_ID) }
}

async function probeSite() {
  return timed(async (signal) => {
    const r = await fetch('https://ssr.fun/', { signal, redirect: 'manual' })
    if (r.status >= 500) throw new HttpError(r.status, `HTTP ${r.status}`)
    return r.status
  })
}

const rdapCache = new Map<string, { at: number; value: { expires: string | null; registrar: string | null } }>()

async function probeDomain(domain: string) {
  const hit = rdapCache.get(domain)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return { ok: true, value: hit.value }
  const r = await timed((signal) => getJson<{ events?: { eventAction: string; eventDate: string }[]; entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[] }>(
    `https://rdap.org/domain/${domain}`, { signal, redirect: 'follow', headers: { accept: 'application/rdap+json', 'user-agent': 'ssr-fun-command-center/1.0' } }))
  if (!r.ok || !r.value) return { ok: false, error: r.error }
  const expires = r.value.events?.find((e) => e.eventAction === 'expiration')?.eventDate ?? null
  const registrar = r.value.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] ?? null
  const value = { expires, registrar }
  rdapCache.set(domain, { at: Date.now(), value })
  return { ok: true, value }
}

let githubCache: { at: number; value: { pushedAt: string; visibility: string; defaultBranch: string } } | null = null

async function probeGithub() {
  if (githubCache && Date.now() - githubCache.at < 15 * 60_000) return { ok: true, value: githubCache.value }
  const r = await timed((signal) => getJson<{ pushed_at: string; visibility: string; default_branch: string }>(
    `https://api.github.com/repos/${GITHUB_REPO}`, { signal, headers: { 'user-agent': 'ssr-fun-command-center', accept: 'application/vnd.github+json' } }))
  if (!r.ok || !r.value) return { ok: false, error: r.error }
  githubCache = { at: Date.now(), value: { pushedAt: r.value.pushed_at, visibility: r.value.visibility, defaultBranch: r.value.default_branch } }
  return { ok: true, value: githubCache.value }
}

interface VercelData {
  plan: string | null
  billingStatus: string | null
  periodStart: number | null
  periodEnd: number | null
  spend: number | null
  topSpend: { name: string; usd: number }[]
  deployment: { id: string; state: string; createdAt: number; commit: string | null } | null
  envAges: Map<string, number>
  envNames: Set<string>
}

async function probeVercel(): Promise<{ connected: false } | { connected: true; ok: boolean; error?: string; data?: VercelData }> {
  const token = process.env.VERCEL_API_TOKEN
  if (!token) return { connected: false }
  const headers = { authorization: `Bearer ${token}` }
  const q = `slug=${VERCEL_TEAM_SLUG}`
  const r = await timed(async (signal) => {
    const [team, deps, envs] = await Promise.all([
      getJson<{ billing?: { plan?: string; status?: string; period?: { start: number; end: number } } }>(`https://api.vercel.com/v2/teams/${VERCEL_TEAM_SLUG}?${q}`, { headers, signal }),
      getJson<{ deployments: { uid: string; readyState?: string; state?: string; created: number; meta?: { githubCommitSha?: string } }[] }>(
        `https://api.vercel.com/v6/deployments?app=${VERCEL_PROJECT}&target=production&limit=1&${q}`, { headers, signal }),
      getJson<{ envs: { key: string; target?: string[]; createdAt?: number; updatedAt?: number }[] }>(
        `https://api.vercel.com/v9/projects/${VERCEL_PROJECT}/env?decrypt=false&${q}`, { headers, signal }),
    ])
    const period = team.billing?.period ?? null
    let spend: number | null = null
    const byService = new Map<string, number>()
    if (period) {
      // FOCUS billing export, one JSON object per line, one row per service per day.
      const res = await fetch(`https://api.vercel.com/v1/billing/charges?from=${new Date(period.start).toISOString()}&to=${new Date().toISOString()}&${q}`, { headers, signal })
      if (res.ok) {
        spend = 0
        for (const line of (await res.text()).split('\n')) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line) as { BilledCost?: number; ServiceName?: string }
            const cost = Number(row.BilledCost ?? 0)
            spend += cost
            if (row.ServiceName) byService.set(row.ServiceName, (byService.get(row.ServiceName) ?? 0) + cost)
          } catch { /* skip a malformed line */ }
        }
      }
    }
    const envAges = new Map<string, number>()
    const envNames = new Set<string>()
    for (const e of envs.envs ?? []) {
      if (!e.target?.includes('production')) continue
      envNames.add(e.key)
      const at = e.updatedAt ?? e.createdAt
      if (at) envAges.set(e.key, daysBetween(at, Date.now()))
    }
    const d = deps.deployments?.[0]
    const data: VercelData = {
      plan: team.billing?.plan ?? null,
      billingStatus: team.billing?.status ?? null,
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
      spend,
      topSpend: [...byService.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, usd]) => ({ name, usd })),
      deployment: d ? { id: d.uid, state: d.readyState ?? d.state ?? 'UNKNOWN', createdAt: d.created, commit: d.meta?.githubCommitSha ?? null } : null,
      envAges, envNames,
    }
    return data
  }, 15_000)
  return r.ok ? { connected: true, ok: true, data: r.value } : { connected: true, ok: false, error: r.error }
}

type Sql = ReturnType<typeof neon>

function sql(): Sql | null {
  const url = process.env.DATABASE_URL
  return url ? neon(url) : null
}

export async function ensureFactsTable(db: Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS command_center_facts (
    node text PRIMARY KEY, facts jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`
}

export async function saveFacts(node: string, facts: ManualFacts): Promise<void> {
  const db = sql()
  if (!db) throw new Error('DATABASE_URL is not configured.')
  await ensureFactsTable(db)
  await db`INSERT INTO command_center_facts (node, facts, updated_at) VALUES (${node}, ${JSON.stringify(facts)}::jsonb, now())
    ON CONFLICT (node) DO UPDATE SET facts = EXCLUDED.facts, updated_at = now()`
}

async function probeNeon() {
  const db = sql()
  if (!db) return { configured: false as const }
  const ping = await timed(async () => { await db`SELECT 1`; return true })
  if (!ping.ok) return { configured: true as const, ok: false, ms: ping.ms, error: ping.error }
  const size = await timed(async () => ((await db`SELECT pg_database_size(current_database())::bigint AS b`) as { b: string }[])[0]?.b)
  const facts = await timed(async () => {
    await ensureFactsTable(db)
    const rows = (await db`SELECT node, facts, updated_at FROM command_center_facts`) as { node: string; facts: ManualFacts; updated_at: string }[]
    return new Map(rows.map((r) => [r.node, { ...r.facts, updatedAt: new Date(r.updated_at).toISOString() }]))
  })
  const alerts = await timed(async () => {
    const counts = (await db`SELECT source, count(*)::int AS n FROM ops_alert_events WHERE at > now() - interval '24 hours' GROUP BY source`) as { source: string; n: number }[]
    const recent = (await db`SELECT at, source, step, message FROM ops_alert_events ORDER BY at DESC LIMIT 6`) as { at: string; source: string; step: string; message: string }[]
    return {
      last24h: Object.fromEntries(counts.map((c) => [c.source, c.n])),
      recent: recent.map((r) => ({ at: new Date(r.at).toISOString(), source: r.source, step: r.step, message: scrub(r.message).slice(0, 160) })),
    }
  })
  return {
    configured: true as const, ok: true, ms: ping.ms,
    sizeBytes: size.value ? Number(size.value) : null,
    facts: facts.value ?? new Map<string, ManualFacts>(),
    alerts: alerts.ok ? alerts.value ?? null : null,
  }
}

// --------------------------------------------------------------- assembly

function node(id: string, label: string, kind: CcNode['kind'], impact: string): CcNode {
  return { id, label, kind, status: 'ok', headline: '', impact, problems: [], metrics: [], keys: [], links: [], manual: {}, editable: EDITABLE.has(id) }
}

function flag(n: CcNode, tone: Tone, problem?: string) {
  n.status = worst(n.status, tone)
  if (problem && tone !== 'ok') n.problems.push(problem)
}

function m(label: string, value: string, tone?: Tone): Metric {
  return tone ? { label, value, tone } : { label, value }
}

export async function collectCommandCenter(now = Date.now()): Promise<CommandCenterState> {
  const keeper = publicKeyFromSecret(process.env.SSR_FEE_SETTLEMENT_KEEPER_SECRET)
  const [chain, jup, tg, sheets, hook, site, dSsr, dTest, gh, vercel, db] = await Promise.all([
    probeChain(keeper), probeJupiter(), probeTelegram(), probeSheets(), probeHeliusWebhook(), probeSite(),
    probeDomain('ssr.fun'), probeDomain('strategic-super-reserve.fun'), probeGithub(), probeVercel(), probeNeon(),
  ])
  const vd = vercel.connected && vercel.ok ? vercel.data ?? null : null
  const facts = (db.configured && db.ok && db.facts) || new Map<string, ManualFacts>()
  const renewals: Renewal[] = []
  const N: Record<string, CcNode> = {}
  const add = (n: CcNode) => { N[n.id] = n; n.manual = facts.get(n.id) ?? {}; return n }

  // ssr.fun itself
  const s = add(node('site', 'ssr.fun', 'hub', 'The app every user opens.'))
  if (site.ok) { s.headline = `up · ${site.ms} ms`; s.metrics.push(m('Homepage', `HTTP ${site.value} in ${site.ms} ms`, latencyTone(site.ms, 2500))); flag(s, latencyTone(site.ms, 2500), 'Homepage is slow') }
  else { s.headline = 'unreachable'; flag(s, 'down', `Homepage did not answer: ${site.error}`) }
  if (vd?.deployment) {
    const d = vd.deployment
    s.metrics.push(m('Live deployment', `${d.id.slice(0, 12)}… · ${d.state.toLowerCase()} · ${daysBetween(d.createdAt, now)} d ago`, d.state === 'READY' ? 'ok' : 'down'))
    if (d.state !== 'READY') flag(s, 'down', `Production deployment is ${d.state}`)
  }
  s.links.push({ label: 'Open ssr.fun', url: 'https://ssr.fun' }, { label: 'Deployments', url: `https://vercel.com/${VERCEL_TEAM_SLUG}/${VERCEL_PROJECT}/deployments` })

  // Vercel
  const v = add(node('vercel', 'Vercel', 'service', 'Hosts the site, every API route and the hourly fee keeper. If billing lapses, all of it stops.'))
  v.links.push({ label: 'Billing', url: `https://vercel.com/${VERCEL_TEAM_SLUG}/~/settings/billing` }, { label: 'Usage', url: `https://vercel.com/${VERCEL_TEAM_SLUG}/~/usage` })
  if (!vercel.connected) { v.headline = 'connect API token'; flag(v, 'unknown'); v.problems.push('Add VERCEL_API_TOKEN to the ssr-fun project to see billing, spend, deployments and key ages.') }
  else if (!vd) { v.headline = 'API error'; flag(v, 'warn', `Vercel API: ${vercel.connected && !vercel.ok ? vercel.error : 'no data'}`) }
  else {
    v.headline = `${(vd.plan ?? '?').toUpperCase()} · ${vd.spend !== null ? formatUsd(vd.spend) : '?'} this cycle`
    v.metrics.push(m('Plan', `${vd.plan ?? 'unknown'} (${vd.billingStatus ?? 'unknown'})`, vd.billingStatus === 'active' ? 'ok' : 'down'))
    if (vd.billingStatus && vd.billingStatus !== 'active') flag(v, 'down', `Billing status is ${vd.billingStatus}`)
    if (vd.periodEnd) {
      const days = daysUntil(isoDay(vd.periodEnd), now)
      v.metrics.push(m('Next invoice', `${isoDay(vd.periodEnd)} (in ${days} d)`))
      renewals.push({ nodeId: 'vercel', label: 'Vercel invoice', date: isoDay(vd.periodEnd), source: 'live', amount: vd.spend !== null ? `${formatUsd(vd.spend)} so far` : null })
    }
    if (vd.spend !== null) v.metrics.push(m('Spend this cycle', formatUsd(vd.spend)))
    for (const t of vd.topSpend) v.metrics.push(m(`· ${t.name}`, formatUsd(t.usd)))
  }

  // Domains (RDAP: registrar and expiry straight from the registry)
  for (const [id, domain, probe, impact] of [
    ['domain-ssr', 'ssr.fun', dSsr, 'The production address. If it lapses, users and on-chain metadata links lose the site.'],
    ['domain-test', 'strategic-super-reserve.fun', dTest, 'The team test site and internal tools.'],
  ] as const) {
    const n = add(node(id, domain, 'domain', impact))
    if (!probe.ok || !probe.value) { n.headline = 'registry lookup failed'; flag(n, 'unknown'); n.problems.push(`RDAP: ${probe.error ?? 'no data'}`); continue }
    const { expires, registrar } = probe.value
    if (registrar) n.metrics.push(m('Registrar', registrar))
    if (expires) {
      const days = daysUntil(expires, now)
      const tone = renewalTone(days, 45)
      n.headline = `expires in ${days} d`
      n.metrics.push(m('Expires', `${isoDay(Date.parse(expires))} (in ${days} d)`, tone))
      flag(n, tone, `Domain expires in ${days} days`)
      renewals.push({ nodeId: id, label: `${domain} domain`, date: isoDay(Date.parse(expires)), source: 'live' })
    }
  }

  // GitHub
  const g = add(node('github', 'GitHub', 'service', 'Source of every deploy. The repository is public: secrets must never be committed.'))
  g.links.push({ label: 'Repository', url: `https://github.com/${GITHUB_REPO}` })
  if (gh.ok && gh.value) {
    g.headline = `${gh.value.visibility} · pushed ${daysBetween(Date.parse(gh.value.pushedAt), now)} d ago`
    g.metrics.push(m('Visibility', gh.value.visibility, gh.value.visibility === 'public' ? 'warn' : 'ok'), m('Last push', gh.value.pushedAt.slice(0, 16).replace('T', ' ') + ' UTC'))
  } else { g.headline = 'API unavailable'; flag(g, 'unknown'); g.problems.push(`GitHub: ${gh.error ?? 'no data'}`) }

  // Neon
  const ne = add(node('neon', 'Neon Postgres', 'service', 'Names, pictures, volume, NAV history, rate limits and alert logs. Down = cards lose names and All-Time Volume shows Unavailable.'))
  ne.links.push({ label: 'Console', url: 'https://console.neon.tech/app/projects/little-hall-61768380' })
  if (!db.configured) { ne.headline = 'not configured'; flag(ne, 'down', 'DATABASE_URL is missing') }
  else if (!db.ok) { ne.headline = 'unreachable'; flag(ne, 'down', `Query failed: ${db.error}`) }
  else {
    ne.headline = `${db.ms} ms${db.sizeBytes ? ` · ${(db.sizeBytes / 1e6).toFixed(0)} MB` : ''}`
    ne.metrics.push(m('Query', `${db.ms} ms`, latencyTone(db.ms, 1500)))
    flag(ne, latencyTone(db.ms, 1500), 'Database is slow')
    if (db.sizeBytes) ne.metrics.push(m('Database size', `${(db.sizeBytes / 1e6).toFixed(1)} MB`))
  }

  // Helius
  const h = add(node('helius', 'Helius RPC', 'service', 'Every Mainnet read and transaction the app and keeper send. Down = mint, redeem and settlement stop.'))
  h.links.push({ label: 'Dashboard', url: 'https://dashboard.helius.dev' })
  if (!rpcUrl()) { h.headline = 'not configured'; flag(h, 'down', 'No Mainnet RPC URL') }
  else if (!chain.health.ok || chain.health.value !== 'ok') { h.headline = 'unhealthy'; flag(h, 'down', `getHealth: ${chain.health.error ?? chain.health.value}`) }
  else {
    h.headline = `healthy · ${chain.health.ms} ms`
    h.metrics.push(m('RPC health', `ok in ${chain.health.ms} ms`, latencyTone(chain.health.ms, 1500)))
    flag(h, latencyTone(chain.health.ms, 1500), 'RPC is slow')
  }
  if (hook.known) {
    if (!hook.ok) h.metrics.push(m('Failed-tx webhook', 'could not list webhooks', 'unknown'))
    else {
      const tone: Tone = hook.registered && hook.watchesProgram ? 'ok' : 'warn'
      h.metrics.push(m('Failed-tx webhook', hook.registered ? `→ ${hook.pointsAt}${hook.watchesProgram ? '' : ' (not watching the program)'}` : 'not registered', tone))
      flag(h, tone, 'Failed-transaction alerts webhook is missing')
    }
  }

  // Jupiter
  const j = add(node('jupiter', 'Jupiter API', 'service', 'Swap routes for mint, redeem, rebalance and the keeper\'s fee swaps. Rate limited = those fail.'))
  j.links.push({ label: 'Portal', url: 'https://portal.jup.ag' })
  if (!jup.configured) { j.headline = 'no key'; flag(j, 'down', 'JUPITER_API_KEY is missing') }
  else if (jup.status === 200) {
    j.headline = `quoting · ${jup.ms} ms`
    j.metrics.push(m('Test quote', `ok in ${jup.ms} ms`, latencyTone(jup.ms, 2500)))
    if (jup.remaining && jup.limit) {
      const tone: Tone = Number(jup.remaining) < Number(jup.limit) * 0.1 ? 'warn' : 'ok'
      j.metrics.push(m('Rate limit left', `${jup.remaining} / ${jup.limit}`, tone))
      flag(j, tone, 'Close to the Jupiter rate limit')
    }
  } else if (jup.status === 429) { j.headline = 'RATE LIMITED'; flag(j, 'down', 'Jupiter answered 429 Too Many Requests: swaps and keeper fee swaps fail') }
  else if (jup.status === 401 || jup.status === 403) { j.headline = 'key rejected'; flag(j, 'down', `Jupiter rejected the key (HTTP ${jup.status})`) }
  else { j.headline = 'error'; flag(j, 'down', `Test quote failed: ${'error' in jup && jup.error ? jup.error : `HTTP ${jup.status}`}`) }

  // Telegram
  const t = add(node('telegram', 'Telegram alerts', 'service', 'Where the team hears about failed mints, on-chain failures and keeper problems.'))
  if (!tg.configured) { t.headline = 'not configured'; flag(t, 'warn', 'Alerts are logged but not posted (no bot token)') }
  else if (!tg.ok) { t.headline = 'bot rejected'; flag(t, 'down', `Bot check failed: ${tg.error ?? 'not ok'}`) }
  else { t.headline = `@${tg.username ?? 'bot'} online`; t.metrics.push(m('Bot', `@${tg.username} answers in ${tg.ms} ms`)) }
  const alerts = (db.configured && db.ok ? db.alerts : null) ?? null
  if (alerts) {
    const total = Object.values(alerts.last24h).reduce((a, b) => a + b, 0)
    t.metrics.push(m('Alerts, last 24 h', total ? Object.entries(alerts.last24h).map(([k, n]) => `${k} ${n}`).join(' · ') : 'none', total ? 'warn' : 'ok'))
  }

  // Google Sheet feedback
  const sh = add(node('sheets', 'Feedback sheet', 'service', 'In-app feedback lands here. Down = the feedback page shows an error.'))
  sh.links.push({ label: 'Sheet', url: 'https://docs.google.com/spreadsheets/d/1CcPwOu3bZqECxNbE4neOkEeBY0mX1UD70SvBnB08Ygc' })
  if (!sheets.configured) { sh.headline = 'not configured'; flag(sh, 'warn', 'Feedback webhook is not set') }
  else if (!sheets.ok) { sh.headline = 'webhook down'; flag(sh, 'down', `Apps Script health check failed: ${sheets.error ?? 'not ok'}`) }
  else { sh.headline = `webhook ok · ${sheets.ms} ms`; sh.metrics.push(m('Apps Script', `answers in ${sheets.ms} ms`)) }

  // Program + Squads + Raydium
  const p = add(node('program', 'SSR program', 'chain', 'The Mainnet program holding every Reserve.'))
  p.links.push({ label: 'Solscan', url: `https://solscan.io/account/${PROGRAM_ID}` })
  if (chain.upgradeSlot === null) { p.headline = 'unreadable'; flag(p, 'unknown'); p.problems.push('Could not read the program data account') }
  else {
    p.headline = `upgraded ${chain.upgradeTime ? `${daysBetween(chain.upgradeTime * 1000, now)} d ago` : `slot ${chain.upgradeSlot}`}`
    p.metrics.push(m('Last upgrade', `slot ${chain.upgradeSlot}${chain.upgradeTime ? ` · ${new Date(chain.upgradeTime * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`))
    const tone: Tone = chain.upgradeAuthority === SQUADS_VAULT ? 'ok' : 'down'
    p.metrics.push(m('Upgrade authority', chain.upgradeAuthority === SQUADS_VAULT ? 'Squads vault' : chain.upgradeAuthority ? `${chain.upgradeAuthority.slice(0, 6)}… (NOT the Squads vault)` : 'immutable', tone))
    flag(p, tone, 'Upgrade authority is not the Squads vault')
  }
  const q = add(node('squads', 'Squads multisig', 'chain', 'Approves every program upgrade.'))
  q.links.push({ label: 'Squads', url: `https://app.squads.so/squads/${SQUADS_MULTISIG}/home` })
  if (chain.threshold === null) { q.headline = 'unreadable'; flag(q, 'unknown') }
  else {
    q.headline = `${chain.threshold} of ${chain.members ?? '?'} signers`
    const tone: Tone = chain.threshold < 2 ? 'warn' : 'ok'
    q.metrics.push(m('Threshold', `${chain.threshold} of ${chain.members ?? '?'}`, tone))
    flag(q, tone, 'One signer can upgrade the program alone')
  }
  const ry = add(node('raydium', 'Raydium CPMM', 'chain', 'Pool creation for liquidity launches needs this permission.'))
  const perm = chain.accounts.value?.get(RAYDIUM_PERMISSION)
  if (!chain.accounts.ok) { ry.headline = 'unreadable'; flag(ry, 'unknown') }
  else if (!perm) { ry.headline = 'permission missing'; flag(ry, 'down', 'The pool-creation permission account no longer exists') }
  else { ry.headline = 'permission active'; ry.metrics.push(m('Permission', 'pool payer is whitelisted')) }

  // Wallets
  const kp = add(node('keeper', 'Fee keeper', 'wallet', 'Settles fees hourly and feeds holder shares. Out of SOL = settlement stops (it did once, Sept 2026).'))
  if (!keeper) { kp.headline = 'no key'; flag(kp, 'down', 'SSR_FEE_SETTLEMENT_KEEPER_SECRET is missing or unreadable') }
  else {
    const lam = chain.accounts.value?.get(keeper)?.lamports ?? (chain.accounts.ok ? 0 : null)
    const tone = solTone(lam === null ? null : lam / 1e9, 0.05, 0.2)
    kp.headline = formatSol(lam)
    kp.metrics.push(m('Balance', formatSol(lam), tone), m('Wallet', `${keeper.slice(0, 4)}…${keeper.slice(-4)}`))
    flag(kp, tone, 'Keeper is low on SOL')
    kp.links.push({ label: 'Solscan', url: `https://solscan.io/account/${keeper}` })
    const keeperAlerts = alerts?.last24h.keeper ?? 0
    if (keeperAlerts) { kp.metrics.push(m('Keeper alerts, 24 h', String(keeperAlerts), 'warn')); flag(kp, 'warn', `${keeperAlerts} keeper failures in 24 h`) }
  }
  const pp = add(node('pool-payer', 'Pool payer', 'wallet', 'Co-signs liquidity launches (Raydium\'s pool fee, refunded in the same transaction).'))
  {
    const lam = chain.accounts.value?.get(POOL_PAYER)?.lamports ?? (chain.accounts.ok ? 0 : null)
    const tone = solTone(lam === null ? null : lam / 1e9, 0.005, 0.02)
    pp.headline = formatSol(lam)
    pp.metrics.push(m('Balance', formatSol(lam), tone), m('Wallet', `${POOL_PAYER.slice(0, 4)}…${POOL_PAYER.slice(-4)}`))
    flag(pp, tone, 'Pool payer is low on SOL')
    pp.links.push({ label: 'Solscan', url: `https://solscan.io/account/${POOL_PAYER}` })
  }

  // Keys: name + age, attached to their integration.
  for (const sdef of SECRETS) {
    const n = N[sdef.node]
    if (!n) continue
    const present = vd ? vd.envNames.has(sdef.name) : !!process.env[sdef.name]
    if (!present) continue
    const ageDays = vd?.envAges.get(sdef.name) ?? null
    const info: SecretInfo = { name: sdef.name, ageDays, rotateAfterDays: sdef.rotateAfterDays, tone: secretTone(ageDays, sdef.rotateAfterDays) }
    n.keys.push(info)
    if (info.tone === 'warn') flag(n, 'warn', `${sdef.name} is ${formatAge(ageDays)} (rotate after ${sdef.rotateAfterDays} d)`)
  }

  // Manual facts: renewal dates nobody's API exposes.
  for (const n of Object.values(N)) {
    if (n.manual.plan) n.metrics.unshift(m('Plan', n.manual.plan))
    if (n.manual.cost) n.metrics.push(m('Cost', n.manual.cost))
    if (n.manual.renewsOn) {
      const days = daysUntil(n.manual.renewsOn, now)
      const tone = renewalTone(days, 7)
      n.metrics.push(m('Renews', `${n.manual.renewsOn} (in ${days} d)`, tone))
      flag(n, tone, days < 0 ? 'Renewal date has passed: update it' : `Renews in ${days} days`)
      renewals.push({ nodeId: n.id, label: n.label, date: n.manual.renewsOn, source: 'manual', amount: n.manual.cost ?? null })
    } else if (n.id === 'helius' || n.id === 'jupiter') {
      n.problems.push('Add the plan and renewal date so the team sees it coming.')
    }
  }

  const edges: CcEdge[] = [
    { from: 'site', to: 'vercel', label: 'hosted on' },
    { from: 'vercel', to: 'domain-ssr', label: 'serves' },
    { from: 'vercel', to: 'domain-test', label: 'serves' },
    { from: 'github', to: 'vercel', label: 'deploys' },
    { from: 'site', to: 'neon', label: 'data' },
    { from: 'site', to: 'helius', label: 'RPC' },
    { from: 'site', to: 'jupiter', label: 'swap routes' },
    { from: 'site', to: 'sheets', label: 'feedback' },
    { from: 'site', to: 'program', label: 'transactions' },
    { from: 'site', to: 'telegram', label: 'alerts' },
    { from: 'helius', to: 'telegram', label: 'failed-tx webhook' },
    { from: 'program', to: 'squads', label: 'upgrade authority' },
    { from: 'program', to: 'raydium', label: 'pools' },
    { from: 'vercel', to: 'keeper', label: 'hourly cron' },
    { from: 'keeper', to: 'program', label: 'settles fees' },
    { from: 'keeper', to: 'jupiter', label: 'fee swaps' },
    { from: 'pool-payer', to: 'raydium', label: 'creates pools' },
  ]

  renewals.sort((a, b) => a.date.localeCompare(b.date))
  const nodes = NODE_IDS.map((id) => N[id]).filter(Boolean)
  return { generatedAt: new Date(now).toISOString(), source: 'ssr.fun', nodes, edges, renewals, summary: summarize(nodes), alerts }
}
