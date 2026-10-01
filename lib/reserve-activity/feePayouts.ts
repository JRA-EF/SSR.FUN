// Per-recipient USDC fee payouts (DEC-0206) for the Manage page's Fee
// Configuration panel. Manager fees on this protocol are never "claimed":
// every mint/seed/TVL fee is crystallized into the Reserve's fee vault and
// the hourly fee-settlement keeper redeems it, swaps it to USDC and pays
// each configured recipient's share straight into that wallet's USDC ATA
// (programs/ssr_protocol/src/instructions/distribute_fee_usdc.rs). The only
// durable record of WHAT each recipient received is the feeUsdcDistributed
// event's managerRecipients/managerAmounts pair, which the activity index
// now persists as `reserve_activity_log.payouts` (schema.sql).
//
// Two pieces here:
//  - healMissingFeePayouts: fills `payouts` for feeUsdcDistributed rows that
//    were indexed before the column existed, by re-decoding each row's own
//    stored transaction signature. Bounded per call (a handful of
//    getTransaction round trips), idempotent, and never throws -- a failure
//    just leaves the row for the next call.
//  - readFeePayoutTotals: the SQL read the endpoint serves, folded by the
//    pure aggregateFeePayouts. Exact on-chain USDC, summed per wallet;
//    `pendingHeal` tells the UI when the number is still provisional
//    because some rows have not been healed yet.
import type { Connection } from "@solana/web3.js";
import { extractFeePayoutsFromLogs, fetchReserveActivityLog, withRateLimitRetryGeneric, type FeePayout } from "@ssr/sdk";
import { getSql } from "./db";
import type { ActivityCluster } from "./clusters";

type ReserveActivityProgram = Parameters<typeof fetchReserveActivityLog>[1];

/** Bounded per request: each heal is one getTransaction round trip. */
export const HEAL_MAX_ROWS_PER_CALL = 12;

export interface FeePayoutRecipientTotal {
  wallet: string;
  /** Exact on-chain USDC delivered to this wallet across every indexed payout, raw base units (6 decimals) as a decimal string. */
  usdcRaw: string;
  payoutCount: number;
  /** Unix seconds of the most recent payout to this wallet. */
  lastTs: number;
  lastSignature: string;
}

export interface FeePayoutTotals {
  byRecipient: FeePayoutRecipientTotal[];
  /** feeUsdcDistributed rows for this Reserve whose per-recipient breakdown is not yet stored (indexed before DEC-0206 and not healed yet) -- totals above are provisional while this is > 0. */
  pendingHeal: number;
  /** True once the activity index holds this Reserve's complete history (reserve_activity_cursor.backfill_complete) -- until then, older payouts may still be missing. */
  backfillComplete: boolean;
}

export interface PayoutRow {
  signature: string;
  event_index: number;
  ts: number | string;
  payouts: FeePayout[] | null;
}

/**
 * Pure: folds indexed feeUsdcDistributed rows into per-wallet totals (any
 * row order -- the fold is order-independent; `lastTs` is the max). Rows
 * whose `payouts` is null are counted in `pendingHeal` instead of being
 * guessed at. Exported for the offline test suite.
 */
export function aggregateFeePayouts(rows: PayoutRow[]): { byRecipient: FeePayoutRecipientTotal[]; pendingHeal: number } {
  const totals = new Map<string, FeePayoutRecipientTotal & { sum: bigint }>();
  let pendingHeal = 0;
  for (const row of rows) {
    if (!row.payouts) {
      pendingHeal++;
      continue;
    }
    const ts = Number(row.ts);
    for (const p of row.payouts) {
      const amount = BigInt(String(p.usdcRaw ?? "0"));
      const existing = totals.get(p.wallet);
      if (!existing) {
        totals.set(p.wallet, { wallet: p.wallet, usdcRaw: amount.toString(), payoutCount: 1, lastTs: ts, lastSignature: row.signature, sum: amount });
      } else {
        existing.sum += amount;
        existing.usdcRaw = existing.sum.toString();
        existing.payoutCount++;
        if (ts >= existing.lastTs) {
          existing.lastTs = ts;
          existing.lastSignature = row.signature;
        }
      }
    }
  }
  const byRecipient = [...totals.values()]
    .map(({ sum: _sum, ...rest }) => rest)
    .sort((a, b) => (BigInt(b.usdcRaw) > BigInt(a.usdcRaw) ? 1 : BigInt(b.usdcRaw) < BigInt(a.usdcRaw) ? -1 : a.wallet.localeCompare(b.wallet)));
  return { byRecipient, pendingHeal };
}

/**
 * Fills `payouts` for up to HEAL_MAX_ROWS_PER_CALL feeUsdcDistributed rows
 * of this Reserve that still lack it. Returns how many rows were healed;
 * never throws (an RPC failure simply leaves the remaining rows for later).
 */
export async function healMissingFeePayouts(connection: Connection, program: ReserveActivityProgram, reserve: string, cluster: ActivityCluster): Promise<{ healed: number; error: string | null }> {
  const sql = getSql();
  let healed = 0;
  try {
    const rows = (await sql`
      select signature, event_index
      from reserve_activity_log
      where reserve = ${reserve} and cluster = ${cluster} and kind = 'feeUsdcDistributed' and payouts is null
      order by ts desc
      limit ${HEAL_MAX_ROWS_PER_CALL}
    `) as { signature: string; event_index: number }[];
    for (const row of rows) {
      const tx = await withRateLimitRetryGeneric(() => connection.getTransaction(row.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;
      const payouts = extractFeePayoutsFromLogs(program, logs, row.event_index);
      if (payouts === null) continue;
      await sql`
        update reserve_activity_log set payouts = ${JSON.stringify(payouts)}::jsonb
        where reserve = ${reserve} and cluster = ${cluster} and signature = ${row.signature} and kind = 'feeUsdcDistributed' and event_index = ${row.event_index} and payouts is null
      `;
      healed++;
    }
    return { healed, error: null };
  } catch (e) {
    return { healed, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Reads every indexed feeUsdcDistributed row for this Reserve and folds it with aggregateFeePayouts. */
export async function readFeePayoutTotals(reserve: string, cluster: ActivityCluster): Promise<FeePayoutTotals> {
  const sql = getSql();
  const [rows, cursorRows] = await Promise.all([
    sql`
      select signature, event_index, ts, payouts
      from reserve_activity_log
      where reserve = ${reserve} and cluster = ${cluster} and kind = 'feeUsdcDistributed'
      order by ts desc
    `,
    sql`select backfill_complete from reserve_activity_cursor where reserve = ${reserve} and cluster = ${cluster}`,
  ]);
  const folded = aggregateFeePayouts(rows as unknown as PayoutRow[]);
  const backfillComplete = Boolean((cursorRows[0] as { backfill_complete?: boolean } | undefined)?.backfill_complete);
  return { ...folded, backfillComplete };
}
