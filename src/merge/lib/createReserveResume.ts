// Pure, offline-testable decision logic for resuming a partially-completed
// Reserve deployment (see createReserveClient.ts's resumeReserveDeploymentOnChain,
// the orchestration that calls these). Split out on purpose -- see
// rpcResilience.ts's existing precedent in this file for why: every decision
// here is a pure function of already-fetched inputs, so it's covered by
// direct unit tests (tests/phase_reserve_deploy_resumability.ts) instead of
// only being exercisable via a live DevNet run.
//
// Background: a live-reported failure ("InstructionError / Custom 6400"
// during Reserve seed-funding) traced to createReserveOnChain having no
// step-level resume path at all -- a failure any time after the atomic
// create-and-register transaction landed left a real, half-built Reserve
// on-chain while the client discarded the one persisted pointer to it and
// funneled the user back to a blank "Launch a Reserve"
// form, whose only action created an entirely separate Reserve (a new
// reserve_id, since ProtocolConfig.reserve_count had already incremented).
// This module is what makes "read on-chain state, resume from the first
// incomplete step, never touch what's already done" possible.
//
// 2026-08-17 pass (see docs/project/DECISION_LOG.md): a SECOND reported
// failure class -- Step 2/2 seeding repeatedly failing with a DETERMINISTIC
// on-chain validation error (ConstraintDuplicateMutableAccount / Custom
// 2040, root-caused to seed_reserve.rs's protocol_fee_destination_token_account
// colliding with the manager's own ATA -- see pda.ts's
// resolveProtocolFeeDestinationTokenAccount and the program-side fix in
// seed_reserve.rs/mint_reserve_tokens_in_kind.rs) -- kept presenting "Resume
// Deployment" as if a plain retry might succeed, silently resubmitting the
// exact same doomed transaction every click. classifyCreateReserveError
// below is what makes "never repeatedly retry a deterministic failure"
// possible: it distinguishes a transient/retryable condition (RPC rate
// limiting, network hiccups, an ambiguous-but-possibly-landed confirmation)
// from a deterministic one (an Anchor account-constraint violation or an
// ssr_protocol custom error) that will fail identically on every retry until
// the underlying configuration or program issue is actually fixed.
import { extractCustomErrorCode, describeOnChainError, decodeAnchorFrameworkError, decodeSsrProtocolError } from "@ssr/sdk";
import { isRateLimitError, AmbiguousConfirmationError } from "./rpcResilience";

/** Mirrors the on-chain `ReserveStatus` enum's camelCase Anchor/Borsh JSON encoding (see packages/sdk/src/readOnly.ts's fetchReserveOnChain, which derives this the same way). */
export type ReserveOnChainStatus = "created" | "assetsInitializing" | "active" | "paused" | "windDown" | "closed";

export type DeploymentResumePoint =
  /** No Reserve account exists on-chain for this pending deployment's address at all -- the create-and-register attempt never landed. Not a "resume" -- start over (the same reserve_id is still safe to target, since ProtocolConfig.reserve_count was never incremented for it). */
  | { kind: "start-fresh" }
  /** create-and-register landed with exactly the expected assets registered; seed-funding and/or seeding have not (yet) completed. Safe to resume from fund-seed-assets. */
  | { kind: "resume-from-funding" }
  /** Reserve has moved past AssetsInitializing (Active or later) -- seeding already succeeded. Nothing left to submit; report success from on-chain state, never resubmit seed_reserve. */
  | { kind: "already-complete" }
  /** The Reserve exists, but its real on-chain registered-asset count doesn't match what this pending deployment expected. This can only happen from data corruption, a wallet reused across a differently-composed attempt, or an unrelated concurrent modification -- never safe to auto-resume through; the caller must surface this plainly and refuse to submit anything. */
  | { kind: "asset-count-mismatch"; onChainAssetCount: number; expectedAssetCount: number };

/**
 * The single source of truth for "what should a Resume click actually do,"
 * given nothing but the real, freshly-read on-chain state and what this
 * pending deployment expected to have created. Never itself reads the
 * network or mutates anything -- the caller is responsible for having
 * already read fresh state (never a cached/stale read) before calling this,
 * per the "read actual on-chain state before retrying" requirement.
 */
