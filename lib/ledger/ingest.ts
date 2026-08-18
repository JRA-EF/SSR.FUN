// Network-touching ledger ingestion: walks a program's real transaction
// history (getSignaturesForAddress against the PROGRAM ID itself, which
// returns every transaction that invoked it -- the same pattern any
// explorer uses for "all transactions for a program"), decodes every event
// via the same EventParser packages/sdk/src/activityLog.ts already uses,
// and upserts into ledger_events. Bounded per call (never one unbounded
// scan), resumable via ledger_ingestion_cursors -- same philosophy as
// lib/reserve-activity/indexer.ts, generalized to program-wide rather than
// per-Reserve scope.
//
// Deliberately walks BOTH successful and FAILED transactions (unlike
// activityLog.ts's fetchReserveActivityLog, which skips sigInfo.err
// transactions entirely) -- a failed attempt is exactly what sections E/H
// of the ledger requirement ask to be captured, not discarded.
import { EventParser } from "@anchor-lang/core";
import { withRateLimitRetryGeneric, buildReadOnlyProgram } from "@ssr/sdk";
import { getSql } from "./db";
import { buildLedgerEventRecord, type TransactionContext, type LedgerEventRecord } from "./decodeEvent";

type ReadOnlyProgram = ReturnType<typeof buildReadOnlyProgram>;
type Connection = Parameters<typeof buildReadOnlyProgram>[0];

const RESERVE_TOKEN_DECIMALS = 6;
const SIGNATURES_PER_PAGE = 100;
const MAX_PAGES_PER_CALL = 3;
const MAX_TX_FETCHES_PER_CALL = 250;

export type Cluster = "devnet" | "mainnet-beta";

const pk = (v: unknown): string | null => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58(): string }).toBase58() : null);

/** Best-effort extraction of Reserve/mint identity directly from the event's own decoded fields (see programs/ssr_protocol/src/events.rs -- most events already carry `reserve`/`reserve_token_mint`/`asset_mint`), so ingestion needs no extra RPC round trip per event just to tag it. */
function extractReserveContext(eventData: Record<string, unknown>): { reserve: string | null; reserveTokenMint: string | null; reserveAssetMint: string | null } {
  return {
    reserve: pk(eventData.reserve),
    reserveTokenMint: pk(eventData.reserveTokenMint),
    reserveAssetMint: pk(eventData.assetMint),
  };
}

export interface IngestResult {
  cluster: Cluster;
  signaturesWalked: number;
  transactionsFetched: number;
  eventsUpserted: number;
  reachedRealEnd: boolean;
  errors: string[];
}

