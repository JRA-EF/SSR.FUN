// Shared hook for real, on-chain-derived Reserve stats (see
// api/devnet/landing-stats.ts and its Mainnet counterpart
// api/mainnet/landing-stats.ts -- cluster-aware, IS_MAINNET picks which one
// this hook calls): globally-deduplicated Reserve Token holder count,
// rolling 24h trade volume, and the same two numbers broken out per
// Reserve. Used by both the native Home page (global KPIs) and the merge
// DTRDetail page (per-Reserve holder count/24h volume) so there is exactly
// one fetch, one cache, and one counting algorithm behind every holder/volume
// figure in the app -- never two competing implementations that could
// silently disagree. A read failure surfaces honestly as "unavailable",
// never a fabricated 0 or a permanent "not indexed" placeholder.
import { useCallback, useEffect, useRef, useState } from "react";
import { IS_MAINNET } from "../lib/solana-config";

export interface PerReserveStats {
  holders: number;
  volume24hUsd: number;
}

export interface LandingStatsData {
  holders: number;
  volume24hUsd: number;
  computedAt: number;
  reservesCounted: number;
  perReserve: Record<string, PerReserveStats>;
}

export type LandingStatsStatus = "loading" | "ready" | "unavailable";

export interface LandingStatsState {
  status: LandingStatsStatus;
  data: LandingStatsData | null;
  /** True once `data` is older than STALE_AFTER_MS -- still shown (better than nothing), but the UI can flag it as possibly out of date rather than presenting it as fresh forever. */
  stale: boolean;
  /** Re-fetches. `force: true` bypasses the server's 60s cache (see landing-stats.ts's `force=1`) -- use only right after an action that should genuinely change these numbers (a confirmed Buy/Sell), never on a routine poll. */
  refetch: (force?: boolean) => void;
}

const STALE_AFTER_MS = 90_000;

export function useLandingStats(): LandingStatsState {
  const [state, setState] = useState<{ status: LandingStatsStatus; data: LandingStatsData | null }>({ status: "loading", data: null });
  const [stale, setStale] = useState(false);
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback((force?: boolean) => {
    setStale(false);
    const base = IS_MAINNET ? "/api/mainnet/landing-stats" : "/api/devnet/landing-stats";
    fetch(force ? `${base}?force=1` : base)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("request failed"))))
      .then((data: LandingStatsData) => {
        if (!cancelledRef.current) setState({ status: "ready", data });
      })
      .catch(() => {
        // A failed refetch (e.g. after a trade) must never clobber
        // already-displayed real data with "unavailable" -- only the very
        // first load has no fallback to keep showing.
        if (!cancelledRef.current) setState((prev) => (prev.data ? prev : { status: "unavailable", data: null }));
      });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    fetchOnce();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchOnce]);

  useEffect(() => {
    if (!state.data) return;
    const remaining = state.data.computedAt + STALE_AFTER_MS - Date.now();
    if (remaining <= 0) {
      setStale(true);
      return;
    }
    const t = setTimeout(() => setStale(true), remaining);
    return () => clearTimeout(t);
  }, [state.data]);

  return { status: state.status, data: state.data, stale, refetch: fetchOnce };
}
