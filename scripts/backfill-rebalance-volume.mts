// DEC-0287 one-off: index past rebalance swaps as volume.
//
// The activity indexer never decoded RebalanceSwapExecuted (DEC-0250), and
// its cursors have already walked past those transactions, so they would
// never be picked up. This walks each Mainnet Reserve's signatures since the
// DEC-0250 upgrade, skips transactions already indexed as mint/redeem/fee
// activity (they can't contain a rebalance), decodes the rest and inserts the
// rebalance events with amount_usd NULL. The hourly activity sweep
// (backfillAll.ts -> healMissingVolumeUsd) then values them at the Jupiter
// price, the same convention as any unvalued mint/redeem row.
//
// Usage: node --env-file=.env.local scripts/backfill-rebalance-volume.mts [--apply]
// Without --apply it only reports what it would insert.
import { Connection, PublicKey } from "@solana/web3.js";
import { EventParser } from "@anchor-lang/core";
import { neon } from "@neondatabase/serverless";
import { buildReadOnlyProgram, summarizeActivityEvent } from "@ssr/sdk";

const APPLY = process.argv.includes("--apply");
const CLUSTER = "mainnet-beta";
const SINCE = Date.parse("2026-10-18T00:00:00Z") / 1000; // DEC-0250 went live 2026-10-19
const REBALANCE_KINDS = new Set(["rebalanceSwapExecuted", "rebalanceLegExecuted"]);
// Transactions already indexed with one of these kinds are mints, redeems or
// keeper fee runs -- never a rebalance.
const NON_REBALANCE_KINDS = [
  "reserveTokensMinted", "reserveTokensRedeemed", "mintFeePaidUsdc", "protocolMintFeeTransferred",
  "feeUsdcDistributed", "settlementSwapApproved", "feeVaultCredited", "feeSharesRedeemed", "reserveSeeded", "reserveCreated",
];

const sql = neon(process.env.DATABASE_URL!);
const rpc = process.env.HELIUS_MAINNET_RPC_URL;
if (!rpc) throw new Error("HELIUS_MAINNET_RPC_URL missing");
const connection = new Connection(rpc, "confirmed");
const program = buildReadOnlyProgram(connection);
const parser = new EventParser(program.programId, program.coder);

const reserves = (await sql`select distinct reserve from reserve_activity_log where cluster = ${CLUSTER}`).map((r) => r.reserve as string);
const skip = new Set(
  (await sql`select distinct signature from reserve_activity_log where cluster = ${CLUSTER} and ts >= ${SINCE} and kind = any(${NON_REBALANCE_KINDS})`).map((r) => r.signature as string),
);
console.log(`${reserves.length} Reserves, ${skip.size} known non-rebalance signatures skipped`);

let fetched = 0;
const found: { reserve: string; signature: string; kind: string; eventIndex: number; ts: number; actor: string | null; summary: string; amountRaw?: string; amountKind?: string }[] = [];
for (const reserve of reserves) {
  let before: string | undefined;
  outer: for (;;) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(reserve), { limit: 1000, before });
    if (!sigs.length) break;
    for (const s of sigs) {
      if (typeof s.blockTime === "number" && s.blockTime < SINCE) break outer;
      if (s.err || skip.has(s.signature)) continue;
      const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      fetched++;
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;
      const ordinals: Record<string, number> = {};
      for (const ev of parser.parseLogs(logs)) {
        const data = ev.data as Record<string, unknown>;
        const decoded = summarizeActivityEvent(ev.name, data);
        if (!decoded) continue;
        const eventIndex = ordinals[ev.name] ?? 0;
        ordinals[ev.name] = eventIndex + 1;
        if (!REBALANCE_KINDS.has(ev.name)) continue;
        if (String((data.reserve as { toBase58?: () => string })?.toBase58?.() ?? "") !== reserve) continue;
        const ts = typeof (data.ts as { toNumber?: () => number })?.toNumber === "function" ? (data.ts as { toNumber(): number }).toNumber() : (s.blockTime ?? 0);
        found.push({ reserve, signature: s.signature, kind: ev.name, eventIndex, ts, actor: decoded.actor, summary: decoded.summary, amountRaw: decoded.amountRaw, amountKind: decoded.amountKind });
      }
    }
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
  }
}

console.log(`fetched ${fetched} transactions, found ${found.length} rebalance events`);
for (const f of found) console.log(`  ${f.reserve.slice(-6)} ${new Date(f.ts * 1000).toISOString()} ${f.kind}#${f.eventIndex} ${f.summary}`);

if (APPLY) {
  let inserted = 0;
  for (const f of found) {
    const r = await sql`
      insert into reserve_activity_log (reserve, cluster, signature, kind, event_index, ts, actor, summary, amount_raw, amount_kind)
      values (${f.reserve}, ${CLUSTER}, ${f.signature}, ${f.kind}, ${f.eventIndex}, ${f.ts}, ${f.actor}, ${f.summary}, ${f.amountRaw ?? null}, ${f.amountKind ?? null})
      on conflict (reserve, signature, kind, event_index) do nothing
      returning 1`;
    inserted += r.length;
  }
  console.log(`inserted ${inserted} rows (amount_usd left for the hourly heal)`);
} else {
  console.log("dry run; pass --apply to insert");
}
