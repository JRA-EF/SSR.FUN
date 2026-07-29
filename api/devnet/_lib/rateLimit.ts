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
