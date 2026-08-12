// DL-01b fix: every governance/management action on a Reserve already emits
// a real Anchor event (see programs/ssr_protocol/src/events.rs) -- "kept on
// the protocol side" was already structurally true. What was missing is a
// frontend VIEW of it (ManageDTR.tsx had no Activity log at all). Reuses the
// exact getSignaturesForAddress + EventParser pattern already proven in
// readOnly.ts's fetchReserve24hVolumeUsd, generalized to every
// governance-relevant event instead of just mint/redeem.
import { Connection, PublicKey } from "@solana/web3.js";
import { EventParser, type Program } from "@anchor-lang/core";
import type { SsrProtocol } from "../idl/ssr_protocol";
import { withRateLimitRetryGeneric } from "./readOnly";

export interface ActivityLogEntry {
  signature: string;
  /** Unix seconds, from the event's own `ts` field (chain-authoritative) -- falls back to the transaction's blockTime only if the event carried none. */
  ts: number;
  /** Anchor's camelCase event name (e.g. "delegateAdded") -- see events.rs for the full set. */
  kind: string;
  /** The wallet that performed the action, when the event carries one (every event here does except ReserveCreated-adjacent ones this log doesn't surface). */
  actor: string | null;
  /** Short, human-readable one-line description of what happened -- never fabricated, built directly from the decoded event's own fields. */
  summary: string;
}

/**
 * Pure, offline-testable: decodes one already-parsed Anchor event into a
 * display-ready summary. Split out from the network-touching fetch function
 * below so it's directly unit-tested (tests/phase_road_to_mainnet_feedback.ts)
 * without needing a live Connection -- same rationale as
 * createReserveResume.ts's split from createReserveClient.ts.
 */
export function summarizeActivityEvent(name: string, data: Record<string, unknown>): { actor: string | null; summary: string } | null {
  const pk = (v: unknown): string => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58(): string }).toBase58() : String(v));
  const pkList = (v: unknown): string[] => (Array.isArray(v) ? v.map(pk) : []);

  switch (name) {
    case "delegateAdded":
      return { actor: pk(data.delegate), summary: `Delegate ${pk(data.delegate)} added (${data.restricted ? "restricted" : "unrestricted"})` };
    case "delegatePermissionsUpdated":
      return { actor: pk(data.delegate), summary: `Delegate ${pk(data.delegate)} permissions changed (${data.oldPermissions} -> ${data.newPermissions})` };
    case "delegateRemoved":
      return { actor: pk(data.delegate), summary: `Delegate ${pk(data.delegate)} removed` };
    case "targetsUpdated": {
      const mints = pkList(data.assetMints);
      const weights = Array.isArray(data.newTargetWeightsBps) ? (data.newTargetWeightsBps as unknown[]).map(String) : [];
      return { actor: pk(data.updatedBy), summary: `Target weights updated for ${mints.length} asset(s): ${mints.map((m, i) => `${m.slice(0, 4)}...=${weights[i] ?? "?"}bps`).join(", ")}` };
    }
    case "reserveAssetAdded":
      return { actor: pk(data.addedBy), summary: `Reserve asset ${pk(data.assetMint)} added at ${String(data.targetWeightBps)}bps` };
    case "reserveAssetFunded":
      return { actor: pk(data.fundedBy), summary: `Reserve asset ${pk(data.assetMint)} funded (+${String(data.amount)} raw)` };
    case "reserveAssetRemoved":
      return { actor: pk(data.removedBy), summary: `Reserve asset ${pk(data.assetMint)} removed` };
    case "windDownInitiated":
      return { actor: pk(data.initiatedBy), summary: "Wind-down initiated" };
    case "reserveClosed":
      return { actor: pk(data.closedBy), summary: "Reserve closed" };
    case "reservePaused":
      return { actor: pk(data.pausedBy), summary: "Reserve paused" };
    case "reserveUnpaused":
      return { actor: pk(data.unpausedBy), summary: "Reserve unpaused" };
    case "feesCollected":
      return {
        actor: null,
        summary: `Fees collected: ${String(data.managerFeeSharesMinted)} manager-share + ${String(data.protocolFeeSharesMinted)} protocol-share Reserve Token units minted`,
      };
    case "rebalanceRecorded":
      return { actor: pk(data.executedBy), summary: `Rebalance recorded${data.note ? `: ${String(data.note)}` : ""}` };
    case "rebalanceLegExecuted":
      return { actor: pk(data.executedBy), summary: `Rebalance leg executed: ${pk(data.mintSell)} -> ${pk(data.mintBuy)} (${String(data.amountIn)} in, ${String(data.amountOut)} out)` };
    case "metadataUpdated":
      return { actor: pk(data.updatedBy), summary: "Metadata updated" };
    case "reserveManagerTransferred":
      return { actor: pk(data.oldManager), summary: `Manager transferred: ${pk(data.oldManager)} -> ${pk(data.newManager)}` };
    case "reserveSeeded":
      return { actor: null, summary: `Reserve seeded with ${String(data.initialReserveTokens)} initial Reserve Token units` };
    default:
      return null; // Not a governance-relevant event (e.g. mint/redeem -- already covered by Trade history) -- deliberately not surfaced here.
  }
}

