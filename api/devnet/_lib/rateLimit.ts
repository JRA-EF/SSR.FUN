// Best-effort, in-memory per-key cooldown tracker -- the same accepted
// pattern already shipped in this repo for api/dashboard/login.ts's lockout
// (module-scope Map, explicitly documented there as resetting on cold start
// and not shared across warm serverless instances). Used by Phase B's
// faucet/sponsorship endpoints as a SECONDARY defense only; the PRIMARY,
// durable defense is always a live on-chain balance-ceiling check (see
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B -- security
// model") -- this cooldown exists to blunt rapid double-submission, not to
// be the sole anti-abuse control.
const lastActionAt = new Map<string, number>();

/** Returns milliseconds remaining until `key` is next eligible, or 0 if eligible now. Does NOT record an attempt -- call recordAction separately once the action actually proceeds. */
export function cooldownRemainingMs(key: string, cooldownMs: number): number {
  const last = lastActionAt.get(key);
  if (last === undefined) return 0;
  const elapsed = Date.now() - last;
  return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
}

export function recordAction(key: string): void {
  lastActionAt.set(key, Date.now());
}

// --- Sliding-window request counter (rpc-proxy's secondary throttle) -------
// Same accepted best-effort/in-memory tradeoffs as the cooldown map above --
// this exists to blunt a single client hammering the proxy in a tight loop,
// not to be the durable defense (that's the method allowlist plus Helius's
// own API-key-scoped rate limits).
const windowCounters = new Map<string, { count: number; windowStart: number }>();

/** Returns true if `key` is still under `maxCount` requests within the trailing `windowMs`, and records this call as one of them. Returns false (and does NOT record) once the window's count is exhausted. */
export function checkRateWindow(key: string, windowMs: number, maxCount: number): boolean {
  const now = Date.now();
  const entry = windowCounters.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    windowCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= maxCount) return false;
  entry.count += 1;
  return true;
}
