// Shared RPC-resilience primitives for every genuine DevNet read/write path
// in this app (RealReserveSync's discovery poll, DTRDetail's balance reads,
// the Buy/Sell zap's submission+confirmation, and Create-Reserve's cost
// estimation -- see createReserveClient.ts, which now imports
// isRateLimitError/withRateLimitRetry from here instead of defining its own
// copy). Centralized on purpose (see docs/project/PROJECT_STATUS.md's
// corrective-pass entries): scattering ad hoc retry/cache logic per
// component was how the original 429 bugs happened in the first place --
// every caller sharing ONE cache/dedupe/backoff/concurrency-limit
// implementation means a fix here fixes every caller at once.
import type { Connection } from "@solana/web3.js";
import { isRateLimitError, withRateLimitRetry } from "@ssr/sdk";

// --- Rate-limit detection + bounded backoff ---------------------------------
// Moved into packages/sdk/src/rpcResilience.ts so packages/sdk's own
// discovery.ts can share the identical implementation instead of going
// unretried -- re-exported here so every existing frontend import in this
// app keeps working unchanged.
export { isRateLimitError, withRateLimitRetry };

// --- Adaptive polling delay (pure, unit-testable) ---------------------------

/**
 * Computes the next background-poll delay given the current delay and whether
 * this cycle hit a genuine rate limit. On a 429, doubles the delay (capped at
 * maxMs) plus jitter, so a congested endpoint gets breathing room instead of
 * being hit every `baseMs` regardless. On success, steps back down toward
 * `baseMs` gradually (halves the excess over baseMs) rather than snapping
 * back instantly, so a single lucky response doesn't immediately re-trigger
 * the same burst that caused the 429 in the first place.
 */
export function nextPollDelay(currentMs: number, hitRateLimit: boolean, baseMs: number, maxMs: number, jitterFn: () => number = Math.random): number {
  if (hitRateLimit) {
    const doubled = currentMs * 2;
    const jitterMs = jitterFn() * baseMs;
    return Math.min(maxMs, doubled + jitterMs);
  }
  if (currentMs <= baseMs) return baseMs;
  const steppedDown = baseMs + (currentMs - baseMs) / 2;
  return steppedDown <= baseMs + 1 ? baseMs : steppedDown;
}

// --- Cache + in-flight de-duplication ---------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cacheStore = new Map<string, CacheEntry<unknown>>();
const inFlightStore = new Map<string, Promise<unknown>>();

/**
 * Returns a cached value for `key` if still fresh; otherwise, if an
 * identical request is already in flight, joins it instead of firing a
 * second one; otherwise calls `fn`, caches the result for `ttlMs`, and
 * returns it. This is the ONE mechanism this app uses for "don't ask the RPC
 * the same question twice within a few seconds" -- discovery, per-mint
 * balance reads, and (already, since before this pass) rent constants all
 * share it instead of each inventing their own cache.
 */
export async function getCached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = cacheStore.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > now) return cached.value;

  const inFlight = inFlightStore.get(key) as Promise<T> | undefined;
  if (inFlight) return inFlight;

  const promise = fn()
    .then((value) => {
      cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inFlightStore.delete(key);
    });
  inFlightStore.set(key, promise);
  return promise;
}

/** Forces the next `getCached` call for this exact key to fetch fresh -- used right after a confirmed transaction so the one Reserve/balance that just changed is re-read for real, instead of serving a few-seconds-stale cached value. Never invalidates anything else (see the "targeted refresh, not every Reserve" requirement). */
export function invalidateCached(key: string): void {
  cacheStore.delete(key);
}

/** Same as invalidateCached, but for every key starting with `prefix` -- used when a single logical entity (e.g. "this wallet's balances") has several cache keys under it. */
export function invalidateCachedPrefix(prefix: string): void {
  for (const key of cacheStore.keys()) {
    if (key.startsWith(prefix)) cacheStore.delete(key);
  }
}

// --- Bounded concurrency for read-only RPC calls ----------------------------