const ACTIVITY_DEFAULT_MAX_PAGES = 4;
const ACTIVITY_SIGNATURES_PER_PAGE = 50;
const ACTIVITY_MAX_ENTRIES = 100;

export interface ActivityLogWalkOptions {
  /** Only signatures older than this one are considered -- passed straight through to getSignaturesForAddress's own `before`. Omit to start from the newest signature. */
  before?: string;
  /** Caps how many pages of ACTIVITY_SIGNATURES_PER_PAGE signatures this call will walk -- keeps a single call's RPC cost bounded regardless of how much real history a Reserve has. Defaults to ACTIVITY_DEFAULT_MAX_PAGES. */
  maxPages?: number;
}

export interface ActivityLogWalkResult {
  /** Newest first (matches getSignaturesForAddress's own order). */
  entries: ActivityLogEntry[];
  /** The oldest signature this call actually walked past -- pass as the next call's `before` to continue walking further back (e.g. resuming a backfill). Undefined if no signatures were found at all. */
  oldestSignatureWalked: string | undefined;
  /** True once a page came back shorter than ACTIVITY_SIGNATURES_PER_PAGE -- i.e. this walk genuinely reached the very first transaction in the Reserve's history, not just its own page/entry cap. */
  reachedRealEnd: boolean;
}

/**
 * Bounded, read-only walk of a Reserve's real transaction history, decoding
 * every governance-relevant event via summarizeActivityEvent above. A
 * boundable primitive (via `before`/`maxPages`) rather than a single fixed
 * "give me the recent log" call, so the same walk can serve two different
 * callers: an incremental top-up (no `before`, stop early once already-seen
 * history is reached) and a resumable multi-request backfill (chained
 * `before` = the previous call's `oldestSignatureWalked`) -- see
 * lib/reserve-activity/indexer.ts, which persists what this returns into
 * Postgres so the frontend never has to run this walk live on every view.
 */
export async function fetchReserveActivityLog(
  connection: Connection,
  program: Program<SsrProtocol>,
  reserveAddress: PublicKey,
  options: ActivityLogWalkOptions = {},
): Promise<ActivityLogWalkResult> {
  const maxPages = options.maxPages ?? ACTIVITY_DEFAULT_MAX_PAGES;
  const eventParser = new EventParser(program.programId, program.coder);
  const entries: ActivityLogEntry[] = [];
  let before = options.before;
  let oldestSignatureWalked: string | undefined;
  let reachedRealEnd = false;

  for (let page = 0; page < maxPages && entries.length < ACTIVITY_MAX_ENTRIES; page++) {
    const sigInfos = await withRateLimitRetryGeneric(() => connection.getSignaturesForAddress(reserveAddress, { limit: ACTIVITY_SIGNATURES_PER_PAGE, before }));
    if (sigInfos.length === 0) break;

    for (const sigInfo of sigInfos) {
      oldestSignatureWalked = sigInfo.signature;
      if (sigInfo.err) continue; // a failed transaction changed nothing worth logging
      const tx = await withRateLimitRetryGeneric(() => connection.getTransaction(sigInfo.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;

      for (const event of eventParser.parseLogs(logs)) {
        const decoded = summarizeActivityEvent(event.name, event.data as Record<string, unknown>);
        if (!decoded) continue;
        const ts = typeof (event.data as { ts?: { toNumber?: () => number } }).ts?.toNumber === "function"
          ? (event.data as { ts: { toNumber(): number } }).ts.toNumber()
          : (sigInfo.blockTime ?? 0);
        entries.push({ signature: sigInfo.signature, ts, kind: event.name, actor: decoded.actor, summary: decoded.summary });
        if (entries.length >= ACTIVITY_MAX_ENTRIES) break;
      }
      if (entries.length >= ACTIVITY_MAX_ENTRIES) break;
    }

    if (sigInfos.length < ACTIVITY_SIGNATURES_PER_PAGE) {
      reachedRealEnd = true;
      break;
    }
    before = sigInfos[sigInfos.length - 1].signature;
  }

  return { entries, oldestSignatureWalked, reachedRealEnd };
}
