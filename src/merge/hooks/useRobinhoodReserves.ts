// Every SSR reserve on Robinhood Chain, discovered from the factory's own
// SSRDeployed logs -- nothing is hardcoded, so a reserve created from the app
// (or anywhere else) shows up in Discover on the next refresh.
//
// This module is deliberately viem-free at import time: Discover is in the
// main bundle, and the EVM stack is only pulled in (dynamic import) when the
// list is actually fetched, so the Solana app pays nothing for it.
//
// Cached at module level: Discover and the reserve page read the same list,
// and the public RPC rate-limits bursts, so navigating must not refetch.
// Stale after STALE_MS; a create calls invalidateRobinhoodReserves() so the
// new reserve appears immediately.
import { useEffect, useSyncExternalStore } from "react";
import type { ReserveSnapshot } from "@/lib/evmReserve";
import { EVM_ENABLED } from "@/lib/evmFeature";

const STALE_MS = 60_000;

export interface RobinhoodReservesState {
  status: "idle" | "loading" | "ready" | "error";
  reserves: ReserveSnapshot[];
  error: string | null;
  fetchedAt: number;
}

let state: RobinhoodReservesState = { status: "idle", reserves: [], error: null, fetchedAt: 0 };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<RobinhoodReservesState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

async function load() {
  // The single data choke point: with the EVM surface hidden, no Robinhood
  // RPC call is made at all, so Home and Discover simply see an empty list
  // rather than each needing its own guard.
  if (!EVM_ENABLED) return;
  if (inflight) return inflight;
  set({ status: state.reserves.length ? state.status : "loading" });
  inflight = (async () => {
    try {
      const [{ LIVE_EVM_CHAINS }, evm] = await Promise.all([import("@/lib/evmChain"), import("@/lib/evmReserve")]);
      // Every LIVE EVM chain, in parallel. One chain whose RPC is down must not
      // blank the others, so each chain -- and each reserve within it -- loads
      // independently; a failed chain contributes nothing rather than an error.
      const perChain = await Promise.all(
        LIVE_EVM_CHAINS.map(async (cfg) => {
          try {
            const pc = evm.publicClientFor(cfg);
            const addresses = await evm.listReserveAddresses(pc, cfg);
            const loaded = await Promise.all(addresses.map((a) => evm.loadReserve(pc, cfg, a).catch(() => null)));
            return { ok: true as const, reserves: loaded.filter((r): r is ReserveSnapshot => r !== null) };
          } catch (e) {
            const err = e as { shortMessage?: string; message?: string };
            return { ok: false as const, reserves: [] as ReserveSnapshot[], error: `${cfg.chain.name}: ${err?.shortMessage ?? err?.message ?? String(e)}` };
          }
        }),
      );
      const failures = perChain.filter((c) => !c.ok);
      // Every chain failing is an error; some failing is a partial result,
      // reported but still shown.
      if (failures.length === perChain.length && perChain.length > 0) throw new Error(failures.map((f) => ("error" in f ? f.error : "")).join("; "));
      set({
        status: "ready",
        reserves: perChain.flatMap((c) => c.reserves),
        error: failures.length ? failures.map((f) => ("error" in f ? f.error : "")).join("; ") : null,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      set({ status: "error", error: err?.shortMessage ?? err?.message ?? String(e) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function invalidateRobinhoodReserves() {
  if (!EVM_ENABLED) return;
  state = { ...state, fetchedAt: 0 };
  void load();
}

export function useRobinhoodReserves(): RobinhoodReservesState {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    if (!EVM_ENABLED) return;
    if (Date.now() - state.fetchedAt > STALE_MS) void load();
  }, []);
  return snap;
}