export function determineDeploymentResumePoint(params: {
  reserveExists: boolean;
  reserveStatus: ReserveOnChainStatus | null;
  onChainAssetCount: number;
  expectedAssetCount: number;
}): DeploymentResumePoint {
  if (!params.reserveExists) return { kind: "start-fresh" };
  if (params.onChainAssetCount !== params.expectedAssetCount) {
    return { kind: "asset-count-mismatch", onChainAssetCount: params.onChainAssetCount, expectedAssetCount: params.expectedAssetCount };
  }
  if (params.reserveStatus === "assetsInitializing") return { kind: "resume-from-funding" };
  // "created" with a matching (necessarily zero) expected asset count isn't
  // reachable through this app's own flow (create-and-register always bundles
  // every asset registration into the same atomic transaction as create), but
  // is handled safely here regardless: zero assets registered is never
  // "already complete" for a deployment that expected any assets, and it
  // already fell into the mismatch branch above whenever expectedAssetCount
  // > 0. A deployment that genuinely expected zero assets (not offered by
  // this app's UI) would fall through to "already-complete" here, which is
  // wrong -- but 0-asset Reserves are not a producible state from CreateDTR.tsx
  // (assets.length === 0 disables Submit), so this is unreachable in practice.
  return { kind: "already-complete" };
}

/** How much more of an asset genuinely needs to be funded, given what the seed step requires and what the wallet already, genuinely holds. Floors at zero -- never requests a negative top-up. This is what makes seed-funding idempotent: a retry after a partial success only ever asks for the real shortfall, never the full amount again. */
export function computeFundingShortfall(requiredRaw: bigint, currentBalanceRaw: bigint): bigint {
  return requiredRaw > currentBalanceRaw ? requiredRaw - currentBalanceRaw : 0n;
}

/** How far a Jupiter swap's real result landed below its quote's expected output, as a fraction of that expectation -- 0 if it met or exceeded it (a surplus is never a "shortfall"). Used only to decide whether to WARN the creator (see createReserveClient.ts's SHORTFALL_WARN_PCT/onSwapShortfall) -- the Reserve is always created with the real actualRaw amount regardless of this value, never blocked on it. */
export function computeSwapShortfallPct(targetRaw: bigint, actualRaw: bigint): number {
  if (targetRaw <= 0n || actualRaw >= targetRaw) return 0;
  return Number(targetRaw - actualRaw) / Number(targetRaw);
}

/**
 * Converts a raw on-chain token amount to its human-displayed value, given
 * the mint's own decimals -- the single place CreateDTR.tsx's swap-shortfall
 * toast (and anything else formatting a raw seed/swap amount for display)
 * does this division, so a wrong decimals value (e.g. falling back to 0 for
 * an asset SELECTABLE_ASSETS doesn't recognize, or a mint whose decimals
 * differ from the $1-peg assumption baked into the UI's own cost estimate)
 * is covered by a direct unit test instead of only being visible in a
 * live toast string. Pure and offline-testable on purpose (see this
 * module's own header).
 */
export function rawToUiAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * How much USDC (raw) to actually swap to cover a real, partial deficit --
 * NOT the full per-asset budget every time, which was the confirmed root
 * cause of a live-reported incident (2026-08-20, see
 * docs/project/DECISION_LOG.md): a creator who already held ~9x the required
 * SSR (from earlier, genuinely successful swaps this same flow had already
 * executed) still had the FULL budget swapped again on every retry, instead
 * of only the remaining shortfall -- wasting real USDC and swap fees on
 * every resume attempt. Scales `usdcBudgetRaw` (what the full target would
 * cost) proportionally down to just the `deficitRaw` fraction of
 * `targetRaw`, using the same live quote's price ratio rather than fetching
 * a second, possibly differently-priced quote for the scaled amount. Floors
 * at 1 raw unit (never 0) so a genuine, nonzero deficit never gets scaled
 * down into an amount Jupiter's own quote API would reject outright as
 * non-positive.
 */
export function scaleUsdcBudgetForDeficit(usdcBudgetRaw: bigint, deficitRaw: bigint, targetRaw: bigint): bigint {
  if (targetRaw <= 0n || deficitRaw <= 0n) return 0n;
  if (deficitRaw >= targetRaw) return usdcBudgetRaw; // nothing held yet -- the deficit IS the full target, no scaling needed.
  const scaled = (usdcBudgetRaw * deficitRaw) / targetRaw;
  return scaled > 0n ? scaled : 1n;
}

