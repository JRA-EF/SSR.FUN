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
  if (inflight) return inflight;
  set({ status: state.reserves.length ? state.status : "loading" });
  inflight = (async () => {
    try {
      const [{ ROBINHOOD }, evm] = await Promise.all([import("@/lib/evmChain"), import("@/lib/evmReserve")]);
      const pc = evm.publicClientFor(ROBINHOOD);
      const addresses = await evm.listReserveAddresses(pc, ROBINHOOD);
      // One bad reserve (a token with a broken symbol(), say) must not blank
      // the whole directory, so each loads independently.
      const loaded = await Promise.all(addresses.map((a) => evm.loadReserve(pc, ROBINHOOD, a).catch(() => null)));
      set({ status: "ready", reserves: loaded.filter((r): r is ReserveSnapshot => r !== null), error: null, fetchedAt: Date.now() });
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
    if (Date.now() - state.fetchedAt > STALE_MS) void load();
  }, []);
  return snap;
}
