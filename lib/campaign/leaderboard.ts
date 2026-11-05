// Beta Campaign leaderboard (DEC-0279): ranks the signed-up Reserves by
// volume and by PnL %. Reads only this project's Postgres (warm-cache snapshot,
// activity log, DEX swaps, NAV history, entry prices) -- never RPC -- so the
// public GET is cheap. Freshness comes from api/mainnet/campaign-refresh-cron.ts.
import { readReserveSnapshot } from '../reserve-warm-cache/db'
import { computeEntryNavUsd, type NavInputReserve, type NavPoint } from '../reserve-nav-history/navMath'
import { campaignConfig, campaignPhase, isEligibleReserve, pnlPct, rank, traderVolume, volumeByReserve, type CampaignPhase, type TradeRow } from './rules'
import { getCampaignSql, listEntries, listTraders } from './db'

/** Creation time (unix s) of every Reserve: its reserveCreated event, else its earliest indexed activity. */
export async function reserveCreatedTs(cluster: string): Promise<Map<string, number>> {
  const rows = (await getCampaignSql()`
    SELECT reserve, COALESCE(min(ts) FILTER (WHERE kind = 'reserveCreated'), min(ts))::bigint AS created
    FROM reserve_activity_log WHERE cluster = ${cluster} GROUP BY reserve`) as { reserve: string; created: string }[]
  return new Map(rows.map(r => [r.reserve, Number(r.created)]))
}

const CLUSTER = 'mainnet-beta'
// Mints, redeems and rebalance swaps (rebalancing is volume, DEC-0287).
const MINT_REDEEM_KINDS = ['reserveTokensMinted', 'reserveTokensRedeemed', 'rebalanceSwapExecuted', 'rebalanceLegExecuted']

interface SnapshotReserve extends NavInputReserve {
  reserveId: string
  manager: string
  reserveTokenMint: string
  status: string
}

export interface LeaderboardRow {
  rank: number
  reserve: string
  reserveId: string
  mint: string
  name: string
  ticker: string
  imageUrl: string | null
  handle: string
  wallet: string
  status: string
  value: number
  enteredAt: string
}

export interface TraderRow {
  rank: number
  wallet: string
  handle: string
  value: number
  trades: number
}

export interface Leaderboard {
  phase: CampaignPhase
  startTs: number | null
  endTs: number | null
  entries: number
  /** Wallets that signed up (creators and traders; only they are ranked). */
  traderEntries: number
  volume: LeaderboardRow[]
  pnl: LeaderboardRow[]
  /** Highest Volume is the greater of the top Reserve's volume and the top trader's volume (owner, 2026-11-03). */
  traders: TraderRow[]
  volumeLeader: { kind: 'reserve' | 'trader'; id: string; value: number } | null
  generatedAt: string
}

