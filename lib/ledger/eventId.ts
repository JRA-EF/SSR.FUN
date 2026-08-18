// Deterministic event-ID generation for ledger_events -- pure, no DB/network
// dependency, directly unit-tested (tests/phase_ledger.ts). Re-decoding the
// exact same signature+event always produces the exact same event_id, which
// is what makes ingestion naturally idempotent via ledger_events' `unique
// (event_id)` constraint: replaying a webhook, re-running a backfill, or
// receiving the same event from two different ingestion sources all
// collapse to one row (principle 5 -- deterministic IDs, idempotent
// ingestion/replay/backfill).
//
// Deliberately a plain deterministic STRING, not a hash -- every input that
// makes two events distinct is already present in the ID, so a human can
// read a row's own event_id and immediately know what produced it, with no
// need to reverse a hash. Postgres's `unique` constraint (a btree on text)
// handles arbitrary-length keys fine at this table's realistic scale.

export interface OnChainEventIdInput {
  kind: "onchain";
  cluster: string;
  signature: string;
  eventType: string;
  /** Which instruction within the transaction emitted this event -- undefined for a legacy/unindexed decode where only the transaction as a whole is known. */
  instructionIndex?: number;
  /** Set only for an event emitted by an inner (CPI) instruction. */
  innerInstructionIndex?: number;
  /** Disambiguates multiple events of the SAME type within one instruction (e.g. a batched Rebalance emitting several ReserveAssetAdded events in one tx). */
  eventIndex?: number;
}

export interface LifecycleEventIdInput {
  kind: "lifecycle" | "operational";
  cluster: string;
  eventType: string;
  /** Caller-supplied fields that together make this event unique -- e.g. [reserve, stepName, attemptNumber] for a Create-Reserve launch step, or [sessionId, occurredAtUtc] for a product event. Joined verbatim, in order; the caller owns uniqueness. */
  dedupeParts: (string | number)[];
}

export type EventIdInput = OnChainEventIdInput | LifecycleEventIdInput;

const NONE = "-";

export function buildEventId(input: EventIdInput): string {
  if (input.kind === "onchain") {
    const parts = [
      "onchain",
      input.cluster,
      input.signature,
      input.eventType,
      input.instructionIndex ?? NONE,
      input.innerInstructionIndex ?? NONE,
      input.eventIndex ?? NONE,
    ];
    return parts.join(":");
  }
  const parts = [input.kind, input.cluster, input.eventType, ...input.dedupeParts];
  return parts.join(":");
}