/** A persisted deployment marker older than this is treated as abandoned rather than held onto forever -- the reconciliation check against real on-chain state (never this staleness window alone) is still what actually decides whether a Reserve exists. */
export const PENDING_DEPLOY_STALE_MS = 10 * 60 * 1000;

export function isPendingDeployStale(startedAt: number, now: number): boolean {
  return now - startedAt > PENDING_DEPLOY_STALE_MS;
}

/**
 * Recognizes a wallet-adapter signing rejection (the user closed/declined
 * the approval popup) as its own, unambiguous case: unlike an RPC timeout or
 * an on-chain program error, a rejection happens strictly BEFORE any
 * transaction is submitted, so there is nothing to reconcile against
 * on-chain state and nothing that could have "actually landed anyway."
 * Matches both @solana/wallet-adapter-base's typed error name and the
 * common message text real wallets (Phantom, Solflare, Backpack) use.
 */
export function isWalletRejectionError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  if (name === "WalletSignTransactionError" || name === "WalletSignMessageError") return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes("user rejected") || msg.includes("rejected the request") || msg.includes("user declined") || msg.includes("transaction cancelled") || msg.includes("approval denied");
}

/**
 * How CreateDTR.tsx's Resume panel should treat a failure, so a Reserve
 * stuck on a genuinely deterministic on-chain condition (e.g. the manager
 * wallet colliding with the Protocol fee-destination wallet -- see
 * isFeeDestinationCollisionError below) is never presented with a plain
 * "Resume Deployment" retry button that will just resubmit the identical
 * doomed transaction forever.
 */
export type CreateReserveErrorClass =
  /** The wallet popup was closed/declined -- nothing was ever submitted. Always safe to retry immediately, whenever the user is ready. */
  | "wallet-rejected"
  /** A transaction WAS submitted but its outcome couldn't be confirmed within the polling window -- it may still land. The caller must re-read on-chain state (never blindly resubmit) before deciding what, if anything, still needs to happen. */
  | "ambiguous"
  /** RPC rate-limiting or a similar transient network condition -- the identical request is expected to succeed on a later attempt with no other change needed. */
  | "retryable"
  /** A real Anchor account-constraint violation or ssr_protocol custom error -- the exact same transaction will fail identically every time until the underlying configuration/program issue is fixed. Never auto-retry; show the decoded reason and block further submission attempts. */
  | "deterministic";

/**
 * Classifies an error from any step of createReserveOnChain/
 * resumeReserveDeploymentOnChain into one of CreateReserveErrorClass's four
 * buckets, purely from the error's own shape/message -- never guesses, never
 * defaults to "retryable" for an error it can't positively identify as
 * transient (an unrecognized error is treated as deterministic, the safer
 * failure mode: it stops a blind retry loop rather than risking one).
 */
export function classifyCreateReserveError(e: unknown): CreateReserveErrorClass {
  if (isWalletRejectionError(e)) return "wallet-rejected";
  if (e instanceof AmbiguousConfirmationError) return "ambiguous";
  if (isRateLimitError(e)) return "retryable";
  if (extractCustomErrorCode(e) !== null) return "deterministic";
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes("failed to fetch") || msg.includes("network error") || msg.includes("timed out") || msg.includes("timeout")) return "retryable";
  return "deterministic";
}

/**
 * True specifically for the manager/protocol (or depositor/protocol)
 * fee-destination-wallet collision -- Anchor's own ConstraintDuplicateMutableAccount
 * (framework error 2040) or ssr_protocol's own defense-in-depth
 * ProtocolFeeDestinationTokenAccountRequired (custom error 6055, see
 * errors.rs) -- so the UI can show the specific, actionable explanation
 * (docs/project/DECISION_LOG.md's 2026-08-17 entry) instead of a generic
 * "deterministic failure" message.
 */
export function isFeeDestinationCollisionError(e: unknown): boolean {
  const code = extractCustomErrorCode(e);
  if (code === null) return false;
  return code === 2040 || decodeSsrProtocolError(code)?.name === "ProtocolFeeDestinationTokenAccountRequired";
}

/** Re-exported so callers needing the fully-decoded, human-readable message never need a second import path for it. */
export { describeOnChainError, decodeAnchorFrameworkError };