export async function computeLeaderboard(nowMs = Date.now()): Promise<Leaderboard> {
  const cfg = campaignConfig()
  const phase = campaignPhase(cfg, Math.floor(nowMs / 1000))
  const sql = getCampaignSql()

  const [entriesAll, snapRow, createdBy, traderEntries] = await Promise.all([listEntries(), readReserveSnapshot(CLUSTER), reserveCreatedTs(CLUSTER), listTraders()])
  // One sign-up per wallet (owner, 2026-11-04). Older per-Reserve entries also count as a sign-up for their wallet.
  const signups = new Map<string, { handle: string; enteredAt: string }>()
  for (const e of entriesAll) if (!signups.has(e.wallet)) signups.set(e.wallet, { handle: e.handle, enteredAt: e.enteredAt })
  for (const t of traderEntries) signups.set(t.wallet, { handle: t.handle, enteredAt: t.enteredAt })
  for (const w of cfg.excludedWallets) signups.delete(w)
  const handleByTrader = new Map([...signups].map(([w, v]) => [w, v.handle]))
  const snap = (snapRow?.snapshot ?? {}) as { reserves?: SnapshotReserve[]; metadataByReserve?: Record<string, { name?: string; ticker?: string; imageUrl?: string }> }
  const byReserve = new Map((snap.reserves ?? []).map(r => [r.reserve, r]))

  // New, non-team Reserves only (created at/after the start). A Reserve is entered when its creator (on-chain manager) has signed up.
  const eligible = new Set((snap.reserves ?? []).filter(r => isEligibleReserve(createdBy.get(r.reserve) ?? null, r.manager, cfg)).map(r => r.reserve))
  const entries = (snap.reserves ?? [])
    .filter(r => eligible.has(r.reserve) && signups.has(r.manager))
    .map(r => ({ reserve: r.reserve, wallet: r.manager, handle: signups.get(r.manager)!.handle, enteredAt: signups.get(r.manager)!.enteredAt }))
  const reserves = entries.map(e => e.reserve)
  const managerByReserve = new Map(entries.map(e => [e.reserve, e.wallet]))

  // --- Volume (only once the window is known) ---
  let volume = new Map<string, number>()
  if (reserves.length && cfg.startTs !== null && cfg.endTs !== null) {
    const [app, dex] = await Promise.all([
      sql`
        SELECT reserve, actor, amount_usd FROM reserve_activity_log
        WHERE cluster = ${CLUSTER} AND kind = ANY(${MINT_REDEEM_KINDS}) AND reserve = ANY(${reserves})
          AND ts >= ${cfg.startTs} AND ts <= ${cfg.endTs} AND amount_usd IS NOT NULL`,
      sql`
        SELECT reserve, trader, usdc_raw FROM dex_pool_swaps
        WHERE cluster = ${CLUSTER} AND reserve = ANY(${reserves}) AND ts >= ${cfg.startTs} AND ts <= ${cfg.endTs}`,
    ]) as [{ reserve: string; actor: string | null; amount_usd: number }[], { reserve: string; trader: string | null; usdc_raw: string }[]]
    const rows: TradeRow[] = [
      ...app.map(r => ({ reserve: r.reserve, actor: r.actor, usd: Number(r.amount_usd) })),
      ...dex.map(r => ({ reserve: r.reserve, actor: r.trader, usd: Number(r.usdc_raw) / 1e6 })),
    ]
    volume = volumeByReserve(rows, managerByReserve)
  }

  // --- Traders: signed-up wallets' mints + redeems + pool swaps on ANY Reserve in the window (owner, 2026-11-04).
  // A creator's trades on their own Reserve count too (DEC-0287).
  let traders: TraderRow[] = []
  if (cfg.startTs !== null && cfg.endTs !== null && handleByTrader.size) {
    const rows = (await sql`
      SELECT wallet, reserve, sum(usd)::float8 AS usd, count(*)::int AS n FROM (
        SELECT actor AS wallet, reserve, amount_usd::float8 AS usd FROM reserve_activity_log
        WHERE cluster = ${CLUSTER} AND kind = ANY(${MINT_REDEEM_KINDS}) AND actor IS NOT NULL
          AND ts >= ${cfg.startTs} AND ts <= ${cfg.endTs} AND amount_usd IS NOT NULL
        UNION ALL
        SELECT trader AS wallet, reserve, usdc_raw::float8 / 1e6 AS usd FROM dex_pool_swaps
        WHERE cluster = ${CLUSTER} AND trader IS NOT NULL AND ts >= ${cfg.startTs} AND ts <= ${cfg.endTs}
      ) t WHERE wallet = ANY(${[...handleByTrader.keys()]}) GROUP BY wallet, reserve`) as { wallet: string; reserve: string; usd: number; n: number }[]
    traders = traderVolume(rows.map(r => ({ wallet: r.wallet, reserve: r.reserve, usd: Number(r.usd), trades: r.n })), cfg.excludedWallets, new Set(handleByTrader.keys()))
      .slice(0, 25)
      .map((r, i) => ({ rank: i + 1, wallet: r.wallet, handle: handleByTrader.get(r.wallet)!, value: r.usd, trades: r.trades }))
  }

  // --- PnL: launch anchor (entry prices) or first recorded NAV, to the last NAV at/before close ---
  const pnl = new Map<string, number>()
  if (reserves.length) {
    const closeMs = phase === 'closed' && cfg.endTs !== null ? cfg.endTs * 1000 : null
    const closeIso = new Date(closeMs ?? nowMs).toISOString()
    const [firsts, lasts, entryRows] = await Promise.all([
      sql`
        SELECT DISTINCT ON (reserve) reserve, t, nav_usd FROM reserve_nav_history
        WHERE cluster = ${CLUSTER} AND reserve = ANY(${reserves}) ORDER BY reserve, t ASC`,
      sql`
        SELECT DISTINCT ON (reserve) reserve, t, nav_usd FROM reserve_nav_history
        WHERE cluster = ${CLUSTER} AND reserve = ANY(${reserves}) AND t <= ${closeIso} ORDER BY reserve, t DESC`,
      sql`SELECT reserve, mint, entry_price_usd, captured_at FROM reserve_asset_entry_price WHERE reserve = ANY(${reserves})`,
    ]) as [{ reserve: string; t: string; nav_usd: number }[], { reserve: string; t: string; nav_usd: number }[], { reserve: string; mint: string; entry_price_usd: number; captured_at: string }[]]

    const entryPrices = new Map<string, { prices: Record<string, number>; capturedAt: number }>()
    for (const r of entryRows) {
      const at = new Date(r.captured_at).getTime()
      const cur = entryPrices.get(r.reserve) ?? { prices: {}, capturedAt: at }
      cur.prices[r.mint] = Number(r.entry_price_usd)
      if (at < cur.capturedAt) cur.capturedAt = at
      entryPrices.set(r.reserve, cur)
    }
    const firstBy = new Map(firsts.map(r => [r.reserve, { t: new Date(r.t).getTime(), nav: Number(r.nav_usd) }]))
    const lastBy = new Map(lasts.map(r => [r.reserve, { t: new Date(r.t).getTime(), nav: Number(r.nav_usd) }]))
    for (const reserve of reserves) {
      const points: NavPoint[] = []
      const snapR = byReserve.get(reserve)
      const entry = entryPrices.get(reserve)
      const first = firstBy.get(reserve)
      // Same launch anchor as the app's All-Time Performance (api/mainnet/reserve-nav-history.ts).
      if (snapR && entry) {
        const nav = computeEntryNavUsd(snapR, entry.prices)
        if (nav !== null && nav > 0 && (!first || entry.capturedAt < first.t)) points.push({ t: entry.capturedAt, nav })
      }
      if (first) points.push(first)
      const last = lastBy.get(reserve)
      if (last && (!first || last.t > first.t)) points.push(last)
      const value = pnlPct(points, closeMs)
      if (value !== null) pnl.set(reserve, value)
    }
  }

  const row = (reserve: string, value: number | null) => {
    const e = entries.find(x => x.reserve === reserve)!
    const r = byReserve.get(reserve)!
    const meta = snap.metadataByReserve?.[String(r.reserveId)] ?? {}
    return {
      reserve,
      reserveId: String(r.reserveId),
      mint: r.reserveTokenMint,
      name: meta.name ?? `Reserve #${r.reserveId}`,
      ticker: meta.ticker ?? '',
      imageUrl: meta.imageUrl ?? null,
      handle: e.handle,
      wallet: e.wallet,
      status: r.status,
      value,
      enteredAt: e.enteredAt,
    }
  }

  const volumeRows = rank(reserves.map(r => row(r, volume.get(r) ?? 0))) as LeaderboardRow[]
  const topReserve = volumeRows.find(r => r.value > 0)
  const topTrader = traders[0]
  const volumeLeader = !topReserve && !topTrader ? null
    : !topTrader || (topReserve && topReserve.value >= topTrader.value)
      ? { kind: 'reserve' as const, id: topReserve!.reserve, value: topReserve!.value }
      : { kind: 'trader' as const, id: topTrader.wallet, value: topTrader.value }

  return {
    phase,
    startTs: cfg.startTs,
    endTs: cfg.endTs,
    entries: entries.length,
    traderEntries: handleByTrader.size,
    volume: volumeRows,
    pnl: rank(reserves.map(r => row(r, pnl.get(r) ?? null))) as LeaderboardRow[],
    traders,
    volumeLeader,
    generatedAt: new Date(nowMs).toISOString(),
  }
}
