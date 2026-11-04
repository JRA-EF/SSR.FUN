// Beta Campaign rules (DEC-0279): the Superteam Earn "Build a Reserve" campaign
// with three prize tracks (Highest Volume $150, Highest PnL $100, Best Beta
// Contributor $50 -- the last is judged by the team, not ranked here).
//
// Pure module (no I/O) so tests/phase_campaign.mjs can cover it directly.
//
// Owner decisions (2026-11-03):
//  1. Volume = in-app mints + redeems + Raydium pool swaps inside the campaign
//     window, EXCLUDING the creator wallet's own trades (no self wash-trading).
//  2. PnL % = Reserve Token NAV at campaign close vs its launch NAV (the same
//     launch anchor as "All-Time Performance"). Any Reserve, no size minimum.
//  3. Only Reserves whose creator signed a campaign entry are ranked: the
//     signature proves the X handle belongs to the Reserve's on-chain manager
//     wallet. Team wallets are excluded (SSR_CAMPAIGN_EXCLUDE_WALLETS).
//  4. Only NEW Reserves count (owner, 2026-11-03): created at or after the
//     campaign start by a non-team wallet. (Trader volume counts trades on
//     ANY Reserve since 2026-11-04, DEC-0286.)

export interface CampaignConfig {
  /** Unix seconds; null until the owner sets SSR_CAMPAIGN_START. */
  startTs: number | null
  /** Unix seconds; null until the owner sets SSR_CAMPAIGN_END. */
  endTs: number | null
  excludedWallets: Set<string>
}

/** Team wallets, always excluded (owner, 2026-11-03): the protocol wallet …4Rw8 and …WZen. More can come from env. */
const ALWAYS_EXCLUDED = [
  'CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8',
  '6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen',
]

function parseTs(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null
  const ms = Date.parse(raw.trim())
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export function campaignConfig(env: Record<string, string | undefined> = process.env): CampaignConfig {
  const extra = (env.SSR_CAMPAIGN_EXCLUDE_WALLETS ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  return {
    startTs: parseTs(env.SSR_CAMPAIGN_START),
    endTs: parseTs(env.SSR_CAMPAIGN_END),
    excludedWallets: new Set([...ALWAYS_EXCLUDED, ...extra]),
  }
}

export type CampaignPhase = 'unscheduled' | 'upcoming' | 'live' | 'closed'

export function campaignPhase(cfg: CampaignConfig, nowTs: number): CampaignPhase {
  if (cfg.startTs === null || cfg.endTs === null) return 'unscheduled'
  if (nowTs < cfg.startTs) return 'upcoming'
  if (nowTs <= cfg.endTs) return 'live'
  return 'closed'
}

/** Entries are accepted until the campaign closes (also before it starts, so creators can register early). */
export function entriesOpen(cfg: CampaignConfig, nowTs: number): boolean {
  const phase = campaignPhase(cfg, nowTs)
  return phase !== 'closed'
}

// --- Signed entry message -------------------------------------------------

/** X handles: 1-15 letters, digits or underscores (X's own rule), stored without the @. */
export function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const h = raw.trim().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').split(/[/?#]/)[0]
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null
}

/** The exact text the creator's wallet signs. Every field is checked server-side. */
export function entryMessage(p: { reserve: string; wallet: string; handle: string; issuedAt: string }): string {
  return [
    'SSR.FUN Beta Campaign entry',
    '',
    'I created this Reserve and I am entering it in the campaign.',
    `Reserve: ${p.reserve}`,
    `Creator wallet: ${p.wallet}`,
    `X: @${p.handle}`,
    `Issued: ${p.issuedAt}`,
  ].join('\n')
}

/** Max age of a signed entry when it reaches the server (stops replaying an old signature). */
export const ENTRY_MAX_AGE_MS = 10 * 60_000

// --- Ranking ----------------------------------------------------------------

export interface TradeRow {
  reserve: string
  /** Wallet that traded; null when unknown (counted, since it cannot be shown to be the creator). */
  actor: string | null
  usd: number
}

/** Sums volume per Reserve, skipping every trade made by that Reserve's creator wallet. */
export function volumeByReserve(rows: TradeRow[], managerByReserve: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const manager = managerByReserve.get(r.reserve)
    if (!manager) continue
    if (r.actor && r.actor === manager) continue
    if (!Number.isFinite(r.usd) || r.usd <= 0) continue
    out.set(r.reserve, (out.get(r.reserve) ?? 0) + r.usd)
  }
  return out
}

