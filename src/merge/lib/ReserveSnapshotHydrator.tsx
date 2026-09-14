// Instant first paint from the backend warm cache (Mainnet only). Mounted next
// to RealReserveSync: on mount it fetches the pre-computed reserves-snapshot
// and seeds the store, so a visitor sees real Reserves immediately instead of
// waiting on the in-browser discovery burst. RealReserveSync's normal poll runs
// alongside and REPLACES this seed with fully-live data (delegates, holdings,
// authoritative eligibility) a moment later -- this is purely a fast first
// paint. Everything is fail-safe: a missing/failed snapshot just means the page
// behaves exactly as before (the live poll fills it in).
import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { registerDynamicSupportedAssetMints } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";
import { IS_MAINNET } from "./solana-config";
import { fetchReserveSnapshot, buildDtrsFromSnapshot } from "./reserveSnapshotClient";
import { fetchReserveNavHistory, NAV_HISTORY_CACHE_KEY, NAV_HISTORY_CACHE_TTL_MS, type ServerPriceHistory } from "./navHistoryClient";
import { getCached } from "./rpcResilience";

export function ReserveSnapshotHydrator() {
  const { publicKey } = useWallet();
  const applyDiscoveredReserves = useAppStore((s) => s.applyDiscoveredReserves);

  useEffect(() => {
    if (!IS_MAINNET) return;
    let cancelled = false;
    void (async () => {
      // The shared server price history is fetched alongside the snapshot so
      // the FIRST paint of a detail page already charts real history and a
      // real all-time figure, rather than a flat line until the first live
      // poll lands. Best-effort: {} on failure, the poll retries.
      const [snapshot, navHistory] = await Promise.all([
        fetchReserveSnapshot(window.location.origin),
        getCached(NAV_HISTORY_CACHE_KEY, NAV_HISTORY_CACHE_TTL_MS, () => fetchReserveNavHistory(window.location.origin)).catch(
          () => ({}) as Record<string, ServerPriceHistory>,
        ),
      ]);
      if (cancelled || !snapshot) return;
      // Register every asset mint the snapshot's Reserves hold BEFORE seeding,
      // so isReserveTradable() passes immediately. Without this the multi-asset
      // Reserves seed but fail the Home page's Featured filter (which requires
      // isReserveTradable) until the async useMainnetKnownAssetMints hook loads
      // -- i.e. "Active Reserves 7" but "Featured: none". The snapshot already
      // carries the full mint set, so we don't wait on the hook.
      const snapshotMints = [...new Set(snapshot.reserves.flatMap((r) => r.assets.map((a) => a.assetMint)))];
      if (snapshotMints.length > 0) registerDynamicSupportedAssetMints(snapshotMints);
      let dtrs;
      try {
        dtrs = buildDtrsFromSnapshot(snapshot, publicKey ? publicKey.toBase58() : null);
      } catch {
        return; // Malformed snapshot -- fall back silently to the live poll.
      }
      if (cancelled || dtrs.length === 0) return;
      // fullyVerified=false: this is a non-authoritative seed; the live poll's
      // fully-verified pass is the source of truth and replaces it.
      applyDiscoveredReserves(dtrs, false, navHistory);
      // Visible confirmation the warm-cache seed ran (age of the snapshot the
      // user is seeing). Safe, low-volume, and lets a maintainer confirm the
      // instant-paint path fired without a debugger.
      // eslint-disable-next-line no-console
      console.info(`[warm-cache] seeded ${dtrs.length} reserves from snapshot (age ${snapshot.ageMs ?? "?"}ms)`);
    })();
    return () => {
      cancelled = true;
    };
    // Seed once on mount. Wallet-specific holdings are the live poll's job, so
    // we intentionally do not re-seed when the wallet connects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
