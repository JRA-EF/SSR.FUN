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
import { withRateLimitRetryGeneric, valueAssetLegsUsd, type AssetPricing } from "./readOnly";

/**
 * How an event's structured amount(s) classify for KPI aggregation
 * (see lib/reserve-activity/kpis.ts). "mintVolume"/"redeemVolume" are GROSS
 * Reserve Token amounts (net + fee) -- the right number for a "volume"
 * chart. "protocolFee"/"managerFee" are fee REVENUE realized (accrued or,
 * for the legacy pre-DEC-0094 path, directly transferred) -- never double
 * counted against "managerFeeClaimed", which is a claims-ACTIVITY metric
 * (an already-accrued balance moving into a wallet), not new revenue.
 */
export type ActivityAmountKind = "mintVolume" | "redeemVolume" | "protocolFee" | "managerFee" | "managerFeeClaimed";

export interface ActivityLogEntry {
  signature: string;
  /**
   * 0-based ordinal of this event among SAME-KIND events within its one
   * transaction (DEC-0176). One transaction can genuinely emit the same
   * event kind several times -- live-proven on Mainnet: create-Reserve
   * transactions emit up to 5 ReserveAssetInitialized events each, and the
   * old (reserve, signature, kind) dedup collapsed 83 real events into 25
   * rows. This ordinal restores a stable per-event identity.
   */
  eventIndex: number;
  /** Unix seconds, from the event's own `ts` field (chain-authoritative) -- falls back to the transaction's blockTime only if the event carried none. */
  ts: number;
  /** Anchor's camelCase event name (e.g. "delegateAdded") -- see events.rs for the full set. */
  kind: string;
  /** The wallet that performed the action, when the event carries one (every event here does except ReserveCreated-adjacent ones this log doesn't surface). */
  actor: string | null;
  /** Short, human-readable one-line description of what happened -- never fabricated, built directly from the decoded event's own fields. */
  summary: string;
  /** Primary Reserve Token amount this event moved, in raw base units as a decimal string (never a `number` -- real supplies can exceed JS's safe integer range). Undefined for events with no primary token amount (delegate/pause/metadata/lifecycle events). */
  amountRaw?: string;
  amountKind?: ActivityAmountKind;
  /** A SECOND independent amount, only for events that report two separate totals in one record (currently just `tvlFeeSettled`'s protocol+manager split and legacy `feesAccrued`'s combined event). */
  amountRaw2?: string;
  amountKind2?: ActivityAmountKind;
  /** USD value of amountRaw at the moment this event was INDEXED (DEC-0176) -- frozen once stored, never re-priced. Undefined when no valuation context was supplied or the value genuinely could not be priced (never a fabricated guess). */
  amountUsd?: number;
  amountUsd2?: number;
}

/**
 * Per-Reserve valuation context for pricing an event's amounts in USD at
 * indexing time (DEC-0176). Built by the caller (the backfill sweep) from
 * live discovery state + live asset prices; this module only does pure
 * math with it.
 */
export interface ActivityValuation {
  /** USD price + decimals per asset mint (USDC fixed at $1). An absent mint prices as 0 in leg valuations -- landing-stats' convention. */
  pricing: Record<string, AssetPricing>;
  /** USD value of ONE raw Reserve Token base unit (current NAV / supply), or null when it genuinely can't be computed (zero supply, or an unpriced asset would misstate it). */
  navUsdPerRtRawUnit: number | null;
}

/**
 * Pure: USD value(s) for one decoded event, using the event's OWN asset
 * legs where it carries them (mint/redeem/seed -- exact for USDC legs) and
 * the Reserve Token NAV for share-denominated fee amounts. Returns {} for
 * events with nothing to value; never fabricates -- a null NAV leaves a
 * share amount unvalued rather than guessing.
 */
