// Builds a full ledger_events row from an already-decoded Anchor event plus
// its transaction's metadata. Deliberately layers ON TOP of
// packages/sdk/src/activityLog.ts's summarizeActivityEvent (already
// extended with amountRaw/amountKind this project's history, DEC-0107)
// rather than re-deriving event decoding from scratch -- that logic is
// already correct and already tested (tests/phase_kpis.ts). This module's
// job is everything summarizeActivityEvent does NOT cover: transaction-
// level facts (slot, blockTime, compute units, fee, instruction index),
// actor-role classification, USD valuation, cluster tagging, and the
// deterministic event_id.
//
// Pure and directly unit-testable: takes already-fetched/parsed inputs,
// touches no network or database itself. The network-touching walk that
// PRODUCES these inputs lives in lib/ledger/ingest.ts.
import { summarizeActivityEvent, type ActivityAmountKind } from "@ssr/sdk";
import { buildEventId } from "./eventId";
import { normalizeRawAmount, computeUsdValuation, classifyActorRole, type UsdPriceSource, type ActorRole } from "./amounts";
import { extractLedgerFields } from "./fieldExtraction";
import type { LedgerEventCsvRow } from "./csv";

/** Ledger-only amount kinds not part of the shared SDK's ActivityAmountKind (see fieldExtraction.ts's comment on why this enrichment is ledger-local). */
export type LedgerAmountKind = ActivityAmountKind | "assetFunding";

export interface DecodedAnchorEvent {
  name: string;
  data: Record<string, unknown>;
}

export interface TransactionContext {
  cluster: "devnet" | "mainnet-beta";
  programId: string;
  signature: string;
  slot: number | null;
  blockTimeUnix: number | null;
  /** True if the transaction as a whole failed (meta.err !== null) -- an event decoded from a failed transaction's logs is still recorded (a failed attempt is exactly what section E/H ask for), tagged status='failed'. */
  transactionFailed: boolean;
  errorCode?: string;
  errorMessage?: string;
  feePayer?: string;
  computeUnitsConsumed?: number;
  networkFeeLamports?: number;
  priorityFeeLamports?: number;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
  instructionIndex?: number;
  innerInstructionIndex?: number | null;
  /** From lib/ledger/logWalker.ts -- the Anchor instruction name active when this event was emitted. */
  instructionName?: string | null;
  eventIndex?: number;
  ingestionSource: "rpc-poll" | "helius-webhook" | "backfill" | "manual";
  decoderVersion?: number;
}

export interface ActorRoleContext {
  reserveManager?: string | null;
  reserveCreator?: string | null;
  knownDelegates?: string[];
  protocolTreasury?: string | null;
  isKeeperTriggered?: boolean;
}

export interface UsdPricing {
  unitPriceUsd: number | null;
  source: UsdPriceSource;
}

export interface LedgerEventRecord {
  event_id: string;
  cluster: string;
  program_id: string;
  signature: string;
  slot: number | null;
  block_time_unix: number | null;
  event_ts_utc: string;
  event_date_utc: string;
  instruction_index: number | null;
  inner_instruction_index: number | null;
  event_index: number | null;
  instruction_name: string | null;
  event_type: string;
  category: "onchain";
  status: "confirmed" | "failed";
  error_code: string | null;
  error_message: string | null;
  actor_wallet: string | null;
  actor_role: ActorRole;
  fee_payer: string | null;
  reserve: string | null;
  reserve_token_mint: string | null;
  reserve_asset_mint: string | null;
  source_account: string | null;
  destination_account: string | null;
  vault: string | null;
  amount_raw: string | null;
  amount_decimals: number | null;
  amount_normalized: number | null;
  amount_kind: LedgerAmountKind | null;
  usd_price_at_event: number | null;
  usd_price_source: UsdPriceSource;
  usd_value_at_event: number | null;
  fee_amount_raw: string | null;
  fee_destination: string | null;
  protocol_revenue_raw: string | null;
  manager_revenue_raw: string | null;
  compute_units_consumed: number | null;
  network_fee_lamports: number | null;
  priority_fee_lamports: number | null;
  confirmation_status: string | null;
  summary: string;
  ingestion_source: string;
  decoder_version: number;
}