const MAX_CONCURRENT_READS = 4;
let activeReads = 0;
const readWaitQueue: (() => void)[] = [];

/** Queues a read-only RPC call behind a conservative concurrency cap so a burst (e.g. discovery enumerating several Reserves, each with several candidate-asset lookups) never fires more than MAX_CONCURRENT_READS requests at the same instant against the shared connection. Never use this around a transaction-submitting call -- submission must never be queued behind unrelated reads. */
export async function withReadConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (activeReads >= MAX_CONCURRENT_READS) {
    await new Promise<void>((resolve) => readWaitQueue.push(resolve));
  }
  activeReads++;
  try {
    return await fn();
  } finally {
    activeReads--;
    const next = readWaitQueue.shift();
    if (next) next();
  }
}

// --- Cached token balance reads ---------------------------------------------

/** Cache key shared by every balance-reading call site (RealReserveSync's poll, DTRDetail's mount effect and post-trade refresh) so they collapse into one request instead of each firing its own. */
export function tokenBalanceCacheKey(endpoint: string, mint: string, owner: string): string {
  return `balance:${endpoint}:${mint}:${owner}`;
}

/** Shared TTL for cached balance reads -- short enough that a post-trade refresh still feels immediate once explicitly invalidated, long enough to collapse the handful of near-simultaneous reads a mount effect + background poll + manual refresh would otherwise each fire separately. */
export const BALANCE_CACHE_TTL_MS = 4_000;

// --- Bounded transaction-confirmation polling -------------------------------

export type ConfirmationOutcome =
  | { status: "confirmed" }
  | { status: "failed"; error: string }
  | { status: "expired" }
  | { status: "unknown" };

/**
 * Thrown (never silently swallowed) when bounded confirmation polling
 * exhausts its attempts without a definitive on-chain answer -- carries the
 * real signature so the caller can show it, link to it, and let the user (or
 * a later reconciliation check) verify independently, instead of either
 * fabricating a success or reporting a plain failure that didn't actually
 * happen. See DTRDetail.tsx's handleBuy/handleSell, which catch this
 * specifically to show a "verification pending" state rather than the
 * generic destructive-toast failure path.
 */
export class AmbiguousConfirmationError extends Error {
  signature: string;
  /**
   * `clusterLabel` defaults to "DevNet" (matching every pre-existing
   * caller/test unchanged) rather than importing IS_MAINNET from
   * ./solana-config directly -- that module reads import.meta.env
   * (Vite-only syntax) and this file is required directly by
   * tests/phase_rpc_resilience.ts via ts-mocha's CommonJS loader, which
   * crashes on that syntax (same constraint documented in txPhaseLabel's own
   * doc comment above). Every real Mainnet caller passes its own real
   * CLUSTER_LABEL explicitly -- confirmed live (2026-08-24, road-to-mainnet
   * MCR-01): a genuinely Mainnet seed-transaction timeout was reported back
   * as "DevNet RPC could not confirm...", actively misleading about which
   * network/RPC provider was actually involved.
   */
  constructor(signature: string, clusterLabel: string = "DevNet") {
    super(`${clusterLabel} RPC could not confirm signature ${signature} within the verification window. It may still land -- check the signature before submitting another transaction.`);
    this.name = "AmbiguousConfirmationError";
    this.signature = signature;
  }
}

/**
 * Confirms an already-submitted transaction using bounded, retryable
 * signature-status polling instead of `connection.confirmTransaction`'s
 * websocket subscription (observed, live, to itself throw
 * `ws error: Unexpected server response: 429` under the same DevNet
 * congestion this whole pass addresses -- see PROJECT_STATUS.md).
 *
 * Critically, this function NEVER resubmits the transaction -- it only ever
 * reads status for the signature it was given. A 429 or transport failure
 * *during polling* is treated as inconclusive and retried (bounded); it is
 * only classified "failed" when the chain itself reports an error for this
 * signature, and only "expired" once the transaction's recorded
 * `lastValidBlockHeight` has genuinely passed. Exhausting all attempts
 * without a definitive answer returns "unknown" -- the caller must show an
 * honest verification-pending state (with the signature), never fabricate
 * success or failure.
 */