export function valueActivityEventUsd(name: string, data: Record<string, unknown>, valuation: ActivityValuation): { amountUsd?: number; amountUsd2?: number } {
  const pkStr = (v: unknown): string => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58(): string }).toBase58() : String(v));
  const legs = (mints: unknown, amounts: unknown): number | undefined =>
    Array.isArray(mints) && Array.isArray(amounts) ? valueAssetLegsUsd(mints.map(pkStr), (amounts as unknown[]).map((a) => String(a ?? 0)), valuation.pricing) : undefined;
  const nav = valuation.navUsdPerRtRawUnit;
  const shares = (v: unknown): number | undefined => (nav === null || v === undefined || v === null ? undefined : Number(String(v)) * nav);
  const sumShares = (v: unknown): number | undefined => (Array.isArray(v) ? shares((v as unknown[]).reduce((s: bigint, x) => s + BigInt(String(x ?? 0)), 0n).toString()) : undefined);

  switch (name) {
    case "reserveTokensMinted":
      return { amountUsd: legs(data.assetMints, data.assetAmountsIn) };
    case "reserveTokensRedeemed":
      return { amountUsd: legs(data.assetMints, data.assetAmountsOut) };
    case "reserveSeeded":
      return { amountUsd: legs(data.assetMints, data.assetAmounts) };
    case "protocolMintFeeTransferred":
    case "protocolFeeCollected":
    case "managerFeeShareCollected":
      return { amountUsd: shares(data.amount) };
    case "managerFeeShareAccrued":
      return { amountUsd: sumShares(data.amounts) };
    case "tvlFeeSettled":
      return { amountUsd: shares(data.protocolFeeShares), amountUsd2: shares(data.managerFeeShares) };
    case "feesAccrued":
      return { amountUsd: shares(data.managerFeeSharesAccrued), amountUsd2: shares(data.protocolFeeSharesAccrued) };
    case "feeVaultCredited":
      return { amountUsd: shares(data.protocolShares), amountUsd2: shares(data.managerShares) };
    case "feeUsdcDistributed":
      // USDC amounts are exact by definition (6 decimals) -- no NAV needed.
      return { amountUsd: Number(String(data.protocolUsdc ?? 0)) / 1e6, amountUsd2: Number(String(data.managerUsdc ?? 0)) / 1e6 };
    default:
      return {};
  }
}

/**
 * Pure, offline-testable: decodes one already-parsed Anchor event into a
 * display-ready summary plus (when the event carries one) a structured
 * amount for KPI aggregation. Split out from the network-touching fetch
 * function below so it's directly unit-tested
 * (tests/phase_road_to_mainnet_feedback.ts) without needing a live
 * Connection -- same rationale as createReserveResume.ts's split from
 * createReserveClient.ts.
 */
