// Command center (DEC-0264): live probes of every integration ssr.fun depends
// on, run ONLY by the production deployment (api/dashboard/commandcenter.ts
// forwards every other deployment's request here), so each value is
// ssr.fun's: its keys, its env, its wallets.
//
// Rules: a probe never throws (its failure is the finding), never returns a
// secret value (keys are reported by name, age and whether the service
// answers), and every external call has a timeout.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { neon } from '@neondatabase/serverless'
import {
  CLOSED_FEEDBACK, DAYS_PER_MONTH, daysBetween, daysUntil, formatAge, formatUsd, formatUsdc, latencyTone, parseMonthlyCost, projectToMonth, renewalTone,
  secretTone, solBurnPerDay, solTone, summarize, worst,
  type BurnGroup, type BurnRate, type CcEdge, type CcNode, type CommandCenterState, type DrawerList, type ListItem, type ManualFacts, type Metric, type Renewal,
  type SecretInfo, type Tone, type WatchItem,
} from './model.js'
import { readSolSamples, recordSolSample } from './balances.js'

const TIMEOUT_MS = 8_000
const VERCEL_TEAM_SLUG = 'ssr14'
const VERCEL_PROJECT = 'ssr-fun'
const PROGRAM_ID = '8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'
const PROGRAM_DATA = '2YF7aofgPbNj96pJJh1uzLtCk4H2fUq1FVLxFf9TAwow'
/** PDA ["protocol_config"]; treasury and admins are read from it live, so a change shows up here. */
const PROTOCOL_CONFIG = '5dhEfqb5wLy5yxZwYwZCXNsW2ALYoEbeYBfuR8B3ud88'
const SQUADS_MULTISIG = 'G8pgvV8wGrscorppA3VrcAWrV6QGP4TvTps1czaejzH8'
const SQUADS_VAULT = 'HFmqpPVVdMRcwaSKkbxLNga8byBJb3LK1FsURsDQqYoW'
const POOL_PAYER = '6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS'
const RAYDIUM_PERMISSION = 'HqMmvmtRUHup5ACL7mTf5bCj6STYB6ZUMgnd4CN8LmLB'
const GITHUB_REPO = 'JRA-EF/SSR.FUN'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
/** Squads signers we can name; anything else shows as a short address. */
const KNOWN_SIGNERS: Record<string, string> = {
  EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq: 'Creator',
  PSpQGPvw7tZedKJvN21dJkh3vdDQeXkwA5n9DKBRZw5: 'Boss',
}
/** A local git snapshot older than this is shown as stale (scripts/command_center_git_snapshot.mjs runs hourly). */
const GIT_SNAPSHOT_STALE_H = 3