export interface NavPointLike { t: number; nav: number }

/**
 * PnL % from a NAV series (first point = launch anchor). `closeMs` caps the
 * series at campaign close, so the result freezes once the campaign ends.
 */
export function pnlPct(points: NavPointLike[], closeMs: number | null): number | null {
  const usable = points.filter(p => Number.isFinite(p.nav) && p.nav > 0).sort((a, b) => a.t - b.t)
  if (usable.length < 2) return null
  const capped = closeMs === null ? usable : usable.filter(p => p.t <= closeMs)
  if (capped.length < 2) return null
  const first = capped[0].nav
  const last = capped[capped.length - 1].nav
  return ((last / first) - 1) * 100
}

/** A Reserve takes part when a non-team wallet created it at or after the start (before dates are set: any non-team Reserve). */
export function isEligibleReserve(createdTs: number | null, manager: string, cfg: CampaignConfig): boolean {
  if (cfg.excludedWallets.has(manager)) return false
  if (cfg.startTs === null) return true
  return createdTs !== null && createdTs >= cfg.startTs
}

/** Rank by value, highest first; ties go to the earlier entry. */
export function rank<T extends { value: number | null; enteredAt: string }>(rows: T[]): (T & { rank: number })[] {
  return rows
    .filter(r => r.value !== null && Number.isFinite(r.value))
    .sort((a, b) => (b.value! - a.value!) || a.enteredAt.localeCompare(b.enteredAt))
    .map((r, i) => ({ ...r, rank: i + 1 }))
}

// --- One sign-up per wallet (owner, 2026-11-04) ----------------------------
// A wallet signs a message with its X handle once. That covers everything:
// its trades count, and every new Reserve it creates is entered automatically
// (the on-chain manager proves who created it). Earn matches the submission's
// X profile to the signed handle. Only signed-up wallets are ranked.

/** The exact text a wallet signs to sign up. */
export function signupMessage(p: { wallet: string; handle: string; issuedAt: string }): string {
  return [
    'SSR.FUN Beta Campaign sign-up',
    '',
    'I use this wallet on SSR.FUN and I am entering the campaign with it.',
    `Wallet: ${p.wallet}`,
    `X: @${p.handle}`,
    `Issued: ${p.issuedAt}`,
  ].join('\n')
}

export interface WalletTradeRow { wallet: string; reserve: string; usd: number; trades: number }

/**
 * Trader volume per wallet. Leaves out a creator's trades on their own Reserve
 * (that volume can't win through the trader path either), team wallets, and,
 * when `registered` is given, every wallet that hasn't signed up.
 */
export function traderVolume(
  rows: WalletTradeRow[],
  managerByReserve: Map<string, string>,
  excluded: Set<string>,
  registered: Set<string> | null,
): { wallet: string; usd: number; trades: number }[] {
  const out = new Map<string, { usd: number; trades: number }>()
  for (const r of rows) {
    if (!r.wallet || excluded.has(r.wallet)) continue
    if (registered && !registered.has(r.wallet)) continue
    if (managerByReserve.get(r.reserve) === r.wallet) continue
    if (!Number.isFinite(r.usd) || r.usd <= 0) continue
    const cur = out.get(r.wallet) ?? { usd: 0, trades: 0 }
    cur.usd += r.usd
    cur.trades += r.trades
    out.set(r.wallet, cur)
  }
  return [...out].map(([wallet, v]) => ({ wallet, ...v })).sort((a, b) => b.usd - a.usd)
}