export function summarizeActivityEvent(
  name: string,
  data: Record<string, unknown>,
): { actor: string | null; summary: string; amountRaw?: string; amountKind?: ActivityAmountKind; amountRaw2?: string; amountKind2?: ActivityAmountKind } | null {
  const pk = (v: unknown): string => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58(): string }).toBase58() : String(v));
  const pkList = (v: unknown): string[] => (Array.isArray(v) ? v.map(pk) : []);
  /** BigInt-safe sum of any number of BN/string/number-like u64 values -- never a JS `number` intermediate, since a summed supply can exceed Number.MAX_SAFE_INTEGER. */
  const addBig = (...vals: unknown[]): string => vals.reduce((sum: bigint, v) => sum + BigInt(String(v ?? 0)), 0n).toString();

  switch (name) {
    case "reserveCreated":
      return { actor: pk(data.manager), summary: `Reserve created by ${pk(data.manager)}` };
    case "reserveAssetInitialized":
      return { actor: null, summary: `Reserve asset ${pk(data.assetMint)} initialized at ${String(data.targetWeightBps)}bps` };
    case "reserveTokensMinted":
      return {
        actor: pk(data.depositor),
        summary: `${pk(data.depositor)} minted ${String(data.reserveTokensOut)} Reserve Token unit(s) (${String(data.mintFeeReserveTokens)} fee)`,
        amountRaw: addBig(data.reserveTokensOut, data.mintFeeReserveTokens),
        amountKind: "mintVolume",
      };
    case "reserveTokensRedeemed":
      return {
        actor: pk(data.redeemer),
        summary: `${pk(data.redeemer)} redeemed ${String(data.reserveTokensBurned)} Reserve Token unit(s) (${String(data.redemptionFeeReserveTokens)} fee)`,
        amountRaw: addBig(data.reserveTokensBurned, data.redemptionFeeReserveTokens),
        amountKind: "redeemVolume",
      };
    case "protocolMintFeeTransferred":
      return {
        actor: null,
        summary: `Protocol mint fee transferred: ${String(data.amount)} Reserve Token unit(s) to treasury ${pk(data.destination)}`,
        amountRaw: addBig(data.amount),
        amountKind: "protocolFee",
      };
    case "tvlFeeSettled":
      return {
        actor: pk(data.settledBy),
        summary: `Weekly TVL fee settled for period ${new Date(Number(data.periodStartTs) * 1000).toLocaleDateString()}-${new Date(Number(data.periodEndTs) * 1000).toLocaleDateString()}: ${String(data.protocolFeeShares)} Protocol-share (sent to treasury) + ${String(data.managerFeeShares)} Manager-share Reserve Token unit(s)`,
        amountRaw: addBig(data.protocolFeeShares),
        amountKind: "protocolFee",
        amountRaw2: addBig(data.managerFeeShares),
        amountKind2: "managerFee",
      };
    case "managerFeeRecipientsConfigured": {
      const recipients = pkList(data.recipients);
      const allocations = Array.isArray(data.allocationsBps) ? (data.allocationsBps as unknown[]).map(String) : [];
      return {
        actor: pk(data.configuredBy),
        summary: `Manager fee routing configured: ${recipients.map((r, i) => `${r.slice(0, 4)}...=${allocations[i] ?? "?"}bps`).join(", ")}`,
      };
    }
    case "managerFeeShareAccrued": {
      const recipients = pkList(data.recipients);
      const amounts = Array.isArray(data.amounts) ? (data.amounts as unknown[]).map(String) : [];
      const source = typeof data.source === "object" && data.source ? Object.keys(data.source as object)[0] : String(data.source);
      return {
        actor: null,
        summary: `Manager fee accrued (${source === "annualTvlFee" ? "TVL fee" : "mint fee"}): ${recipients.map((r, i) => `${r.slice(0, 4)}...+=${amounts[i] ?? "?"}`).join(", ")}`,
        amountRaw: addBig(...(Array.isArray(data.amounts) ? data.amounts : [])),
        amountKind: "managerFee",
      };
    }
    case "managerFeeShareCollected":
      return {
        actor: pk(data.collectedBy),
        summary: `${pk(data.recipient)} collected ${String(data.amount)} Reserve Token unit(s) of its own accrued Manager fee`,
        amountRaw: addBig(data.amount),
        amountKind: "managerFeeClaimed",
      };
    case "feesAccrued":
      return {
        actor: null,
        summary: `Fees accrued (legacy): ${String(data.managerFeeSharesAccrued)} manager-share + ${String(data.protocolFeeSharesAccrued)} protocol-share Reserve Token units`,
        amountRaw: addBig(data.managerFeeSharesAccrued),
        amountKind: "managerFee",
        amountRaw2: addBig(data.protocolFeeSharesAccrued),
        amountKind2: "protocolFee",
      };
    case "delegateAdded":
      return { actor: pk(data.delegate), summary: `Co-Manager ${pk(data.delegate)} added (${data.restricted ? "restricted" : "unrestricted"})` };
    case "delegatePermissionsUpdated":
      return { actor: pk(data.delegate), summary: `Co-Manager ${pk(data.delegate)} permissions changed (${data.oldPermissions} -> ${data.newPermissions})` };
    case "delegateRemoved":
      return { actor: pk(data.delegate), summary: `Co-Manager ${pk(data.delegate)} removed` };
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
      return {
        actor: null,
        summary: `Reserve seeded with ${String(data.initialReserveTokens)} initial Reserve Token units (${String(data.mintFeeReserveTokens ?? 0)} minted as Protocol/Manager fee)`,
        amountRaw: addBig(data.initialReserveTokens, data.mintFeeReserveTokens ?? 0),
        amountKind: "mintVolume",
      };
    case "protocolFeeCollected":
      return {
        actor: pk(data.collectedBy),
        summary: `Protocol fee collected: ${String(data.amount)} Reserve Token units`,
        amountRaw: addBig(data.amount),
        amountKind: "protocolFee",
      };
    case "protocolInitialized":
      // Protocol-wide (not tied to any one Reserve account) -- structurally
      // unreachable from a per-Reserve getSignaturesForAddress walk
      // (fetchReserveActivityLog below), but reachable from a program-wide
      // walk (lib/ledger/ingest.ts), which is why this case exists here.
      return { actor: pk(data.authority), summary: `Protocol initialized by ${pk(data.authority)} (max ${String(data.maxReserveAssets)} Reserve Assets)` };
    case "protocolConfigUpdated":
      return {
        actor: pk(data.authority),
        summary: `Protocol config updated by ${pk(data.authority)}: default fee destination ${pk(data.oldDefaultProtocolFeeDestination)} -> ${pk(data.newDefaultProtocolFeeDestination)}, default fee ${String(data.oldDefaultProtocolFeeBps)}bps -> ${String(data.newDefaultProtocolFeeBps)}bps`,
      };
    // DEC-0176: the DEC-0133/DEC-0173 fee-settlement events. The deployed
    // Mainnet binary (2026-08-19 build) cannot emit these yet, but they are
    // in this SDK's IDL and WILL flow the moment the DEC-0173 program
    // upgrade ships -- without these cases the parser would silently drop
    // them (`default: return null`), exactly the class of gap the 2026-08-28
    // recount audit was run to rule out.
    case "feeVaultCredited": {
      const source = typeof data.source === "object" && data.source ? Object.keys(data.source as object)[0] : String(data.source);
      // Tagged protocolFee/managerFee: post-DEC-0173 this event IS the fee
      // assessment (it replaces the instant-mint/pending paths), matching
      // tvlFeeSettled's existing protocol-as-amountRaw convention.
      return {
        actor: null,
        summary: `Fee crystallized into the fee vault (${source === "annualTvlFee" ? "TVL fee" : source === "redemptionFee" ? "redemption fee" : "mint fee"}): ${String(data.protocolShares)} protocol-share + ${String(data.managerShares)} manager-share Reserve Token units`,
        amountRaw: addBig(data.protocolShares),
        amountKind: "protocolFee",
        amountRaw2: addBig(data.managerShares),
        amountKind2: "managerFee",
      };
    }
    case "feeSharesRedeemed":
      // Deliberately NO amountKind: this is fee-vault shares converting into
      // staged assets for settlement -- the fee revenue itself was already
      // counted when credited (feeVaultCredited); counting again would
      // double-count.
      return {
        actor: pk(data.redeemedBy),
        summary: `${String(data.sharesRedeemed)} fee-vault Reserve Token shares redeemed for underlying assets, staged for settlement (${String(data.protocolSharesRedeemed)} protocol + ${String(data.managerSharesRedeemed)} manager)`,
      };
    case "settlementSwapApproved":
      return {
        actor: pk(data.keeper),
        summary: `Fee-settlement swap approved: ${String(data.amount)} raw of ${pk(data.assetMint)} released to the settlement keeper for conversion to USDC`,
      };
    case "feeUsdcDistributed":
      // Deliberately NO amountKind (same no-double-count rationale as
      // feeSharesRedeemed) -- the exact USDC delivered is still recorded via
      // valueActivityEventUsd's amountUsd/amountUsd2.
      return {
        actor: pk(data.distributedBy),
        summary: `Fee settlement delivered in USDC: ${String(data.protocolUsdc)} raw to the treasury, ${String(data.managerUsdc)} raw across ${Array.isArray(data.managerRecipients) ? (data.managerRecipients as unknown[]).length : 0} manager recipient(s)`,
      };
    case "feeSettlementKeeperSet":
      return { actor: pk(data.authority), summary: `Fee-settlement keeper changed: ${pk(data.oldKeeper)} -> ${pk(data.newKeeper)}` };
    case "protocolPausedSet":
      // Protocol-wide (not tied to one Reserve account) -- like
      // protocolInitialized above, unreachable from a per-Reserve walk but
      // decodable from a program-wide one.
      return { actor: pk(data.authority), summary: data.paused ? "Protocol-wide pause ENABLED" : "Protocol-wide pause lifted" };
    default:
      return null;
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
  /**
   * DEC-0176: stop the walk the moment this already-indexed signature is
   * reached (it is NOT re-processed). Lets an incremental top-up implement
   * its documented "stop early once already-seen history is reached"
   * behavior for real: the caller passes its newest indexed signature, and
   * `reachedKnownSignature` in the result reports whether the walk actually
   * connected with known history -- if it didn't (and didn't reach the real
   * end either), there is a GAP the caller must re-backfill.
   */
  stopAtSignature?: string;
  /** Per-Reserve USD valuation context (DEC-0176) -- when supplied, each entry carries amountUsd/amountUsd2 valued at this moment. */
  valuation?: ActivityValuation;
}

