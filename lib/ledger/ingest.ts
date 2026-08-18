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
import { withRateLimitRetryGeneric, buildReadOnlyProgram } from "@ssr/sdk";
import { getSql } from "./db";
import { buildLedgerEventRecord, buildFailedTransactionRecord, type TransactionContext, type LedgerEventRecord } from "./decodeEvent";
import { parseLogsWithInstructionContext } from "./logWalker";
import { applyReserveContextEvents, loadReserveActorLookup, type ReserveContextEvent } from "./reserveContext";

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
  const sql = getSql();

  // Loaded once per sweep (not re-queried per transaction) -- reflects
  // whatever ledger_reserves/ledger_reserve_delegates already knew BEFORE
  // this sweep started. Context DISCOVERED during this same sweep (e.g. a
  // reserveCreated near the walk's older end) intentionally does not
  // retroactively improve this sweep's own earlier classifications --
  // reclassifyActorRoles (lib/ledger/reserveContext.ts) is the tool for
  // that, run separately after ingestion moves forward.
  const actorLookup = await loadReserveActorLookup(sql, cluster);

  const errors: string[] = [];
  let signaturesWalked = 0;
  let transactionsFetched = 0;
  let eventsUpserted = 0;
  let reachedRealEnd = false;
  let oldestSignatureWalked: string | undefined;
  // Collected across the whole sweep, applied AFTER the walk completes in
  // true chronological (ascending slot) order regardless of the order
  // ingestion discovered the underlying transactions in -- see
  // applyReserveContextEvents's own comment for why this matters
  // (ingestion itself walks newest-to-oldest for resumability).
  const contextEvents: ReserveContextEvent[] = [];

  // Resume from where the LAST call left off -- without this, every
  // separate invocation (a new cron tick, a new dryRun test call) walked
  // the exact same newest ~300 signatures forever and NEVER made forward
  // progress into older history. Discovered live: two consecutive real
  // sweeps against production returned byte-identical results (same
  // signaturesWalked/eventsUpserted/errors) before this fix -- the exact
  // same starvation bug lib/reserve-activity/backfillAll.ts already hit
  // and fixed earlier this same session, reproduced here because this is
  // genuinely separate code, not a shared function. `options.before`
  // still wins when explicitly passed (an intentional manual override).
  let before = options.before;
  if (before === undefined) {
    const cursorRows = await sql`
      select oldest_signature_indexed, backfill_complete from ledger_ingestion_cursors
      where cluster = ${cluster} and program_id = ${programId.toBase58()} and source = ${source === "backfill" ? "backfill" : "rpc-poll"}
    `;
    const cursor = cursorRows[0] as { oldest_signature_indexed: string | null; backfill_complete: boolean } | undefined;
    // Still backfilling (haven't reached the real end of history yet): continue
    // from exactly where the last call stopped. Once backfill_complete is true,
    // intentionally walk from the newest signature again each call (no `before`)
    // -- a "top-up" pass; re-upserting already-known events is a cheap no-op
    // (`on conflict (event_id) do nothing`), and this is the only way to pick up
    // genuinely NEW activity since the last run.
    if (cursor && !cursor.backfill_complete && cursor.oldest_signature_indexed) {
      before = cursor.oldest_signature_indexed;
    }
  }

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

      const txContext: Omit<TransactionContext, "instructionIndex" | "innerInstructionIndex" | "instructionName" | "eventIndex"> = {
        cluster,
        programId: programId.toBase58(),
        signature: sigInfo.signature,
        slot: tx.slot ?? null,
        blockTimeUnix: tx.blockTime ?? sigInfo.blockTime ?? null,
        transactionFailed: sigInfo.err !== null || tx.meta.err !== null,
        errorMessage: sigInfo.err ? JSON.stringify(sigInfo.err) : tx.meta.err ? JSON.stringify(tx.meta.err) : undefined,
        feePayer: tx.transaction.message.staticAccountKeys?.[0]?.toBase58(),
        computeUnitsConsumed: tx.meta.computeUnitsConsumed ?? undefined,
        networkFeeLamports: tx.meta.fee,
        // Always "confirmed" -- every transaction reaching this point was
        // fetched with `commitment: "confirmed"` above; this reports the
        // commitment level actually observed, independent of whether the
        // transaction itself succeeded or failed (those are orthogonal --
        // see the `status` field for success/failure).
        confirmationStatus: "confirmed",
        ingestionSource: source === "backfill" ? "backfill" : "rpc-poll",
      };

      const logs = tx.meta.logMessages;
      if (!logs) continue;

      // A single malformed/unparseable transaction's logs (a real,
      // pre-existing decoding edge case -- see docs/protocol/
      // LEDGER_ARCHITECTURE.md section 11 and DEC-0107's "Invalid vec for
      // assetMints" note) must NEVER abort the whole multi-page walk --
      // discovered live: without this try/catch, one bad transaction
      // anywhere in the walked range crashed ingestProgramEvents entirely,
      // losing every already-processed record from this call and
      // returning nothing. Matches lib/reserve-activity/backfillAll.ts's
      // established per-item resilience pattern, applied at the
      // per-transaction level here since that is the unit that can fail.
      let records: LedgerEventRecord[] = [];
      try {
        let eventIndex = 0;
        for (const { event, instructionIndex, innerInstructionIndex, instructionName } of parseLogsWithInstructionContext(logs, programId.toBase58(), program.coder.events)) {
          const ctx = extractReserveContext(event.data);
          const isReserveTokenAmount = true; // every ssr_protocol event's primary amount is a Reserve Token amount (RESERVE_TOKEN_DECIMALS), never a raw asset-mint amount -- reserveAssetFunded is the one exception, handled inside decodeEvent.ts's fieldExtraction layer, not here
          const record = buildLedgerEventRecord(
            event,
            { ...txContext, instructionIndex, innerInstructionIndex, instructionName, eventIndex },
            {
              reserve: ctx.reserve,
              reserveTokenMint: ctx.reserveTokenMint,
              reserveAssetMint: ctx.reserveAssetMint,
              decimals: isReserveTokenAmount ? RESERVE_TOKEN_DECIMALS : null,
              actorRoleContext: actorLookup.getContext(ctx.reserve),
            },
          );
          if (record) records.push(record);
          collectReserveContextEvent(contextEvents, event, ctx.reserve, tx.slot ?? 0, record?.event_ts_utc ?? new Date().toISOString());
          eventIndex++;
        }
      } catch (e) {
        errors.push(`${sigInfo.signature}: ${e instanceof Error ? e.message : String(e)}`);
        records = [];
      }

      // A failed transaction whose logs decoded to ZERO events (the common
      // case -- most failures happen before the instruction body reaches
      // an emit!() call) previously vanished entirely: no record, no row,
      // no trace it was ever attempted. Flagged live as "no failed
      // transactions or error history" in an acquisition-readiness review.
      if (records.length === 0 && txContext.transactionFailed) {
        records.push(buildFailedTransactionRecord({ ...txContext, instructionIndex: undefined, innerInstructionIndex: undefined, instructionName: undefined, eventIndex: undefined }));
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

  if (contextEvents.length > 0) {
    await applyReserveContextEvents(sql, cluster, contextEvents);
  }

  await upsertCursor(sql, cluster, programId.toBase58(), source === "backfill" ? "backfill" : "rpc-poll", { oldestSignatureWalked, reachedRealEnd });

  return { cluster, signaturesWalked, transactionsFetched, eventsUpserted, reachedRealEnd, errors };
}

