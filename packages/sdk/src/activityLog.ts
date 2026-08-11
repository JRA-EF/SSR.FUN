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

const ACTIVITY_MAX_SIGNATURE_PAGES = 4;
const ACTIVITY_SIGNATURES_PER_PAGE = 50;
const ACTIVITY_MAX_ENTRIES = 100;

/**
 * Bounded, read-only walk of a Reserve's real transaction history, decoding
 * every governance-relevant event via summarizeActivityEvent above. Newest
 * first (matches getSignaturesForAddress's own order). Bounded by both a
 * page cap and an entry cap so one very active Reserve can never make this
 * unbounded-expensive -- callers should treat a full page as "there may be
 * more" (not exposed as pagination yet; a v1 scoped to "recent activity").
 */
export async function fetchReserveActivityLog(
  connection: Connection,
  program: Program<SsrProtocol>,
  reserveAddress: PublicKey,
): Promise<ActivityLogEntry[]> {
  const eventParser = new EventParser(program.programId, program.coder);
  const entries: ActivityLogEntry[] = [];
  let before: string | undefined;

  for (let page = 0; page < ACTIVITY_MAX_SIGNATURE_PAGES && entries.length < ACTIVITY_MAX_ENTRIES; page++) {
    const sigInfos = await withRateLimitRetryGeneric(() => connection.getSignaturesForAddress(reserveAddress, { limit: ACTIVITY_SIGNATURES_PER_PAGE, before }));
    if (sigInfos.length === 0) break;

    for (const sigInfo of sigInfos) {
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

    if (sigInfos.length < ACTIVITY_SIGNATURES_PER_PAGE) break;
    before = sigInfos[sigInfos.length - 1].signature;
  }

  return entries;
}