/** Deterministic: same event + same tx context always produces the same record. */
export function buildLedgerEventRecord(
  event: DecodedAnchorEvent,
  tx: TransactionContext,
  opts: { reserve?: string | null; reserveTokenMint?: string | null; reserveAssetMint?: string | null; decimals?: number | null; usdPricing?: UsdPricing; actorRoleContext?: ActorRoleContext } = {},
): LedgerEventRecord | null {
  const decoded = summarizeActivityEvent(event.name, event.data);
  if (!decoded) return null;

  const eventTsUnix = tx.blockTimeUnix ?? Math.floor(Date.now() / 1000);
  const eventTsUtc = new Date(eventTsUnix * 1000).toISOString();
  const eventDateUtc = eventTsUtc.slice(0, 10);

  const eventId = buildEventId({
    kind: "onchain",
    cluster: tx.cluster,
    signature: tx.signature,
    eventType: event.name,
    instructionIndex: tx.instructionIndex,
    innerInstructionIndex: tx.innerInstructionIndex ?? undefined,
    eventIndex: tx.eventIndex,
  });

  const extraction = extractLedgerFields(event.name, event.data);

  // decoded.amountRaw covers Reserve-Token-denominated events (the shared
  // SDK function's whole scope); extraction.extraAmountRaw fills the one
  // gap it deliberately doesn't cover -- reserveAssetFunded's Reserve
  // ASSET deposit, which is denominated in that specific mint's own
  // decimals (USDC=6, wSOL=9, ...), not the Reserve Token's. Since this
  // decode layer has no live mint-decimals lookup, amount_decimals/
  // amount_normalized are left null for it rather than guessed at the
  // caller-supplied Reserve Token decimals -- an honest gap, not a wrong
  // number (see amounts.ts's normalizeRawAmount: null decimals -> null
  // normalized, never a fabricated 0).
  const amountRaw = decoded.amountRaw ?? extraction.extraAmountRaw ?? null;
  const amountKind: LedgerAmountKind | null = decoded.amountRaw ? (decoded.amountKind ?? null) : extraction.extraAmountKind;
  const decimals = decoded.amountRaw ? (opts.decimals ?? null) : null;
  const amountNormalized = normalizeRawAmount(amountRaw, decimals);
  const usdPricing = opts.usdPricing ?? { unitPriceUsd: null, source: "unavailable" as UsdPriceSource };
  const usdValuation = computeUsdValuation(amountNormalized, usdPricing.unitPriceUsd, usdPricing.source);

  const actorRole = classifyActorRole(decoded.actor, opts.actorRoleContext ?? {});

  return {
    event_id: eventId,
    cluster: tx.cluster,
    program_id: tx.programId,
    signature: tx.signature,
    slot: tx.slot,
    block_time_unix: tx.blockTimeUnix,
    event_ts_utc: eventTsUtc,
    event_date_utc: eventDateUtc,
    instruction_index: tx.instructionIndex ?? null,
    inner_instruction_index: tx.innerInstructionIndex ?? null,
    event_index: tx.eventIndex ?? null,
    instruction_name: tx.instructionName ?? null,
    event_type: event.name,
    category: "onchain",
    status: tx.transactionFailed ? "failed" : "confirmed",
    error_code: tx.transactionFailed ? (tx.errorCode ?? null) : null,
    error_message: tx.transactionFailed ? (tx.errorMessage ?? null) : null,
    actor_wallet: decoded.actor,
    actor_role: actorRole,
    fee_payer: tx.feePayer ?? null,
    reserve: opts.reserve ?? null,
    reserve_token_mint: opts.reserveTokenMint ?? null,
    reserve_asset_mint: opts.reserveAssetMint ?? null,
    source_account: extraction.sourceAccount,
    destination_account: extraction.destinationAccount,
    vault: extraction.vault,
    amount_raw: amountRaw,
    amount_decimals: decimals,
    amount_normalized: amountNormalized,
    amount_kind: amountKind,
    usd_price_at_event: usdValuation.usdPriceAtEvent,
    usd_price_source: usdValuation.usdPriceSource,
    usd_value_at_event: usdValuation.usdValueAtEvent,
    fee_amount_raw: extraction.feeAmountRaw,
    fee_destination: extraction.feeDestination,
    protocol_revenue_raw: extraction.protocolRevenueRaw,
    manager_revenue_raw: extraction.managerRevenueRaw,
    compute_units_consumed: tx.computeUnitsConsumed ?? null,
    network_fee_lamports: tx.networkFeeLamports ?? null,
    priority_fee_lamports: tx.priorityFeeLamports ?? null,
    confirmation_status: tx.confirmationStatus ?? null,
    summary: decoded.summary,
    ingestion_source: tx.ingestionSource,
    decoder_version: tx.decoderVersion ?? 1,
  };
}

/**
 * A failed transaction whose logs contain NO decodable Anchor event (the
 * common case: most constraint/validation failures happen before the
 * instruction body reaches an `emit!()` call, so there is nothing for
 * buildLedgerEventRecord above to decode) was previously invisible in
 * ledger_events entirely -- the whole signature just produced zero rows
 * and vanished, even though it is exactly the kind of failed attempt
 * section E/H of the ledger requirement asks to be captured. This builds
 * one synthetic row per such signature instead, tagged event_type
 * 'transactionFailed' (never a real Anchor event name, so it can't be
 * confused with one), status='failed', actor_wallet defaulting to the fee
 * payer (the only identity Solana guarantees for a transaction that never
 * reached its own instruction logic) when the caller has nothing more
 * specific. One event_id per signature (via eventType alone, no
 * instruction/event index) -- there is exactly one such row possible per
 * failed signature, by construction.
 */
