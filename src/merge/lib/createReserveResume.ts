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