export interface ActivityLogWalkResult {
  /** Newest first (matches getSignaturesForAddress's own order). */
  entries: ActivityLogEntry[];
  /** The oldest signature this call actually walked past -- pass as the next call's `before` to continue walking further back (e.g. resuming a backfill). Undefined if no signatures were found at all. */
  oldestSignatureWalked: string | undefined;
  /** True once a page came back shorter than ACTIVITY_SIGNATURES_PER_PAGE -- i.e. this walk genuinely reached the very first transaction in the Reserve's history, not just its own page/entry cap. */
  reachedRealEnd: boolean;
  /** True when the walk encountered `stopAtSignature` (always false when that option wasn't passed). */
  reachedKnownSignature: boolean;
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
  let reachedKnownSignature = false;

  for (let page = 0; page < maxPages && entries.length < ACTIVITY_MAX_ENTRIES && !reachedKnownSignature; page++) {
    const sigInfos = await withRateLimitRetryGeneric(() => connection.getSignaturesForAddress(reserveAddress, { limit: ACTIVITY_SIGNATURES_PER_PAGE, before }));
    if (sigInfos.length === 0) break;

    for (const sigInfo of sigInfos) {
      if (options.stopAtSignature && sigInfo.signature === options.stopAtSignature) {
        // Already indexed from here on down -- connect, don't re-process.
        reachedKnownSignature = true;
        break;
      }
      oldestSignatureWalked = sigInfo.signature;
      if (sigInfo.err) continue; // a failed transaction changed nothing worth logging
      const tx = await withRateLimitRetryGeneric(() => connection.getTransaction(sigInfo.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;

      // Per-transaction ordinal per event KIND (DEC-0176) -- one transaction
      // can emit the same kind several times (live-proven: 5x
      // ReserveAssetInitialized per create), and each occurrence is its own
      // entry with a stable identity.
      const kindOrdinals: Record<string, number> = {};
      for (const event of eventParser.parseLogs(logs)) {
        const decoded = summarizeActivityEvent(event.name, event.data as Record<string, unknown>);
        if (!decoded) continue;
        const ts = typeof (event.data as { ts?: { toNumber?: () => number } }).ts?.toNumber === "function"
          ? (event.data as { ts: { toNumber(): number } }).ts.toNumber()
          : (sigInfo.blockTime ?? 0);
        const eventIndex = kindOrdinals[event.name] ?? 0;
        kindOrdinals[event.name] = eventIndex + 1;
        const usd = options.valuation ? valueActivityEventUsd(event.name, event.data as Record<string, unknown>, options.valuation) : {};
        entries.push({
          signature: sigInfo.signature,
          eventIndex,
          ts,
          kind: event.name,
          actor: decoded.actor,
          summary: decoded.summary,
          amountRaw: decoded.amountRaw,
          amountKind: decoded.amountKind,
          amountRaw2: decoded.amountRaw2,
          amountKind2: decoded.amountKind2,
          amountUsd: usd.amountUsd,
          amountUsd2: usd.amountUsd2,
        });
        if (entries.length >= ACTIVITY_MAX_ENTRIES) break;
      }
      if (entries.length >= ACTIVITY_MAX_ENTRIES) break;
    }

    if (reachedKnownSignature) break;
    if (sigInfos.length < ACTIVITY_SIGNATURES_PER_PAGE) {
      reachedRealEnd = true;
      break;
    }
    before = sigInfos[sigInfos.length - 1].signature;
  }

  return { entries, oldestSignatureWalked, reachedRealEnd, reachedKnownSignature };
}