export const NODE_IDS = [
  'site', 'vercel', 'domain-ssr', 'domain-test', 'github', 'neon', 'helius', 'jupiter', 'telegram', 'sheets',
  'program', 'squads', 'raydium', 'treasury', 'authority', 'admin-2', 'keeper', 'pool-payer',
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
  { name: 'FEEDBACK_DAEMON_SECRET', node: 'vercel', rotateAfterDays: 180 },
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

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

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

function jupiterHeaders(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY
  return key ? { 'x-api-key': key } : {}
}

function jupiterBase(): string {
  return (process.env.JUPITER_API_BASE || 'https://api.jup.ag').replace(/\/+$/, '')
}

// ----------------------------------------------------------------- probes

interface ChainAccount { lamports: number; data: Buffer; owner: string }

interface ProtocolWallets { treasury: string | null; authority: string | null; admin2: string | null; paused: boolean | null }

async function probeChain() {
  const addrs = [PROGRAM_DATA, SQUADS_MULTISIG, RAYDIUM_PERMISSION, PROTOCOL_CONFIG]
  const health = await timed((signal) => rpc<string>('getHealth', [], signal))
  const accounts = await timed(async (signal) => {
    const r = await rpc<{ value: ({ lamports: number; owner: string; data: [string, string] } | null)[] }>(
      'getMultipleAccounts', [addrs, { encoding: 'base64', dataSlice: { offset: 0, length: 400 }, commitment: 'confirmed' }], signal)
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
  const members: string[] = []
  const ms = accounts.value?.get(SQUADS_MULTISIG)
  if (ms && ms.data.length >= 140) {
    threshold = ms.data.readUInt16LE(72)
    // Squads v4 Multisig: rent_collector is an Option<Pubkey> at byte 94, then bump, then Vec<Member{key, permissions u8}>.
    const at = 94 + (ms.data[94] === 1 ? 33 : 1) + 1
    const n = ms.data.length >= at + 4 ? ms.data.readUInt32LE(at) : 0
    for (let i = 0; i < n && at + 4 + (i + 1) * 33 <= ms.data.length; i++) members.push(base58Encode(ms.data.subarray(at + 4 + i * 33, at + 4 + i * 33 + 32)))
  }
  // ProtocolConfig: disc 8, schema 1, authority 32, admin_2 32, paused 1, max_assets 1, fee_bps 2, fee_destination 32.
  const pc = accounts.value?.get(PROTOCOL_CONFIG)
  const wallets: ProtocolWallets = pc && pc.data.length >= 109
    ? { authority: base58Encode(pc.data.subarray(9, 41)), admin2: base58Encode(pc.data.subarray(41, 73)), paused: pc.data[73] === 1, treasury: base58Encode(pc.data.subarray(77, 109)) }
    : { treasury: null, authority: null, admin2: null, paused: null }
  return { health, accounts, upgradeSlot, upgradeAuthority, upgradeTime: upgradeTime?.value ?? null, threshold, members, wallets }
}

interface TokenHolding { mint: string; symbol: string; amount: number; usd: number | null; atNav: boolean }
/** SSR Reserve Tokens by mint: ticker and latest NAV (USD per token) from the warm-cache snapshot and NAV history. */
type ReserveTokenInfo = Map<string, { ticker: string | null; nav: number | null }>
interface WalletValue { lamports: number | null; sol: number | null; usd: number | null; tokens: TokenHolding[]; unpriced: number }

const symbolCache = new Map<string, string>()

/** SOL plus every token account of each wallet, valued in USDC at Jupiter prices (USDC itself at 1). */
async function valueWallets(owners: string[], tokenOwners: Set<string>, reserveTokens: ReserveTokenInfo): Promise<{ values: Map<string, WalletValue>; solPrice: number | null }> {
  const out = new Map<string, WalletValue>()
  const uniq = [...new Set(owners)]
  const lamports = await timed(async (signal) => {
    const r = await rpc<{ value: ({ lamports: number } | null)[] }>('getMultipleAccounts', [uniq, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }], signal)
    return new Map(uniq.map((a, i) => [a, r.value[i]?.lamports ?? 0]))
  })
  const holdings = new Map<string, { mint: string; amount: number }[]>()
  await Promise.all([...tokenOwners].filter((o) => uniq.includes(o)).map(async (owner) => {
    const list: { mint: string; amount: number }[] = []
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const r = await timed((signal) => rpc<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }[] }>(
        'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }], signal))
      for (const a of r.value?.value ?? []) {
        const info = a.account.data.parsed.info
        const amount = info.tokenAmount.uiAmount ?? 0
        if (amount > 0) list.push({ mint: info.mint, amount })
      }
    }
    holdings.set(owner, list)
  }))
  const mints = [...new Set([SOL_MINT, ...[...holdings.values()].flat().map((h) => h.mint)])].filter((m) => m !== USDC_MINT)
  const prices = new Map<string, number>([[USDC_MINT, 1]])
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50)
    const r = await timed((signal) => getJson<Record<string, { usdPrice?: number } | null>>(`${jupiterBase()}/price/v3?ids=${batch.join(',')}`, { signal, headers: jupiterHeaders() }))
    for (const [m, p] of Object.entries(r.value ?? {})) if (p?.usdPrice) prices.set(m, p.usdPrice)
  }
  for (const [mint, info] of reserveTokens) if (info.ticker) symbolCache.set(mint, info.ticker)
  const unknown = mints.filter((m) => m !== SOL_MINT && !symbolCache.has(m)).slice(0, 100)
  if (unknown.length) {
    const r = await timed((signal) => getJson<{ id: string; symbol?: string }[]>(`${jupiterBase()}/tokens/v2/search?query=${unknown.join(',')}`, { signal, headers: jupiterHeaders() }))
    for (const t of r.value ?? []) if (t.symbol) symbolCache.set(t.id, t.symbol)
  }
  symbolCache.set(USDC_MINT, 'USDC')
  const solPrice = prices.get(SOL_MINT) ?? null
  for (const owner of uniq) {
    const lam = lamports.ok ? lamports.value!.get(owner) ?? 0 : null
    const sol = lam === null ? null : lam / 1e9
    const tokens: TokenHolding[] = (holdings.get(owner) ?? []).map((h) => {
      // A Reserve Token without a market price is valued at its NAV (what redeeming it would return).
      const market = prices.get(h.mint)
      const nav = market === undefined ? reserveTokens.get(h.mint)?.nav ?? undefined : undefined
      const p = market ?? nav ?? undefined
      return { mint: h.mint, symbol: symbolCache.get(h.mint) ?? short(h.mint), amount: h.amount, usd: p === undefined ? null : h.amount * p, atNav: market === undefined && nav !== undefined }
    }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1))
    const priced = tokens.reduce((s, t) => s + (t.usd ?? 0), 0)
    const usd = sol === null || solPrice === null ? null : sol * solPrice + priced
    out.set(owner, { lamports: lam, sol, usd, tokens, unpriced: tokens.filter((t) => t.usd === null).length })
  }
  return { values: out, solPrice }
}

/** Jupiter's rate-limit ceiling for a call with no key (measured 2026-10-29: remaining 4 + current 1). */
export const KEYLESS_JUPITER_LIMIT = 5