export async function ingestProgramEvents(
  connection: Connection,
  program: ReadOnlyProgram,
  cluster: Cluster,
  options: { before?: string; maxPages?: number; source?: "backfill" | "rpc-poll" } = {},
): Promise<IngestResult> {
  const programId = program.programId;
  const maxPages = options.maxPages ?? MAX_PAGES_PER_CALL;
  const source = options.source ?? "rpc-poll";
  const eventParser = new EventParser(programId, program.coder);
  const sql = getSql();

  const errors: string[] = [];
  let signaturesWalked = 0;
  let transactionsFetched = 0;
  let eventsUpserted = 0;
  let reachedRealEnd = false;
  let before = options.before;
  let oldestSignatureWalked: string | undefined;

  for (let page = 0; page < maxPages && transactionsFetched < MAX_TX_FETCHES_PER_CALL; page++) {
    const sigInfos = await withRateLimitRetryGeneric(() => connection.getSignaturesForAddress(programId, { limit: SIGNATURES_PER_PAGE, before }));
    if (sigInfos.length === 0) {
      reachedRealEnd = true;
      break;
    }
    signaturesWalked += sigInfos.length;

    for (const sigInfo of sigInfos) {
      oldestSignatureWalked = sigInfo.signature;
      if (transactionsFetched >= MAX_TX_FETCHES_PER_CALL) break;
      let tx;
      try {
        tx = await withRateLimitRetryGeneric(() => connection.getTransaction(sigInfo.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      } catch (e) {
        errors.push(`${sigInfo.signature}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      transactionsFetched++;
      if (!tx?.meta) continue;

      const txContext: Omit<TransactionContext, "instructionIndex" | "innerInstructionIndex" | "eventIndex"> = {
        cluster,
        programId: programId.toBase58(),
        signature: sigInfo.signature,
        slot: tx.slot ?? null,
        blockTimeUnix: tx.blockTime ?? sigInfo.blockTime ?? null,
        transactionFailed: sigInfo.err !== null || tx.meta.err !== null,
        errorMessage: sigInfo.err ? JSON.stringify(sigInfo.err) : undefined,
        feePayer: tx.transaction.message.staticAccountKeys?.[0]?.toBase58(),
        computeUnitsConsumed: tx.meta.computeUnitsConsumed ?? undefined,
        networkFeeLamports: tx.meta.fee,
        ingestionSource: source === "backfill" ? "backfill" : "rpc-poll",
      };

      const logs = tx.meta.logMessages;
      if (!logs) continue;

      let eventIndex = 0;
      const records: LedgerEventRecord[] = [];
      for (const event of eventParser.parseLogs(logs)) {
        const ctx = extractReserveContext(event.data as Record<string, unknown>);
        const isReserveTokenAmount = true; // every ssr_protocol event's primary amount is a Reserve Token amount (RESERVE_TOKEN_DECIMALS), never a raw asset-mint amount
        const record = buildLedgerEventRecord(
          { name: event.name, data: event.data as Record<string, unknown> },
          { ...txContext, eventIndex },
          {
            reserve: ctx.reserve,
            reserveTokenMint: ctx.reserveTokenMint,
            reserveAssetMint: ctx.reserveAssetMint,
            decimals: isReserveTokenAmount ? RESERVE_TOKEN_DECIMALS : null,
          },
        );
        if (record) records.push(record);
        eventIndex++;
      }

      for (const r of records) {
        try {
          await upsertLedgerEvent(sql, r);
          eventsUpserted++;
        } catch (e) {
          errors.push(`${r.event_id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    if (sigInfos.length < SIGNATURES_PER_PAGE) {
      reachedRealEnd = true;
      break;
    }
    before = sigInfos[sigInfos.length - 1].signature;
  }

  await upsertCursor(sql, cluster, programId.toBase58(), source === "backfill" ? "backfill" : "rpc-poll", { oldestSignatureWalked, reachedRealEnd });

  return { cluster, signaturesWalked, transactionsFetched, eventsUpserted, reachedRealEnd, errors };
}

async function upsertLedgerEvent(sql: ReturnType<typeof getSql>, r: LedgerEventRecord): Promise<void> {
  await sql`
    insert into ledger_events (
      event_id, cluster, program_id, signature, slot, block_time_unix, event_ts_utc, event_date_utc,
      instruction_index, inner_instruction_index, event_index, instruction_name, event_type, category, status,
      error_code, error_message, actor_wallet, actor_role, fee_payer, reserve, reserve_token_mint, reserve_asset_mint,
      amount_raw, amount_decimals, amount_normalized, amount_kind, usd_price_at_event, usd_price_source, usd_value_at_event,
      compute_units_consumed, network_fee_lamports, priority_fee_lamports, confirmation_status, summary, ingestion_source, decoder_version
    ) values (
      ${r.event_id}, ${r.cluster}, ${r.program_id}, ${r.signature}, ${r.slot}, ${r.block_time_unix}, ${r.event_ts_utc}, ${r.event_date_utc},
      ${r.instruction_index}, ${r.inner_instruction_index}, ${r.event_index}, ${r.instruction_name}, ${r.event_type}, ${r.category}, ${r.status},
      ${r.error_code}, ${r.error_message}, ${r.actor_wallet}, ${r.actor_role}, ${r.fee_payer}, ${r.reserve}, ${r.reserve_token_mint}, ${r.reserve_asset_mint},
      ${r.amount_raw}, ${r.amount_decimals}, ${r.amount_normalized}, ${r.amount_kind}, ${r.usd_price_at_event}, ${r.usd_price_source}, ${r.usd_value_at_event},
      ${r.compute_units_consumed}, ${r.network_fee_lamports}, ${r.priority_fee_lamports}, ${r.confirmation_status}, ${r.summary}, ${r.ingestion_source}, ${r.decoder_version}
    )
    on conflict (event_id) do nothing
  `;
}

async function upsertCursor(
  sql: ReturnType<typeof getSql>,
  cluster: Cluster,
  programId: string,
  source: string,
  updates: { oldestSignatureWalked?: string; reachedRealEnd: boolean },
): Promise<void> {
  await sql`
    insert into ledger_ingestion_cursors (cluster, program_id, source, oldest_signature_indexed, backfill_complete, last_run_at)
    values (${cluster}, ${programId}, ${source}, ${updates.oldestSignatureWalked ?? null}, ${updates.reachedRealEnd}, now())
    on conflict (cluster, program_id, source) do update set
      oldest_signature_indexed = coalesce(${updates.oldestSignatureWalked ?? null}, ledger_ingestion_cursors.oldest_signature_indexed),
      backfill_complete = ledger_ingestion_cursors.backfill_complete or ${updates.reachedRealEnd},
      last_run_at = now()
  `;
}
