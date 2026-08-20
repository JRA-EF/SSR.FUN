// Mainnet-only hook: the set of Reserve Asset mints the Ledger has actually
// observed in a confirmed Mainnet on-chain event (see
// api/ledger/known-asset-mints.ts's header for the full "why not the whole
// Jupiter catalogue" rationale). Polled on a slow interval since this list
// only changes when a new asset is genuinely used for the first time --
// RealReserveSync.tsx merges the result with useAppStore's own
// mainnetKnownAssetMints (this browser's own just-created Reserve) to build
// its discovery candidate-mint list.
import { useEffect, useState } from "react";

const REFRESH_MS = 3 * 60_000;

export function useMainnetKnownAssetMints(enabled: boolean): string[] {
  const [mints, setMints] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    function fetchOnce() {
      fetch("/api/ledger/known-asset-mints")
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("request failed"))))
        .then((data: { mints?: string[] }) => {
          if (!cancelled && Array.isArray(data.mints)) setMints(data.mints);
        })
        .catch(() => {
          // Best-effort -- a read failure here just means this browser keeps
          // using whatever it already had (possibly none yet); the
          // hardcoded USDC candidate mint in RealReserveSync.tsx is
          // unaffected either way.
        });
    }

    fetchOnce();
    const interval = setInterval(fetchOnce, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  return mints;
}