async function probeJupiter() {
  const key = process.env.JUPITER_API_KEY
  if (!key) return { configured: false as const }
  const t0 = Date.now()
  try {
    const r = await fetch(`${jupiterBase()}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=10000000&slippageBps=50`, {
      headers: { 'x-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // Jupiter sends x-ratelimit-remaining and x-ratelimit-current (no -limit header): the
    // key's ceiling per window is their sum. A key-less call gets 5; a paid plan gets more,
    // so this shows whether the production key is really on the paid plan.
    const remaining = r.headers.get('x-ratelimit-remaining')
    const current = r.headers.get('x-ratelimit-current')
    const limit = remaining !== null && current !== null && Number.isFinite(Number(remaining) + Number(current)) ? String(Number(remaining) + Number(current)) : null
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

interface SheetStats {
  total: number; last7d: number; avgRating7d: number | null; open: number; openLow: number
  newestOpen: { at: string; rating: number; subject: string; status: string }[]
}

async function probeSheets() {
  const url = process.env.FEEDBACK_SHEET_WEBHOOK_URL
  const secret = process.env.FEEDBACK_SHEET_SECRET
  if (!url) return { configured: false as const }
  const health = await timed((signal) => getJson<{ ok?: boolean }>(url, { signal, redirect: 'follow' }), 12_000)
  // Apps Script answers a POST with a 302 to the result; fetch follows it as a GET, which is what Google expects.
  const stats = secret
    ? await timed((signal) => getJson<{ ok?: boolean; error?: string } & Partial<SheetStats>>(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, action: 'stats', closed: CLOSED_FEEDBACK }), signal, redirect: 'follow',
    }), 15_000)
    : null
  const s = stats?.value?.ok ? (stats.value as SheetStats) : null
  return { configured: true as const, ok: health.ok && health.value?.ok === true, ms: health.ms, error: health.error, stats: s, statsError: stats && !s ? (stats.error ?? stats.value?.error ?? 'no stats') : null }
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

let schemaReady = false

/** Tables this page owns. ops_alert_reviews is separate from lib/ops-alerts' own tables on purpose: that pipeline stays untouched. */
export async function ensureTables(db: Sql): Promise<void> {
  if (schemaReady) return
  await db`CREATE TABLE IF NOT EXISTS command_center_facts (
    node text PRIMARY KEY, facts jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`
  await db`CREATE TABLE IF NOT EXISTS command_center_watch (
    id serial PRIMARY KEY, text text NOT NULL, added_by text NOT NULL DEFAULT 'team',
    added_at timestamptz NOT NULL DEFAULT now(), dismissed_at timestamptz)`
  await db`CREATE TABLE IF NOT EXISTS command_center_dismissed (
    key text PRIMARY KEY, dismissed_at timestamptz NOT NULL DEFAULT now())`
  await db`CREATE TABLE IF NOT EXISTS command_center_snapshots (
    kind text PRIMARY KEY, data jsonb NOT NULL, taken_at timestamptz NOT NULL DEFAULT now())`
  await db`CREATE TABLE IF NOT EXISTS ops_alert_reviews (
    fingerprint text PRIMARY KEY, reviewed_at timestamptz NOT NULL DEFAULT now(), reviewed_by text NOT NULL, note text)`
  await db`ALTER TABLE ops_alert_reviews ADD COLUMN IF NOT EXISTS outcome text`
  schemaReady = true
}

function requireSql(): Sql {
  const db = sql()
  if (!db) throw new Error('DATABASE_URL is not configured.')
  return db
}

export async function saveFacts(node: string, facts: ManualFacts): Promise<void> {
  const db = requireSql()
  await ensureTables(db)
  await db`INSERT INTO command_center_facts (node, facts, updated_at) VALUES (${node}, ${JSON.stringify(facts)}::jsonb, now())
    ON CONFLICT (node) DO UPDATE SET facts = EXCLUDED.facts, updated_at = now()`
}

export async function addWatch(text: string): Promise<void> {
  const db = requireSql()
  await ensureTables(db)
  await db`INSERT INTO command_center_watch (text) VALUES (${text})`
}

export async function dismissWatch(key: string): Promise<void> {
  const db = requireSql()
  await ensureTables(db)
  if (key.startsWith('team:')) await db`UPDATE command_center_watch SET dismissed_at = now() WHERE id = ${Number(key.slice(5))} AND dismissed_at IS NULL`
  else await db`INSERT INTO command_center_dismissed (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`
}

interface GitSnapshot {
  host?: string
  unpushed?: { branch: string; worktree?: string; ahead: number; commits: { sha: string; subject: string; date: string }[] }[]
  dirty?: { worktree: string; branch: string; files: number }[]
  unmerged?: { branch: string; ahead: number; lastCommit: string; subject: string }[]
}

async function probeNeon() {
  const db = sql()
  if (!db) return { configured: false as const }
  const ping = await timed(async () => { await db`SELECT 1`; return true })
  if (!ping.ok) return { configured: true as const, ok: false, ms: ping.ms, error: ping.error }
  await ensureTables(db).catch(() => undefined)
  const [size, facts, alerts, unreviewed, watch, git, dismissed, reserveTokens, reviewed] = await Promise.all([
    timed(async () => ((await db`SELECT pg_database_size(current_database())::bigint AS b`) as { b: string }[])[0]?.b),
    timed(async () => {
      const rows = (await db`SELECT node, facts, updated_at FROM command_center_facts`) as { node: string; facts: ManualFacts; updated_at: string }[]
      return new Map(rows.map((r) => [r.node, { ...r.facts, updatedAt: new Date(r.updated_at).toISOString() }]))
    }),
    timed(async () => {
      const counts = (await db`SELECT source, count(*)::int AS n FROM ops_alert_events WHERE at > now() - interval '24 hours' GROUP BY source`) as { source: string; n: number }[]
      const recent = (await db`SELECT at, source, step, message FROM ops_alert_events ORDER BY at DESC LIMIT 6`) as { at: string; source: string; step: string; message: string }[]
      return {
        last24h: Object.fromEntries(counts.map((c) => [c.source, c.n])),
        recent: recent.map((r) => ({ at: new Date(r.at).toISOString(), source: r.source, step: r.step, message: scrub(r.message).slice(0, 160) })),
      }
    }),
    // Each kind of failure (fingerprint) Claude has not reviewed since it last happened (scripts/review_ops_alerts.mjs marks them).
    timed(async () => (await db`
      SELECT a.fingerprint, a.source, a.step, a.last_seen,
        (SELECT count(*) FROM ops_alert_events e WHERE e.fingerprint = a.fingerprint AND (r.reviewed_at IS NULL OR e.at > r.reviewed_at))::int AS since,
        (SELECT message FROM ops_alert_events e WHERE e.fingerprint = a.fingerprint ORDER BY e.at DESC LIMIT 1) AS message
      FROM ops_alerts a LEFT JOIN ops_alert_reviews r ON r.fingerprint = a.fingerprint
      WHERE r.reviewed_at IS NULL OR a.last_seen > r.reviewed_at
      ORDER BY a.last_seen DESC LIMIT 30`) as { fingerprint: string; source: string; step: string; last_seen: string; since: number; message: string | null }[]),
    timed(async () => (await db`SELECT id, text, added_by, added_at FROM command_center_watch WHERE dismissed_at IS NULL ORDER BY added_at DESC LIMIT 40`) as
      { id: number; text: string; added_by: string; added_at: string }[]),
    timed(async () => ((await db`SELECT data, taken_at FROM command_center_snapshots WHERE kind = 'git'`) as { data: GitSnapshot; taken_at: string }[])[0] ?? null),
    timed(async () => new Set(((await db`SELECT key FROM command_center_dismissed`) as { key: string }[]).map((r) => r.key))),
    timed(async () => {
      const [snap] = (await db`SELECT snapshot->'reserves' AS reserves, snapshot->'metadataByReserve' AS meta FROM reserve_snapshot
        WHERE cluster = 'mainnet-beta' ORDER BY generated_at DESC LIMIT 1`) as { reserves: { reserve: string; reserveTokenMint: string }[] | null; meta: Record<string, { ticker?: string }> | null }[]
      const navs = (await db`SELECT DISTINCT ON (reserve) reserve, nav_usd FROM reserve_nav_history
        WHERE cluster = 'mainnet-beta' AND t > now() - interval '3 days' ORDER BY reserve, t DESC`) as { reserve: string; nav_usd: number }[]
      const navBy = new Map(navs.map((n) => [n.reserve, Number(n.nav_usd)]))
      const out: ReserveTokenInfo = new Map()
      for (const r of snap?.reserves ?? []) out.set(r.reserveTokenMint, { ticker: snap?.meta?.[r.reserve]?.ticker ?? null, nav: navBy.get(r.reserve) ?? null })
      return out
    }),
    // Reviews still in force (the error has not happened again since), newest first.
    timed(async () => (await db`
      SELECT r.reviewed_at, r.reviewed_by, r.note, r.outcome, a.source, a.step, a.count,
        (SELECT message FROM ops_alert_events e WHERE e.fingerprint = a.fingerprint ORDER BY e.at DESC LIMIT 1) AS message
      FROM ops_alert_reviews r JOIN ops_alerts a ON a.fingerprint = r.fingerprint
      WHERE a.last_seen <= r.reviewed_at
      ORDER BY (r.outcome = 'not_fixed') DESC, r.reviewed_at DESC LIMIT 25`) as
      { reviewed_at: string; reviewed_by: string; note: string | null; outcome: string | null; source: string; step: string; count: number; message: string | null }[]),
  ])
  return {
    configured: true as const, ok: true, ms: ping.ms,
    sizeBytes: size.value ? Number(size.value) : null,
    facts: facts.value ?? new Map<string, ManualFacts>(),
    alerts: alerts.ok ? alerts.value ?? null : null,
    unreviewed: unreviewed.ok ? unreviewed.value ?? [] : null,
    watch: watch.ok ? watch.value ?? [] : [],
    git: git.ok ? git.value ?? null : null,
    dismissed: dismissed.value ?? new Set<string>(),
    reserveTokens: reserveTokens.value ?? (new Map() as ReserveTokenInfo),
    reviewed: reviewed.ok ? reviewed.value ?? [] : [],
  }
}

/** Open items from decision-log entries of the last 60 days (bundled via vercel.json includeFiles). */
function decisionOpenItems(now: number): { dec: string; text: string }[] {
  try {
    const log = fs.readFileSync(path.join(process.cwd(), 'docs/project/DECISION_LOG.md'), 'utf8')
    const out: { dec: string; text: string }[] = []
    for (const m of log.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)) {
      try {
        const e = JSON.parse(m[1]) as { id?: string; date?: string; openItems?: unknown }
        if (!e.id || !e.date || !Array.isArray(e.openItems) || now - Date.parse(e.date) > 60 * 86_400_000) continue
        for (const t of e.openItems) if (typeof t === 'string') out.push({ dec: e.id, text: t })
      } catch { /* an entry that is not JSON */ }
    }
    return out
  } catch {
    return []
  }
}

// --------------------------------------------------------------- assembly

function node(id: string, label: string, kind: CcNode['kind'], impact: string): CcNode {
  return { id, label, kind, status: 'ok', headline: '', impact, problems: [], metrics: [], keys: [], links: [], manual: {}, editable: EDITABLE.has(id), lists: [], usd: null }
}

function flag(n: CcNode, tone: Tone, problem?: string) {
  n.status = worst(n.status, tone)
  if (problem && tone !== 'ok') n.problems.push(problem)
}

function m(label: string, value: string, tone?: Tone): Metric {
  return tone ? { label, value, tone } : { label, value }
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

function walletList(v: WalletValue | undefined): DrawerList | null {
  if (!v) return null
  const items: ListItem[] = []
  if (v.sol !== null) items.push({ primary: `${v.sol.toFixed(4)} SOL`, secondary: 'native balance' })
  for (const t of v.tokens.slice(0, 12)) {
    items.push({ primary: `${t.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${t.symbol}`, secondary: t.usd === null ? 'no price' : `${formatUsdc(t.usd)}${t.atNav ? ' at NAV' : ''}`, tone: t.usd === null ? 'unknown' : undefined, url: `https://solscan.io/token/${t.mint}` })
  }
  if (v.tokens.length > 12) items.push({ primary: `+${v.tokens.length - 12} more tokens` })
  const navCount = v.tokens.filter((t) => t.atNav).length
  const notes = [
    navCount ? `${navCount} Reserve Token${navCount > 1 ? 's are' : ' is'} valued at NAV (no market price).` : '',
    v.unpriced ? `${v.unpriced} token${v.unpriced > 1 ? 's have' : ' has'} no price at all and ${v.unpriced > 1 ? 'are' : 'is'} not in the total.` : '',
  ].filter(Boolean).join(' ')
  return { title: 'Holdings', items, note: notes || undefined }
}

export async function collectCommandCenter(now = Date.now()): Promise<CommandCenterState> {
  const keeper = publicKeyFromSecret(process.env.SSR_FEE_SETTLEMENT_KEEPER_SECRET)
  const [chain, jup, tg, sheets, hook, site, dSsr, dTest, gh, vercel, db] = await Promise.all([
    probeChain(), probeJupiter(), probeTelegram(), probeSheets(), probeHeliusWebhook(), probeSite(),
    probeDomain('ssr.fun'), probeDomain('strategic-super-reserve.fun'), probeGithub(), probeVercel(), probeNeon(),
  ])
  const pw = chain.wallets
  const fullWallets = [pw.treasury, pw.authority, pw.admin2, SQUADS_VAULT, keeper, POOL_PAYER].filter((a): a is string => !!a)
  const reserveTokens = (db.configured && db.ok ? db.reserveTokens : null) ?? (new Map() as ReserveTokenInfo)
  const { values, solPrice } = await valueWallets([...fullWallets, ...chain.members], new Set(fullWallets), reserveTokens)
    .catch(() => ({ values: new Map<string, WalletValue>(), solPrice: null }))
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
  if (pw.paused) flag(s, 'down', 'The protocol is PAUSED on-chain: mints, redeems and launches are refused')
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

  // GitHub + this PC's git state (snapshot pushed hourly by scripts/command_center_git_snapshot.mjs)
  const g = add(node('github', 'GitHub', 'service', 'Source of every deploy. Work that only exists on one PC is lost with that PC; the repository is public, so secrets must never be committed.'))
  g.links.push({ label: 'Repository', url: `https://github.com/${GITHUB_REPO}` }, { label: 'Branches', url: `https://github.com/${GITHUB_REPO}/branches` })
  if (gh.ok && gh.value) {
    g.headline = `pushed ${ago(gh.value.pushedAt, now)}`
    g.metrics.push(m('Visibility', gh.value.visibility, gh.value.visibility === 'public' ? 'warn' : 'ok'), m('Last push', gh.value.pushedAt.slice(0, 16).replace('T', ' ') + ' UTC'))
  } else { g.headline = 'API unavailable'; flag(g, 'unknown'); g.problems.push(`GitHub: ${gh.error ?? 'no data'}`) }
  const git = db.configured && db.ok ? db.git : null
  if (!git) { flag(g, 'unknown'); g.problems.push('No local git snapshot yet: run scripts/command_center_git_snapshot.mjs on the dev PC.') }
  else {
    const age = (now - Date.parse(git.taken_at)) / 3600_000
    const snap = git.data
    const unpushed = snap.unpushed ?? []
    const commits = unpushed.reduce((a, b) => a + b.ahead, 0)
    const unmerged = snap.unmerged ?? []
    const dirty = snap.dirty ?? []
    g.metrics.push(
      m('Commits not on GitHub', `${commits} in ${unpushed.length} branch${unpushed.length === 1 ? '' : 'es'}`, commits ? 'warn' : 'ok'),
      m('Branches not merged into main', String(unmerged.length), unmerged.length > 10 ? 'warn' : undefined),
      m('Worktrees with uncommitted changes', String(dirty.length), dirty.length ? 'warn' : 'ok'),
      m('Snapshot', `${snap.host ?? 'dev PC'} · ${ago(git.taken_at, now)}`, age > GIT_SNAPSHOT_STALE_H ? 'warn' : undefined),
    )
    if (commits) { g.headline = `${commits} commit${commits === 1 ? '' : 's'} not pushed`; flag(g, 'warn', `${commits} commit${commits === 1 ? ' exists' : 's exist'} only on ${snap.host ?? 'the dev PC'}: push or delete them`) }
    if (dirty.length) flag(g, 'warn', `${dirty.length} worktree${dirty.length === 1 ? ' has' : 's have'} uncommitted changes`)
    if (age > GIT_SNAPSHOT_STALE_H) flag(g, 'warn', `Git snapshot is ${Math.round(age)} h old (the hourly task may have stopped)`)
    g.lists.push({
      title: 'Not on GitHub yet', empty: 'Every local commit is pushed.',
      items: unpushed.flatMap((b) => b.commits.slice(0, 4).map((c, i) => ({ primary: c.subject, secondary: `${b.branch}${b.worktree ? ` · ${b.worktree}` : ''} · ${c.sha.slice(0, 7)} · ${c.date.slice(0, 10)}${i === 3 && b.ahead > 4 ? ` · +${b.ahead - 4} more` : ''}`, tone: 'warn' as Tone }))),
    })
    if (dirty.length) g.lists.push({ title: 'Uncommitted changes', items: dirty.map((d) => ({ primary: d.worktree, secondary: `${d.branch} · ${d.files} file${d.files === 1 ? '' : 's'}`, tone: 'warn' as Tone })) })
    g.lists.push({ title: 'Branches on GitHub not merged into main', empty: 'None.', items: unmerged.slice(0, 15).map((b) => ({ primary: b.branch, secondary: `${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead · ${b.lastCommit.slice(0, 10)} · ${b.subject}`, url: `https://github.com/${GITHUB_REPO}/tree/${b.branch}` })) })
  }

  // Neon
  const ne = add(node('neon', 'Neon Postgres', 'service', 'Names, pictures, volume, NAV history, rate limits, alerts and feedback. Down = cards lose names and All-Time Volume shows Unavailable.'))
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
  const j = add(node('jupiter', 'Jupiter API', 'service', 'Swap routes and prices for mint, redeem, rebalance and the keeper\'s fee swaps. Rate limited = those fail.'))
  j.links.push({ label: 'Portal', url: 'https://portal.jup.ag' })
  if (!jup.configured) { j.headline = 'no key'; flag(j, 'down', 'JUPITER_API_KEY is missing') }
  else if (jup.status === 200) {
    j.headline = `quoting · ${jup.ms} ms`
    j.metrics.push(m('Test quote', `ok in ${jup.ms} ms`, latencyTone(jup.ms, 2500)))
    if (jup.remaining && jup.limit) {
      const tone: Tone = Number(jup.remaining) < Number(jup.limit) * 0.1 ? 'warn' : 'ok'
      j.metrics.push(m('Rate limit left', `${jup.remaining} / ${jup.limit}`, tone))
      flag(j, tone, 'Close to the Jupiter rate limit')
      // 5 per window is what Jupiter gives a call with no key at all: a key at that ceiling is not on the paid plan.
      if (Number(jup.limit) <= KEYLESS_JUPITER_LIMIT) { j.metrics.push(m('Plan', `key limit ${jup.limit} = free tier, not the paid plan`, 'warn')); flag(j, 'warn', 'The production Jupiter key gets the free-tier rate limit: it is not on the paid plan') }
    }
  } else if (jup.status === 429) { j.headline = 'RATE LIMITED'; flag(j, 'down', 'Jupiter answered 429 Too Many Requests: swaps and keeper fee swaps fail') }
  else if (jup.status === 401 || jup.status === 403) { j.headline = 'key rejected'; flag(j, 'down', `Jupiter rejected the key (HTTP ${jup.status})`) }
  else { j.headline = 'error'; flag(j, 'down', `Test quote failed: ${'error' in jup && jup.error ? jup.error : `HTTP ${jup.status}`}`) }

  // Telegram alerts (the watcher) + which failures Claude has not reviewed yet
  const t = add(node('telegram', 'Error watcher', 'service', 'Failed mints, on-chain failures and keeper problems post to the team Telegram group. A failure nobody looks into repeats for every user.'))
  if (!tg.configured) { t.headline = 'not configured'; flag(t, 'warn', 'Alerts are logged but not posted (no bot token)') }
  else if (!tg.ok) { t.headline = 'bot rejected'; flag(t, 'down', `Bot check failed: ${tg.error ?? 'not ok'}`) }
  else { t.headline = `@${tg.username ?? 'bot'} online`; t.metrics.push(m('Telegram bot', `@${tg.username} answers in ${tg.ms} ms`)) }
  const alerts = (db.configured && db.ok ? db.alerts : null) ?? null
  if (alerts) {
    const total = Object.values(alerts.last24h).reduce((a, b) => a + b, 0)
    t.metrics.push(m('Alerts, last 24 h', total ? Object.entries(alerts.last24h).map(([k, n]) => `${k} ${n}`).join(' · ') : 'none', total ? 'warn' : 'ok'))
  }
  const unreviewed = db.configured && db.ok ? db.unreviewed : null
  if (unreviewed) {
    const events = unreviewed.reduce((a, b) => a + b.since, 0)
    t.metrics.push(m('Not yet reviewed by Claude', unreviewed.length ? `${unreviewed.length} kind${unreviewed.length === 1 ? '' : 's'} · ${events} event${events === 1 ? '' : 's'}` : 'all reviewed', unreviewed.length ? 'warn' : 'ok'))
    if (unreviewed.length) {
      t.headline = `${unreviewed.length} to review`
      flag(t, 'warn', `${unreviewed.length} kind${unreviewed.length === 1 ? '' : 's'} of error not reviewed yet: ask Claude to run scripts/review_ops_alerts.mjs`)
    }
    t.lists.push({
      title: 'Errors not yet reviewed by Claude', empty: 'Every error has been looked into.',
      note: 'Claude marks a kind of error reviewed after investigating it (scripts/review_ops_alerts.mjs). If it happens again later, it comes back here.',
      items: unreviewed.map((u) => ({ primary: scrub(u.message ?? u.step).slice(0, 150), secondary: `${u.source} · ${u.step} · ${u.since}× since last review · last ${ago(new Date(u.last_seen).toISOString(), now)}`, tone: (u.source === 'keeper' || u.source === 'chain' ? 'warn' : 'unknown') as Tone })),
    })
  }
  const reviewed = (db.configured && db.ok ? db.reviewed : null) ?? []
  const notFixed = reviewed.filter((r) => r.outcome === 'not_fixed')
  if (notFixed.length) {
    t.metrics.push(m('Known, not fixed yet', String(notFixed.length), 'warn'))
    for (const r of notFixed) flag(t, 'warn', `Known error, not fixed yet: ${r.source}/${r.step}${r.note ? ` -- ${r.note.slice(0, 120)}` : ''}`)
  }
  if (reviewed.length) {
    const label: Record<string, string> = { fixed: 'Fixed', false_positive: 'False positive', user_error: 'User error', not_fixed: 'NOT FIXED' }
    const tone: Record<string, Tone> = { fixed: 'ok', false_positive: 'unknown', user_error: 'unknown', not_fixed: 'warn' }
    t.lists.push({
      title: 'Reviewed errors',
      note: 'Each kind of error Claude looked into, with the outcome. Fixed, false positive and user error drop off this list if the error happens again (it goes back to "not yet reviewed").',
      items: reviewed.map((r) => ({
        primary: `${label[r.outcome ?? ''] ?? 'Reviewed'} · ${r.note ?? scrub(r.message ?? r.step).slice(0, 140)}`,
        secondary: `${r.source} · ${r.step} · ${r.count}× total · by ${r.reviewed_by} ${ago(new Date(r.reviewed_at).toISOString(), now)}`,
        tone: tone[r.outcome ?? ''] ?? 'ok',
      })),
    })
  }

  // In-app feedback Sheet
  const sh = add(node('sheets', 'Feedback sheet', 'service', 'In-app feedback from ssr.fun lands here. Down = the feedback page shows an error and users\' reports are lost.'))
  sh.links.push({ label: 'Open sheet', url: 'https://docs.google.com/spreadsheets/d/1CcPwOu3bZqECxNbE4neOkEeBY0mX1UD70SvBnB08Ygc' })
  if (!sheets.configured) { sh.headline = 'not configured'; flag(sh, 'warn', 'Feedback webhook is not set') }
  else if (!sheets.ok) { sh.headline = 'webhook down'; flag(sh, 'down', `Apps Script health check failed: ${sheets.error ?? 'not ok'}`) }
  else sh.headline = `webhook ok · ${sheets.ms} ms`
  if (sheets.configured && sheets.stats) {
    const st = sheets.stats
    sh.headline = `${st.open} open · ${st.total} total`
    sh.metrics.push(
      m('Open (no Status yet)', String(st.open), st.open ? 'warn' : 'ok'),
      m('Open with 1-2 stars', String(st.openLow), st.openLow ? 'down' : 'ok'),
      m('Received, last 7 days', String(st.last7d)),
      m('Average rating, 7 days', st.avgRating7d === null ? 'no ratings' : `${st.avgRating7d.toFixed(1)} / 5`, st.avgRating7d !== null && st.avgRating7d < 3 ? 'warn' : undefined),
      m('All feedback', String(st.total)),
    )
    if (st.openLow) flag(sh, 'warn', `${st.openLow} open low rating${st.openLow === 1 ? '' : 's'} (1-2 stars) waiting for a reply`)
    sh.lists.push({
      title: 'Newest open feedback', empty: 'Nothing open.', note: 'Mark a row done by typing resolved, done, fixed or won\'t fix in the sheet\'s Status column.',
      items: st.newestOpen.map((f) => ({ primary: f.subject || '(no summary)', secondary: `${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} · ${f.at.slice(0, 10)}${f.status ? ` · ${f.status}` : ''}`, tone: (f.rating <= 2 ? 'down' : f.rating === 3 ? 'warn' : 'ok') as Tone })),
    })
  } else if (sheets.configured && sheets.statsError) sh.metrics.push(m('Counts', `unavailable (${sheets.statsError})`, 'unknown'))

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
  if (pw.paused !== null) p.metrics.push(m('Protocol', pw.paused ? 'PAUSED' : 'running', pw.paused ? 'down' : 'ok'))
  const q = add(node('squads', 'Squads multisig', 'chain', 'Approves every program upgrade. Its vault is the upgrade authority; each signer needs SOL to approve.'))
  q.links.push({ label: 'Squads', url: `https://app.squads.so/squads/${SQUADS_MULTISIG}/home` })
  if (chain.threshold === null) { q.headline = 'unreadable'; flag(q, 'unknown') }
  else {
    q.headline = `${chain.threshold} of ${chain.members.length || '?'} signers`
    const tone: Tone = chain.threshold < 2 ? 'warn' : 'ok'
    q.metrics.push(m('Threshold', `${chain.threshold} of ${chain.members.length || '?'}`, tone))
    flag(q, tone, 'One signer can upgrade the program alone')
    const vault = values.get(SQUADS_VAULT)
    if (vault) { q.metrics.push(m('Vault', formatUsdc(vault.usd))); q.usd = vault.usd }
    q.lists.push({
      title: 'Signers', items: chain.members.map((a) => {
        const sol = values.get(a)?.sol ?? null
        return { primary: `${KNOWN_SIGNERS[a] ?? 'Signer'} · ${short(a)}`, secondary: sol === null ? 'balance unknown' : `${sol.toFixed(4)} SOL${sol < 0.02 ? ' (too little to sign an upgrade)' : ''}`, tone: (sol !== null && sol < 0.02 ? 'warn' : 'ok') as Tone, url: `https://solscan.io/account/${a}` }
      }),
    })
    const broke = chain.members.filter((a) => (values.get(a)?.sol ?? 1) < 0.02).length
    if (broke) flag(q, 'warn', `${broke} signer${broke === 1 ? ' has' : 's have'} under 0.02 SOL and cannot approve an upgrade`)
  }
  const ry = add(node('raydium', 'Raydium CPMM', 'chain', 'Pool creation for liquidity launches needs this permission.'))
  const perm = chain.accounts.value?.get(RAYDIUM_PERMISSION)
  if (!chain.accounts.ok) { ry.headline = 'unreadable'; flag(ry, 'unknown') }
  else if (!perm) { ry.headline = 'permission missing'; flag(ry, 'down', 'The pool-creation permission account no longer exists') }
  else { ry.headline = 'permission active'; ry.metrics.push(m('Permission', 'pool payer is whitelisted')) }

  // Protocol wallets, each valued in USDC.
  const wallet = (id: string, label: string, addr: string | null, impact: string, sol: { down: number; warn: number } | null) => {
    const n = add(node(id, label, 'wallet', impact))
    if (!addr) { n.headline = 'unknown address'; flag(n, 'unknown'); return n }
    const val = values.get(addr)
    n.usd = val?.usd ?? null
    n.headline = val ? formatUsdc(val.usd) : 'balance unknown'
    n.metrics.push(m('Address', short(addr)), m('Value', formatUsdc(val?.usd ?? null)), m('SOL', val?.sol === null || !val ? 'unknown' : `${val.sol.toFixed(4)} SOL`, sol && val?.sol != null ? solTone(val.sol, sol.down, sol.warn) : undefined))
    if (sol && val?.sol != null) flag(n, solTone(val.sol, sol.down, sol.warn), `${label} has ${val.sol.toFixed(4)} SOL for fees`)
    const list = walletList(val); if (list && list.items.length) n.lists.push(list)
    n.links.push({ label: 'Solscan', url: `https://solscan.io/account/${addr}` })
    return n
  }
  wallet('treasury', 'Treasury', pw.treasury, 'Receives every protocol fee (mint fees in USDC, transfer fees and SSR\'s share of trade taxes). Read live from the on-chain protocol config.', null)
  wallet('authority', 'Protocol authority', pw.authority, 'Admin of the protocol config and the usual payer for program upgrade buffers. Its key is shared: watch for unexpected outflows.', { down: 0.01, warn: 0.1 })
  const a2 = wallet('admin-2', 'Second admin', pw.admin2, 'The second approved protocol admin. This is a person\'s own wallet (the Boss), so its holdings are not counted in the protocol total.', null)
  if (pw.admin2 && KNOWN_SIGNERS[pw.admin2]) a2.label = `Second admin (${KNOWN_SIGNERS[pw.admin2]})`
  const kp = wallet('keeper', 'Fee keeper', keeper, 'Settles fees hourly and feeds holder shares. Out of SOL = settlement stops (it did once, Sept 2026).', { down: 0.05, warn: 0.2 })
  if (!keeper) { kp.problems = ['SSR_FEE_SETTLEMENT_KEEPER_SECRET is missing or unreadable']; kp.status = 'down'; kp.headline = 'no key' }
  const keeperAlerts = alerts?.last24h.keeper ?? 0
  if (keeper && keeperAlerts) { kp.metrics.push(m('Keeper alerts, 24 h', String(keeperAlerts), 'warn')); flag(kp, 'warn', `${keeperAlerts} keeper failure${keeperAlerts === 1 ? '' : 's'} in 24 h`) }
  wallet('pool-payer', 'Pool payer', POOL_PAYER, 'Co-signs liquidity launches (Raydium\'s pool fee, refunded in the same transaction).', { down: 0.005, warn: 0.02 })

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
    { from: 'program', to: 'treasury', label: 'protocol fees' },
    { from: 'authority', to: 'program', label: 'config admin' },
    { from: 'admin-2', to: 'program', label: 'config admin' },
    { from: 'vercel', to: 'keeper', label: 'hourly cron' },
    { from: 'keeper', to: 'program', label: 'settles fees' },
    { from: 'keeper', to: 'jupiter', label: 'fee swaps' },
    { from: 'pool-payer', to: 'raydium', label: 'creates pools' },
  ]

  // Watch list: live problems (worst first), open decision-log items, team notes.
  const watch: WatchItem[] = []
  const nodes = NODE_IDS.map((id) => N[id]).filter(Boolean)
  for (const n of nodes) {
    if (n.status === 'ok') continue
    n.problems.forEach((pr, i) => {
      if (/^Add the plan|^Add VERCEL_API_TOKEN/.test(pr)) return
      watch.push({ id: `live:${n.id}:${i}`, text: pr, tone: n.status, source: 'live', nodeId: n.id, detail: n.label })
    })
  }
  const RANK: Record<Tone, number> = { down: 0, warn: 1, unknown: 2, ok: 3 }
  watch.sort((a, b) => RANK[a.tone] - RANK[b.tone])
  const dismissed = (db.configured && db.ok ? db.dismissed : null) ?? new Set<string>()
  for (const d of decisionOpenItems(now)) {
    const id = `dec:${d.dec}:${createHash('sha256').update(d.text).digest('hex').slice(0, 10)}`
    if (!dismissed.has(id)) watch.push({ id, text: d.text, tone: 'warn', source: 'decision', detail: d.dec })
  }
  for (const w of (db.configured && db.ok ? db.watch : null) ?? []) watch.push({ id: `team:${w.id}`, text: w.text, tone: 'unknown', source: 'team', detail: `added by ${w.added_by} · ${ago(new Date(w.added_at).toISOString(), now)}` })

  // Protocol money only: the second admin is a person's own wallet.
  const walletIds = ['treasury', 'authority', 'keeper', 'pool-payer', 'squads']
  const walletVals = walletIds.map((id) => N[id]?.usd ?? null)
  const walletsUsd = walletVals.every((x) => x === null) ? null : walletVals.reduce<number>((a, b) => a + (b ?? 0), 0)

  const burn = await burnRate({ N, facts, vd, values, solPrice, keeper, now })

  renewals.sort((a, b) => a.date.localeCompare(b.date))
  return { generatedAt: new Date(now).toISOString(), source: 'ssr.fun', nodes, edges, renewals, burn, summary: summarize(nodes), alerts, watch, walletsUsd }
}

/** Services whose cost is entered on their card (Vercel's comes live from its billing API when connected). */
const SUBSCRIPTION_NODES = ['vercel', 'helius', 'jupiter', 'neon', 'github', 'domain-ssr', 'domain-test', 'telegram', 'sheets']
/** Free by nature (Telegram's bot API, a Google Sheet): not listed as missing unless a cost is typed on the card. */
const FREE_UNLESS_ENTERED = new Set(['telegram', 'sheets'])

/** Monthly running cost: subscriptions typed on the cards, Vercel usage, and SOL the keeper and pool payer spend on fees. */
async function burnRate(i: {
  N: Record<string, CcNode>; facts: Map<string, ManualFacts>; vd: VercelData | null
  values: Map<string, WalletValue>; solPrice: number | null; keeper: string | null; now: number
}): Promise<BurnRate> {
  const groups: BurnGroup[] = []
  const notCounted: BurnRate['notCounted'] = []
  const label = (id: string) => i.N[id]?.label ?? id

  const subs: BurnGroup = { title: 'Subscriptions', usd: 0, lines: [] }
  for (const id of SUBSCRIPTION_NODES) {
    const cost = i.facts.get(id)?.cost
    if (id === 'vercel' && i.vd?.spend != null) {
      const { spend, periodStart, periodEnd } = i.vd
      const projected = periodStart && periodEnd ? projectToMonth(spend, periodStart, periodEnd, i.now) : null
      const top = i.vd.topSpend.map((t) => `${t.name} ${formatUsd(t.usd)}`).join(', ')
      subs.lines.push({
        label: 'Vercel', nodeId: id, source: 'live', usd: projected ?? spend,
        detail: `${formatUsd(spend)} so far this cycle${projected !== null ? `, on pace for ${formatUsd(projected)}` : ''}${top ? ` · ${top}` : ''}`,
      })
      continue
    }
    const monthly = parseMonthlyCost(cost)
    if (monthly === null && !cost && FREE_UNLESS_ENTERED.has(id)) continue
    if (monthly === null) {
      notCounted.push({ label: label(id), nodeId: id, why: cost ? `cost "${cost}" has no amount to read` : 'no cost entered on its card (type "free" if it costs nothing)' })
      continue
    }
    if (monthly > 0) subs.lines.push({ label: label(id), nodeId: id, source: 'entered', usd: monthly, detail: cost! })
  }
  groups.push(subs)

  const gas: BurnGroup = { title: 'On-chain fees (SOL)', usd: 0, lines: [] }
  const payers = [{ id: 'keeper', addr: i.keeper }, { id: 'pool-payer', addr: POOL_PAYER }].filter((w): w is { id: string; addr: string } => !!w.addr)
  const db = sql()
  let samples = new Map<string, { at: number; sol: number }[]>()
  if (db) {
    try {
      for (const w of payers) { const sol = i.values.get(w.addr)?.sol; if (sol != null) await recordSolSample(db, w.addr, sol) }
      samples = await readSolSamples(db, payers.map((w) => w.addr))
    } catch (e) { console.error('[command-center] balance samples failed:', (e as Error).message) }
  }
  for (const w of payers) {
    const b = solBurnPerDay(samples.get(w.addr) ?? [])
    if (!b) { notCounted.push({ label: label(w.id), nodeId: w.id, why: 'measuring: needs six hours of balance history first' }); continue }
    if (i.solPrice === null) { notCounted.push({ label: label(w.id), nodeId: w.id, why: 'no SOL price right now' }); continue }
    const solMonth = b.solPerDay * DAYS_PER_MONTH
    const left = i.values.get(w.addr)?.sol
    const runway = left != null && b.solPerDay > 0 ? ` · its ${left.toFixed(3)} SOL lasts ~${Math.floor(left / b.solPerDay)} days` : ''
    gas.lines.push({
      label: label(w.id), nodeId: w.id, source: 'measured', usd: solMonth * i.solPrice,
      detail: `${b.solPerDay.toFixed(4)} SOL/day (${solMonth.toFixed(3)} SOL/month), measured over ${b.spanDays < 2 ? `${Math.round(b.spanDays * 24)} h` : `${b.spanDays.toFixed(1)} days`}${runway}`,
    })
  }
  groups.push(gas)

  for (const g of groups) { g.lines.sort((a, b) => b.usd - a.usd); g.usd = g.lines.reduce((s, l) => s + l.usd, 0) }
  return { monthlyUsd: groups.reduce((s, g) => s + g.usd, 0), groups: groups.filter((g) => g.lines.length), notCounted }
}