/** Recognizes the handful of event types that define a Reserve's current manager/creator/delegate set, and stages them for applyReserveContextEvents (called once at the end of the sweep, after being sorted into true chronological order). A no-op for every other event type. */
function collectReserveContextEvent(out: ReserveContextEvent[], event: { name: string; data: Record<string, unknown> }, reserve: string | null, slot: number, eventTsUtc: string): void {
  if (!reserve) return;
  const d = event.data;
  if (event.name === "reserveCreated") {
    out.push({ slot, reserve, eventType: "reserveCreated", manager: pk(d.manager), eventTsUtc });
  } else if (event.name === "reserveManagerTransferred") {
    out.push({ slot, reserve, eventType: "reserveManagerTransferred", manager: pk(d.newManager), eventTsUtc });
  } else if (event.name === "delegateAdded") {
    out.push({ slot, reserve, eventType: "delegateAdded", delegate: pk(d.delegate), permissionsBitmask: typeof d.permissions === "number" ? d.permissions : Number(d.permissions ?? 0), restricted: Boolean(d.restricted), eventTsUtc });
  } else if (event.name === "delegatePermissionsUpdated") {
    out.push({ slot, reserve, eventType: "delegatePermissionsUpdated", delegate: pk(d.delegate), permissionsBitmask: typeof d.newPermissions === "number" ? d.newPermissions : Number(d.newPermissions ?? 0), eventTsUtc });
  } else if (event.name === "delegateRemoved") {
    out.push({ slot, reserve, eventType: "delegateRemoved", delegate: pk(d.delegate), eventTsUtc });
  }
}

async function upsertLedgerEvent(sql: ReturnType<typeof getSql>, r: LedgerEventRecord): Promise<void> {
  await sql`
    insert into ledger_events (
      event_id, cluster, program_id, signature, slot, block_time_unix, event_ts_utc, event_date_utc,
      instruction_index, inner_instruction_index, event_index, instruction_name, event_type, category, status,
      error_code, error_message, actor_wallet, actor_role, fee_payer, reserve, reserve_token_mint, reserve_asset_mint,
      source_account, destination_account, vault,
      amount_raw, amount_decimals, amount_normalized, amount_kind, usd_price_at_event, usd_price_source, usd_value_at_event,
      fee_amount_raw, fee_destination, protocol_revenue_raw, manager_revenue_raw,
      compute_units_consumed, network_fee_lamports, priority_fee_lamports, confirmation_status, summary, ingestion_source, decoder_version
    ) values (
      ${r.event_id}, ${r.cluster}, ${r.program_id}, ${r.signature}, ${r.slot}, ${r.block_time_unix}, ${r.event_ts_utc}, ${r.event_date_utc},
      ${r.instruction_index}, ${r.inner_instruction_index}, ${r.event_index}, ${r.instruction_name}, ${r.event_type}, ${r.category}, ${r.status},
      ${r.error_code}, ${r.error_message}, ${r.actor_wallet}, ${r.actor_role}, ${r.fee_payer}, ${r.reserve}, ${r.reserve_token_mint}, ${r.reserve_asset_mint},
      ${r.source_account}, ${r.destination_account}, ${r.vault},
      ${r.amount_raw}, ${r.amount_decimals}, ${r.amount_normalized}, ${r.amount_kind}, ${r.usd_price_at_event}, ${r.usd_price_source}, ${r.usd_value_at_event},
      ${r.fee_amount_raw}, ${r.fee_destination}, ${r.protocol_revenue_raw}, ${r.manager_revenue_raw},
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
