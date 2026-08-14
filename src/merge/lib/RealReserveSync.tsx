// Mounted once near the app root (see App.tsx). Runs the canonical on-chain
// discovery pass (see packages/sdk/src/discovery.ts) on an adaptive poll --
// this is what makes ANY genuinely deployed Reserve show up in
// Discover/DTRDetail/Portfolio/ManageDTR, not just the 2 committed fixtures
// or whatever this browser's own localStorage happens to remember. See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase A" for the
// full requirement and docs/protocol/FRONTEND_INTEGRATION.md "Canonical
// discovery" for the architecture writeup.
//
// Uses only direct, known-account reads (see packages/sdk/src/discovery.ts)
// -- never getProgramAccounts, which is confirmed blocked on the public
// DevNet RPC. Failures are surfaced honestly via chainDiscoveryStatus rather
// than silently retried forever with no user-visible signal.
//
// RPC-resilience pass (see docs/project/PROJECT_STATUS.md): this poll used
// to be an unconditional setInterval(15s) that ran forever regardless of
// what else was happening -- a real, confirmed contributor to Buy
// transactions hitting 429s, since a Buy's own submission/confirmation
// shared the same rate-limited connection as this background loop. Fixed
// with four changes, all in this one file plus the shared
// rpcResilience.ts: (1) an overlap guard so a slow pass under congestion is
// never joined by a second concurrent one; (2) the poll defers entirely
// while useAppStore's txInFlight is true (any Buy/Sell/launch in progress);
// (3) the interval is now adaptive -- it backs off on a real 429 and steps
// back down gradually on success, instead of a fixed 15s regardless of
// endpoint health; (4) the discovery call itself and every per-Reserve
// delegate/balance read go through the shared cache/dedupe/concurrency-limit
// helpers so a manual refresh (DTRDetail) landing on the same tick collapses
// into the same request instead of doubling it.
import { useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { discoverAllReserves, discoverDelegatesForReserve, resolveReserveMetadata, fetchTokenBalanceRaw, DEVNET_FIXTURES, WRAPPED_SOL_MINT, DEVUSDC_MINT } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";
import { buildDtrFromDiscoveredReserve } from "./onChainReserve";
import { buildDelegateCandidateWallets } from "./delegateDiscoveryCandidates";
import { BALANCE_CACHE_TTL_MS, getCached, isRateLimitError, nextPollDelay, tokenBalanceCacheKey, withRateLimitRetry, withReadConcurrencyLimit } from "./rpcResilience";

const BASE_POLL_MS = 15_000;
const MAX_POLL_MS = 120_000;
/** Bounded so a manual "refresh now" moments after a poll tick reuses that tick's result instead of re-asking the RPC -- see refreshRealReserveNow in DTRDetail.tsx, which reads through the same cache key space for the balance half of this. */
const DISCOVERY_CACHE_TTL_MS = 5_000;
/** A Reserve's off-chain metadata (name/ticker/description/category) is immutable in practice -- nothing in this app resubmits update_metadata today -- so a long TTL just avoids re-fetching it on every poll tick within the same browser session, never staleness risk. */
const METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const CANDIDATE_ASSET_MINTS = [WRAPPED_SOL_MINT, DEVUSDC_MINT, ...Object.values(DEVNET_FIXTURES.mints).map((m) => new PublicKey(m.address))];

export function RealReserveSync() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const applyDiscoveredReserves = useAppStore((s) => s.applyDiscoveredReserves);
  const syncRealHolding = useAppStore((s) => s.syncRealHolding);
  const setChainDiscoveryStatus = useAppStore((s) => s.setChainDiscoveryStatus);

  const walletKey = connected && publicKey ? publicKey.toBase58() : null;

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let running = false; // Overlap guard: a slow pass must never be joined by a second concurrent one.
    let currentDelay = BASE_POLL_MS;
    const programId = new PublicKey(DEVNET_FIXTURES.programId);

    function scheduleNext(delayMs: number) {
      if (cancelled) return;
      timeoutId = setTimeout(runDiscovery, delayMs);
    }

    async function runDiscovery() {
      if (running) {
        // A previous cycle is still in flight (e.g. slow under RPC
        // congestion) -- skip this tick entirely rather than overlapping it.
        scheduleNext(currentDelay);
        return;
      }
      // Defer entirely while any wallet transaction (Buy/Sell/launch) is
      // being prepared, signed, submitted, confirmed, or reconciled --
      // never race this background poll's reads against that RPC traffic.
      if (useAppStore.getState().txInFlight) {
        scheduleNext(BASE_POLL_MS);
        return;
      }

      running = true;
      let hitRateLimit = false;
      setChainDiscoveryStatus("loading");
      try {
        // withRateLimitRetry here specifically: discoverAllReserves's very
        // first call (fetchProtocolConfig) has no per-account try/catch of
        // its own (unlike every per-Reserve read inside it) -- a single
        // isolated 429 there, most likely right when this component first
        // mounts and the page has other requests in flight too, used to
        // fail the ENTIRE pass immediately and surface the error banner
        // for what's usually just one unlucky request, not a real outage.
        // Safe to retry the whole call: the failure happens at the very
        // first line, before any expensive per-Reserve work has run.
        const { reserves, protocolConfig, issues } = await getCached(
          `discovery:${connection.rpcEndpoint}:${programId.toBase58()}`,
          DISCOVERY_CACHE_TTL_MS,
          () => withRateLimitRetry(() => withReadConcurrencyLimit(() => discoverAllReserves(connection, programId, CANDIDATE_ASSET_MINTS)), 3, 500),
        );
        if (cancelled) return;
        if (!protocolConfig) {
          setChainDiscoveryStatus("error", "SSR Protocol is not initialized on this DevNet endpoint.");
          return;
        }
        if (issues.length > 0) {
          // Partial-success state: real Reserves were still found and are
          // still applied below -- a malformed/unreadable account elsewhere
          // must never invalidate otherwise-valid discovered state. Still
          // surfaced honestly rather than silently swallowed.
          console.warn(`Discovery found ${issues.length} account issue(s) this pass (non-fatal):`, issues);
        }

        const dtrs = await Promise.all(
          reserves.map(async (reserve) => {
            const delegates = await withReadConcurrencyLimit(() =>
              discoverDelegatesForReserve(connection, programId, new PublicKey(reserve.reserve), buildDelegateCandidateWallets(reserve.reserve, reserve.manager, walletKey)),
            ).catch(() => []); // Delegate resolution is best-effort/supplementary -- a failure here shouldn't fail the whole Reserve's discovery.
            // Resolves BOTH the original inline data: URI convention and the
            // permanent-URL convention that superseded it (see
            // resolveReserveMetadata's header) -- best-effort/supplementary,
            // same as delegates above: a metadata-host hiccup must never fail
            // the whole Reserve's discovery, it just falls back to the
            // honest "Unnamed Reserve (#N)" placeholder for this pass.
            const parsedMetadata = await getCached(`reserve-metadata:${reserve.metadataUri}`, METADATA_CACHE_TTL_MS, () => resolveReserveMetadata(reserve.metadataUri)).catch(
              () => null,
            );
            return buildDtrFromDiscoveredReserve(reserve, delegates, walletKey, parsedMetadata);
          }),
        );
        if (cancelled) return;
        applyDiscoveredReserves(dtrs, issues.length === 0);
        setChainDiscoveryStatus("ready");

        if (walletKey && publicKey) {
          for (const dtr of dtrs) {
            if (!dtr.onChain) continue;
            try {
              const balanceRaw = await getCached(
                tokenBalanceCacheKey(connection.rpcEndpoint, dtr.onChain.reserveTokenMint, walletKey),
                BALANCE_CACHE_TTL_MS,
                () => withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, new PublicKey(dtr.onChain!.reserveTokenMint), publicKey)),
              );
              syncRealHolding(dtr.id, balanceRaw, dtr.nav);
            } catch (e) {
              if (isRateLimitError(e)) hitRateLimit = true;
              // Transient RPC failure on one balance read -- next poll tick retries; don't fail the whole pass.
            }
          }
        }
      } catch (e) {
        if (isRateLimitError(e)) hitRateLimit = true;
        if (!cancelled) setChainDiscoveryStatus("error", e instanceof Error ? e.message : "DevNet discovery failed.");
      } finally {
        running = false;
        currentDelay = nextPollDelay(currentDelay, hitRateLimit, BASE_POLL_MS, MAX_POLL_MS);
        scheduleNext(currentDelay);
      }
    }

    runDiscovery();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, walletKey, applyDiscoveredReserves, syncRealHolding, setChainDiscoveryStatus, publicKey]);

  return null;
}