export function buildFailedTransactionRecord(tx: TransactionContext): LedgerEventRecord {
  const eventTsUnix = tx.blockTimeUnix ?? Math.floor(Date.now() / 1000);
  const eventTsUtc = new Date(eventTsUnix * 1000).toISOString();
  const eventDateUtc = eventTsUtc.slice(0, 10);
  const eventId = buildEventId({ kind: "onchain", cluster: tx.cluster, signature: tx.signature, eventType: "transactionFailed" });

  return {
    event_id: eventId,
    cluster: tx.cluster,
    program_id: tx.programId,
    signature: tx.signature,
    slot: tx.slot,
    block_time_unix: tx.blockTimeUnix,
    event_ts_utc: eventTsUtc,
    event_date_utc: eventDateUtc,
    instruction_index: tx.instructionIndex ?? null,
    inner_instruction_index: tx.innerInstructionIndex ?? null,
    event_index: null,
    instruction_name: tx.instructionName ?? null,
    event_type: "transactionFailed",
    category: "onchain",
    status: "failed",
    error_code: tx.errorCode ?? null,
    error_message: tx.errorMessage ?? null,
    actor_wallet: tx.feePayer ?? null,
    actor_role: "unknown",
    fee_payer: tx.feePayer ?? null,
    reserve: null,
    reserve_token_mint: null,
    reserve_asset_mint: null,
    source_account: null,
    destination_account: null,
    vault: null,
    amount_raw: null,
    amount_decimals: null,
    amount_normalized: null,
    amount_kind: null,
    usd_price_at_event: null,
    usd_price_source: "unavailable",
    usd_value_at_event: null,
    fee_amount_raw: null,
    fee_destination: null,
    protocol_revenue_raw: null,
    manager_revenue_raw: null,
    compute_units_consumed: tx.computeUnitsConsumed ?? null,
    network_fee_lamports: tx.networkFeeLamports ?? null,
    priority_fee_lamports: tx.priorityFeeLamports ?? null,
    confirmation_status: tx.confirmationStatus ?? null,
    summary: `Transaction failed${tx.instructionName ? ` during ${tx.instructionName}` : ""}${tx.errorMessage ? `: ${tx.errorMessage}` : ""}`,
    ingestion_source: tx.ingestionSource,
    decoder_version: tx.decoderVersion ?? 1,
  };
}

/** Projects a full LedgerEventRecord down to the CSV export's column shape -- kept as an explicit, tested mapping rather than assuming the two shapes stay identical forever (LedgerEventRecord may grow fields the CSV export doesn't surface yet). */
export function ledgerEventRecordToCsvRow(r: LedgerEventRecord): LedgerEventCsvRow {
  return {
    event_id: r.event_id,
    cluster: r.cluster,
    program_id: r.program_id,
    signature: r.signature,
    slot: r.slot,
    block_time_unix: r.block_time_unix,
    event_ts_utc: r.event_ts_utc,
    event_date_utc: r.event_date_utc,
    instruction_index: r.instruction_index,
    inner_instruction_index: r.inner_instruction_index,
    event_index: r.event_index,
    instruction_name: r.instruction_name,
    event_type: r.event_type,
    category: r.category,
    status: r.status,
    error_code: r.error_code,
    error_message: r.error_message,
    actor_wallet: r.actor_wallet,
    actor_role: r.actor_role,
    fee_payer: r.fee_payer,
    reserve: r.reserve,
    reserve_token_mint: r.reserve_token_mint,
    reserve_asset_mint: r.reserve_asset_mint,
    source_account: r.source_account,
    destination_account: r.destination_account,
    vault: r.vault,
    amount_raw: r.amount_raw,
    amount_decimals: r.amount_decimals,
    amount_normalized: r.amount_normalized,
    amount_kind: r.amount_kind,
    usd_price_at_event: r.usd_price_at_event,
    usd_price_source: r.usd_price_source,
    usd_value_at_event: r.usd_value_at_event,
    fee_amount_raw: r.fee_amount_raw,
    fee_destination: r.fee_destination,
    protocol_revenue_raw: r.protocol_revenue_raw,
    manager_revenue_raw: r.manager_revenue_raw,
    compute_units_consumed: r.compute_units_consumed,
    network_fee_lamports: r.network_fee_lamports,
    priority_fee_lamports: r.priority_fee_lamports,
    confirmation_status: r.confirmation_status,
    summary: r.summary,
    ingestion_source: r.ingestion_source,
    ingestion_ts: new Date().toISOString(),
    decoder_version: r.decoder_version,
  };
}
