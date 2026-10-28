// Mainnet-only hook: the set of Reserve Asset mints the Ledger has actually
// observed in a confirmed Mainnet on-chain event (see
// api/ledger/known-asset-mints.ts's header for the full "why not the whole
// Jupiter catalogue" rationale). Read on load and when the user returns to a
// tab hidden for 5+ minutes, never on a timer (2026-10-28: an open tab must not
// keep draining calls), since this list only changes when a new asset is
// genuinely used for the first time --
// RealReserveSync.tsx merges the result with useAppStore's own
// mainnetKnownAssetMints (this browser's own just-created Reserve) to build
// its discovery candidate-mint list.
import { useEffect, useState } from "react";

const STALE_AFTER_MS = 5 * 60_000;

export function useMainnetKnownAssetMints(enabled: boolean): string[] {
  const [mints, setMints] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let lastFetchAt = 0;

    function fetchOnce() {
      lastFetchAt = Date.now();
      fetch("/api/ledger/known-asset-mints")
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("request failed"))))
        .then((data: { mints?: string[] }) => {
          // Same list -> keep the same array: a new one would restart RealReserveSync's
          // effect, i.e. a full chain pass, for nothing.
          if (!cancelled && Array.isArray(data.mints)) setMints((prev) => (prev.join(",") === data.mints!.join(",") ? prev : data.mints!));
        })
        .catch(() => {
          // Best-effort -- a read failure here just means this browser keeps
          // using whatever it already had (possibly none yet); the
          // hardcoded USDC candidate mint in RealReserveSync.tsx is
          // unaffected either way.
        });
    }

    fetchOnce();
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastFetchAt >= STALE_AFTER_MS) fetchOnce();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return mints;
}
