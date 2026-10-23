// Fills a missing USD valuation on a Reserve's mint / redeem / creation-seed
// rows, so All-Time Volume counts them (Creator, 2026-10-23: "all time volume
// of a reserve needs to count the reserve creation initial mint too").
//
// Why rows end up unvalued: the Manage page's activity read
// (activityRoute.ts) syncs new events with NO valuation -- it has no price
// source -- and the KPI sweep's top-up stops at the newest signature it
// already holds, so it never walks back over those rows to value them. A
// Reserve whose creator opens it right after launch therefore froze its seed
// (and any early trades) at amount_usd null, i.e. $0 in every volume figure.
// Live 2026-10-23: 14 of 40 Mainnet reserveSeeded rows were null.
//
// The fix re-decodes each such row's own stored transaction and values the
// event's asset legs at the current USD price (Jupiter, which also reports
// each mint's decimals -- so no extra chain read beyond the one
// getTransaction per row). A row is valued once and then left alone
// (`where amount_usd is null`), same frozen-at-first-valuation contract as
// DEC-0176. Bounded per call; never throws.
import { EventParser } from "@anchor-lang/core";
import type { Connection } from "@solana/web3.js";
import { MAINNET_USDC_MINT, valueAssetLegsUsd, fetchReserveActivityLog, withRateLimitRetryGeneric, type AssetPricing } from "@ssr/sdk";
import { getSql } from "./db";
import type { ActivityCluster } from "./clusters";

type ReserveActivityProgram = Parameters<typeof fetchReserveActivityLog>[1];

export type FetchPricesUsd = (mints: string[]) => Promise<Map<string, { usdPrice?: number | null; decimals?: number | null }>>;

/** The activity kinds that count toward All-Time Volume (amount_kind mintVolume / redeemVolume). */
export const VOLUME_EVENT_KINDS = ["reserveTokensMinted", "reserveTokensRedeemed", "reserveSeeded"] as const;

export interface AssetLegs {
  mints: string[];
  amounts: string[];
}

const pkStr = (v: unknown): string => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58(): string }).toBase58() : String(v));

/** Pure: the asset legs a volume event carries (the same fields valueActivityEventUsd reads), or null for any other event. */
export function volumeEventLegs(name: string, data: Record<string, unknown>): AssetLegs | null {
  const amounts = name === "reserveTokensMinted" ? data.assetAmountsIn : name === "reserveTokensRedeemed" ? data.assetAmountsOut : name === "reserveSeeded" ? data.assetAmounts : undefined;
  if (!Array.isArray(data.assetMints) || !Array.isArray(amounts)) return null;
  return { mints: (data.assetMints as unknown[]).map(pkStr), amounts: (amounts as unknown[]).map((a) => String(a ?? 0)) };
}

/**
 * Pure: per-mint pricing from a Jupiter quote map (USDC fixed at $1). A mint
 * with no usable price or decimals is left out, which values its leg at 0 --
 * landing-stats' convention, never a guess.
 */
export function pricingFromQuotes(mints: string[], quotes: Map<string, { usdPrice?: number | null; decimals?: number | null }>): Record<string, AssetPricing> {
  const pricing: Record<string, AssetPricing> = {};
  for (const mint of mints) {
    if (mint === MAINNET_USDC_MINT) {
      pricing[mint] = { decimals: 6, priceUsd: 1 };
      continue;
    }
    const q = quotes.get(mint);
    const price = q?.usdPrice;
    const decimals = q?.decimals;
    if (typeof price === "number" && Number.isFinite(price) && price > 0 && typeof decimals === "number" && decimals >= 0) pricing[mint] = { decimals, priceUsd: price };
  }
  return pricing;
}

/**
 * Pure: the USD value of one event's legs, or null when NO leg could be
 * priced (leave the row for a later attempt rather than freeze a false $0).
 */
export function valueLegsOrNull(legs: AssetLegs, pricing: Record<string, AssetPricing>): number | null {
  if (!legs.mints.some((m) => pricing[m])) return null;
  return valueAssetLegsUsd(legs.mints, legs.amounts, pricing);
}

/**
 * Values up to `maxRows` of this Reserve's unvalued mint/redeem/seed rows,
 * newest first (a fresh launch's seed is healed on the very next read).
 * Returns how many rows were valued; never throws.
 */
export async function healMissingVolumeUsd(
  connection: Connection,
  program: ReserveActivityProgram,
  reserve: string,
  cluster: ActivityCluster,
  fetchPricesUsd: FetchPricesUsd,
  maxRows = 6,
): Promise<{ valued: number; error: string | null }> {
  const sql = getSql();
  let valued = 0;
  try {
    const rows = (await sql`
      select signature, kind, event_index
      from reserve_activity_log
      where reserve = ${reserve} and cluster = ${cluster} and kind = any(${[...VOLUME_EVENT_KINDS]}) and amount_usd is null
      order by ts desc
      limit ${maxRows}
    `) as { signature: string; kind: string; event_index: number }[];
    if (rows.length === 0) return { valued, error: null };

    const eventParser = new EventParser(program.programId, program.coder);
    const decoded: { row: (typeof rows)[number]; legs: AssetLegs }[] = [];
    for (const row of rows) {
      const tx = await withRateLimitRetryGeneric(() => connection.getTransaction(row.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;
      // Same per-kind ordinal the indexer assigns (event_index).
      let ordinal = 0;
      for (const event of eventParser.parseLogs(logs)) {
        if (event.name !== row.kind) continue;
        if (ordinal++ !== row.event_index) continue;
        const legs = volumeEventLegs(event.name, event.data as Record<string, unknown>);
        if (legs) decoded.push({ row, legs });
        break;
      }
    }
    if (decoded.length === 0) return { valued, error: null };

    const mints = [...new Set(decoded.flatMap((d) => d.legs.mints))];
    const quotes = await fetchPricesUsd(mints.filter((m) => m !== MAINNET_USDC_MINT));
    const pricing = pricingFromQuotes(mints, quotes);
    for (const { row, legs } of decoded) {
      const usd = valueLegsOrNull(legs, pricing);
      if (usd === null) continue;
      await sql`
        update reserve_activity_log set amount_usd = ${usd}
        where reserve = ${reserve} and cluster = ${cluster} and signature = ${row.signature} and kind = ${row.kind} and event_index = ${row.event_index} and amount_usd is null
      `;
      valued++;
    }
    return { valued, error: null };
  } catch (e) {
    return { valued, error: e instanceof Error ? e.message : String(e) };
  }
}