export async function confirmSignatureBounded(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<ConfirmationOutcome> {
  const maxAttempts = opts.maxAttempts ?? 20;
  const intervalMs = opts.intervalMs ?? 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { value } = await withRateLimitRetry(() => connection.getSignatureStatuses([signature]), 3, 500);
      const status = value[0];
      if (status) {
        if (status.err) return { status: "failed", error: JSON.stringify(status.err) };
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          return { status: "confirmed" };
        }
      }
      const blockHeight = await withRateLimitRetry(() => connection.getBlockHeight("confirmed"), 3, 500).catch(() => null);
      if (blockHeight !== null && blockHeight > lastValidBlockHeight) {
        return { status: "expired" };
      }
    } catch {
      // A transport failure or exhausted rate-limit retry mid-poll is
      // inconclusive, not a failure -- keep polling within the bound.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { status: "unknown" };
}

// --- Duplicate-submission gating (pure, unit-testable) ----------------------

export type TxPhase = "idle" | "preparing" | "awaiting-wallet" | "submitted" | "confirming" | "confirmed" | "failed" | "expired" | "unresolved";

/** A new submission may only start from a terminal or idle phase -- never while a prior one is being prepared, signed, submitted, or confirmed. This is the single source of truth for "prevent duplicate Buy submissions" -- both the trade button's `disabled` prop and any programmatic call site should check this instead of re-deriving their own rule. */
export function canSubmitNewTransaction(phase: TxPhase): boolean {
  return phase === "idle" || phase === "confirmed" || phase === "failed" || phase === "expired" || phase === "unresolved";
}

/**
 * User-facing label for the trade button's in-flight states -- returns null
 * for "idle"/terminal phases, where the caller should show its own normal
 * label ("Buy X", "Confirmed", etc.) instead.
 *
 * `clusterLabel` defaults to "DevNet" (every pre-existing caller/test
 * unchanged) rather than importing IS_MAINNET from ./solana-config directly
 * -- that module reads import.meta.env (Vite-only syntax) and this file is
 * required directly by tests/phase_rpc_resilience.ts via ts-mocha's
 * CommonJS loader, which crashes on that syntax (same constraint documented
 * in onChainReserve.ts's/reserveCardProps.ts's own headers). DTRDetail.tsx
 * passes its own real CLUSTER_LABEL.
 */
export function txPhaseLabel(phase: TxPhase, clusterLabel: string = "DevNet"): string | null {
  switch (phase) {
    case "preparing":
      return "Preparing transaction...";
    case "awaiting-wallet":
      return "Waiting for wallet approval...";
    case "submitted":
    case "confirming":
      return `Submitted -- confirming on ${clusterLabel}...`;
    case "unresolved":
      return `${clusterLabel} RPC is temporarily busy -- your transaction is still being verified`;
    default:
      return null;
  }
}

// --- Post-transaction reconciliation (pure, unit-testable) ------------------

/**
 * When confirmation comes back "unknown" (bounded polling exhausted with no
 * definitive answer), this is the ONE additional check this app makes before
 * giving up and showing a verification-pending state: did the wallet's real,
 * freshly-read balance actually move the way this transaction would have
 * moved it? If so, report the transaction as confirmed based on that
 * observed, real on-chain state change -- never based on an assumption.
 * `direction: "decrease"` for a spent asset (e.g. devUSDC paid into a Buy),
 * `"increase"` for a received one (e.g. Reserve Tokens minted). A small
 * tolerance is allowed since exact expected amounts can differ slightly from
 * server-side fee/slippage rounding -- this only needs to detect real
 * movement in the right direction, not match to the raw unit.
 */
export function reconcileByBalanceChange(beforeRaw: bigint, afterRaw: bigint, direction: "increase" | "decrease"): boolean {
  if (direction === "decrease") return afterRaw < beforeRaw;
  return afterRaw > beforeRaw;
}
