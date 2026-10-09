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
import { useEffect, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { discoverAllReserves, discoverDelegatesForReserve, resolveReserveMetadata, fetchTokenBalanceRaw, registerDynamicSupportedAssetMints, DEVNET_FIXTURES, WRAPPED_SOL_MINT, DEVUSDC_MINT } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";
import { buildDtrFromDiscoveredReserve, type AssetPriceInfo } from "./onChainReserve";
import { fetchReserveImagePointers } from "./reserveImageClient";
import { ensureReserveEntryPrices, fetchReserveEntryPrices } from "./entryPriceClient";
import { fetchReserveNavHistory, NAV_HISTORY_CACHE_KEY, NAV_HISTORY_CACHE_TTL_MS, type ServerPriceHistory } from "./navHistoryClient";
import { fetchAssetPricesUsd } from "./assetPricing";
import { buildDelegateCandidateWallets } from "./delegateDiscoveryCandidates";
import { BALANCE_CACHE_TTL_MS, getCached, isRateLimitError, nextPollDelay, tokenBalanceCacheKey, withRateLimitRetry, withReadConcurrencyLimit } from "./rpcResilience";
import { SSR_PROGRAM_ID, IS_MAINNET, MAINNET_USDC_MINT, SOLANA_CLUSTER } from "./solana-config";
import { useMainnetKnownAssetMints } from "../hooks/useMainnetKnownAssetMints";
import { useMainnetAssetCatalogue } from "../hooks/useMainnetAssetCatalogue";

const BASE_POLL_MS = 30_000; // was 15_000 -- reserve data changes rarely; halves steady-state discovery load (see rpcResilience rate-limit fix)
const MAX_POLL_MS = 120_000;
/** Bounded so a manual "refresh now" moments after a poll tick reuses that tick's result instead of re-asking the RPC -- see refreshRealReserveNow in DTRDetail.tsx, which reads through the same cache key space for the balance half of this. */
const DISCOVERY_CACHE_TTL_MS = 5_000;
/** Mainnet only: how long a batch of real Pyth/Jupiter USD prices is reused across poll ticks -- short enough that displayed AUM/Token Price/Market Cap never lag genuinely-moving prices by more than a few ticks, long enough to avoid re-pricing every asset on every 15s poll. Matches api/mainnet/asset-prices.ts's own server-side cache window. */
const ASSET_PRICE_CACHE_TTL_MS = 15_000;
/** api/mainnet/asset-prices.ts caps a single request at 30 mints -- chunk rather than assume this app will always stay under that. */
async function fetchAllAssetPrices(assets: { mint: string; decimals: number }[]): Promise<Record<string, AssetPriceInfo>> {
  const CHUNK = 30;
  const out: Record<string, AssetPriceInfo> = {};
  for (let i = 0; i < assets.length; i += CHUNK) {
    Object.assign(out, await fetchAssetPricesUsd(assets.slice(i, i + CHUNK)));
  }
  return out;
}
/** A Reserve's off-chain metadata (name/ticker/description/category) is immutable in practice -- nothing in this app resubmits update_metadata today -- so a long TTL just avoids re-fetching it on every poll tick within the same browser session, never staleness risk. */
const METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

// DevNet's static candidate list is unchanged. Mainnet's is dynamic: the
// hardcoded USDC mint (always) plus every mint the Ledger has actually seen
// used on-chain (api/ledger/known-asset-mints.ts) plus any mint THIS
// browser has itself just used to create a Reserve
// (useAppStore.mainnetKnownAssetMints) -- see
// api/ledger/known-asset-mints.ts's header for why this is deliberately
// NOT the full Jupiter catalogue.
const DEVNET_CANDIDATE_ASSET_MINTS = [WRAPPED_SOL_MINT, DEVUSDC_MINT, ...Object.values(DEVNET_FIXTURES.mints).map((m) => new PublicKey(m.address))];

const CLUSTER_LABEL = IS_MAINNET ? "Mainnet" : "DevNet";

export function RealReserveSync() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const applyDiscoveredReserves = useAppStore((s) => s.applyDiscoveredReserves);
  const syncRealHolding = useAppStore((s) => s.syncRealHolding);
  const setChainDiscoveryStatus = useAppStore((s) => s.setChainDiscoveryStatus);
  const mainnetLocalKnownMints = useAppStore((s) => s.mainnetKnownAssetMints);
  const mainnetLedgerKnownMints = useMainnetKnownAssetMints(IS_MAINNET);
  // Real symbol/name per mint (e.g. "SSR" for a Reserve composed of SSR
  // itself) -- without this, discovery had no way to resolve a Mainnet
  // asset's real symbol and every such composition entry silently fell back
  // to a generic "AssetN" placeholder (see onChainReserve.ts's
  // buildDtrFromDiscoveredReserve). Loading/unavailable states both degrade
  // to the same honest "AssetN" fallback, never a fabricated symbol.
  const mainnetCatalogue = useMainnetAssetCatalogue(IS_MAINNET);
  const mainnetMintMeta = useMemo(
    () => Object.fromEntries(mainnetCatalogue.tokens.map((t) => [t.mint, { symbol: t.symbol, name: t.name }])),
    [mainnetCatalogue.tokens],
  );

  const walletKey = connected && publicKey ? publicKey.toBase58() : null;

  const mergedMainnetMints = useMemo(
    () => (IS_MAINNET ? [...new Set<string>([MAINNET_USDC_MINT, ...mainnetLedgerKnownMints, ...mainnetLocalKnownMints])] : []),
    [mainnetLedgerKnownMints, mainnetLocalKnownMints],
  );

  // Side-effecting registration deliberately lives in its own effect, not
  // inside the useMemo above -- registerDynamicSupportedAssetMints mutates
  // shared module state and must run as a genuine effect, not during render.
  useEffect(() => {
    if (IS_MAINNET && mergedMainnetMints.length > 0) registerDynamicSupportedAssetMints(mergedMainnetMints);
  }, [mergedMainnetMints]);

  const candidateAssetMints = useMemo(
    // Defense-in-depth: mergedMainnetMints includes mints from the Ledger API and
    // this browser's persisted store. A single malformed mint string must NOT
    // white-screen discovery (new PublicKey throws on non-base58) -- drop the bad
    // entry and keep the rest as candidates.
    () =>
      IS_MAINNET
        ? mergedMainnetMints.flatMap((m) => {
            try {
              return [new PublicKey(m)];
            } catch {
              return [];
            }
          })
        : DEVNET_CANDIDATE_ASSET_MINTS,
    [mergedMainnetMints],
  );

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let running = false; // Overlap guard: a slow pass must never be joined by a second concurrent one.
    let currentDelay = BASE_POLL_MS;
    const programId = SSR_PROGRAM_ID;

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
          () => withRateLimitRetry(() => withReadConcurrencyLimit(() => discoverAllReserves(connection, programId, candidateAssetMints)), 3, 500),
        );
        if (cancelled) return;
        if (!protocolConfig) {
          setChainDiscoveryStatus("error", `SSR Protocol is not initialized on this ${CLUSTER_LABEL} endpoint.`);
          return;
        }
        if (issues.length > 0) {
          // Partial-success state: real Reserves were still found and are
          // still applied below -- a malformed/unreadable account elsewhere
          // must never invalidate otherwise-valid discovered state. Still
          // surfaced honestly rather than silently swallowed.
          console.warn(`Discovery found ${issues.length} account issue(s) this pass (non-fatal):`, issues);
        }

        // Mainnet only: one batched pricing request per discovery pass,
        // covering every distinct asset mint across every discovered
        // Reserve -- never per-Reserve (would multiply request count for no
        // benefit, since most Reserves share assets like USDC). Best-effort:
        // a pricing failure here must never fail the whole discovery pass --
        // buildDtrFromDiscoveredReserve/computeAumFromPrices already handle
        // an empty/partial priceByMint honestly (aum unavailable, never a
        // fabricated $0 silently mixed with real numbers elsewhere).
        let priceByMint: Record<string, AssetPriceInfo> = {};
        if (IS_MAINNET && reserves.length > 0) {
          const priceAssets = new Map<string, number>();
          for (const r of reserves) for (const a of r.assets) priceAssets.set(a.assetMint, a.decimals);
          const assetList = [...priceAssets.entries()].map(([mint, decimals]) => ({ mint, decimals }));
          priceByMint = await getCached(`asset-prices:${assetList.map((a) => a.mint).sort().join(",")}`, ASSET_PRICE_CACHE_TTL_MS, () => fetchAllAssetPrices(assetList)).catch(
            () => ({}) as Record<string, AssetPriceInfo>,
          );
        }

        // The mutable reserve -> picture pointer map (signature-free picture
        // changes -- see reserveImageClient.ts's fetchReserveImagePointers).
        // One small request per pass, briefly cached; a pointer always wins
        // over the Reserve's metadata-embedded imageUrl below, because the
        // pointer is exactly what a picture EDIT moves (editing no longer
        // republishes metadata or touches the chain). Best-effort: {} on any
        // failure, falling back to the metadata picture.
        const imagePointers = await getCached(`reserve-image-pointers:${SOLANA_CLUSTER}`, DISCOVERY_CACHE_TTL_MS, () =>
          fetchReserveImagePointers(window.location.origin, IS_MAINNET ? "mainnet" : "devnet"),
        ).catch(() => ({}) as Record<string, string>);

        // Mainnet only: the server-captured reserve -> (mint -> entry USD
        // price) map behind the Composition table's per-asset P&L (see
        // entryPriceClient.ts). Best-effort like the pointer map: {} on any
        // failure only blanks the P&L column, never fails the pass. Any
        // (reserve, mint) pair still missing an entry price is reported to
        // the server below, which prices it ITSELF (never client-supplied)
        // and has it ready for a later pass.
        let entryPrices: Record<string, Record<string, number>> = {};
        if (IS_MAINNET && reserves.length > 0) {
          entryPrices = await getCached("reserve-entry-prices", DISCOVERY_CACHE_TTL_MS, () => fetchReserveEntryPrices(window.location.origin)).catch(
            () => ({}) as Record<string, Record<string, number>>,
          );
          const missingPairs = reserves.flatMap((r) =>
            r.assets.filter((a) => entryPrices[r.reserve]?.[a.assetMint] === undefined).map((a) => ({ reserve: r.reserve, mint: a.assetMint, decimals: a.decimals })),
          );
          if (missingPairs.length > 0) void ensureReserveEntryPrices(window.location.origin, missingPairs);
        }

        // Mainnet only: the shared, server-recorded price history per
        // Reserve (lib/reserve-nav-history via navHistoryClient.ts) -- the
        // one history every visitor's chart and 24h/7d/all-time figures are
        // computed from, merged UNDER this browser's own live points by
        // mergeDiscoveredReserves. Best-effort like the maps above: {} on
        // any failure keeps whatever history the store already holds.
        let navHistory: Record<string, ServerPriceHistory> = {};
        if (IS_MAINNET && reserves.length > 0) {
          navHistory = await getCached(NAV_HISTORY_CACHE_KEY, NAV_HISTORY_CACHE_TTL_MS, () => fetchReserveNavHistory(window.location.origin)).catch(
            () => ({}) as Record<string, ServerPriceHistory>,
          );
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
            const dtr = buildDtrFromDiscoveredReserve(reserve, delegates, walletKey, parsedMetadata, programId, SOLANA_CLUSTER, mainnetMintMeta, priceByMint, entryPrices[reserve.reserve] ?? {});
            const pointedImageUrl = imagePointers[reserve.reserve];
            return pointedImageUrl ? { ...dtr, logoUrl: pointedImageUrl } : dtr;
          }),
        );
        if (cancelled) return;
        // A pass is only AUTHORITATIVE (allowed to prune Reserves it didn't
        // return) when it was actually capable of resolving multi-asset
        // Reserves. On Mainnet the candidate-mint list loads asynchronously
        // (useMainnetKnownAssetMints); until it arrives, mergedMainnetMints is
        // just [USDC], so this pass can only resolve USDC-only Reserves and
        // silently drops every multi-asset one as "unresolved". Marking such an
        // incomplete pass fullyVerified would PRUNE the complete backend warm-
        // cache seed (ReserveSnapshotHydrator) down to the 1 USDC Reserve, then
        // climb back a minute later -- the exact 7->1->7 flip observed. So on
        // Mainnet, only prune once the mint list has loaded past USDC; before
        // that the pass is additive and preserves the instant snapshot seed.
        // On Mainnet the warm-cache SNAPSHOT is the authoritative source for
        // WHICH Reserves exist: the server does a complete discovery incl. a
        // getProgramAccounts asset-mint enumeration the browser CANNOT do on
        // the public RPC, refreshed ~15s and re-seeded on every load
        // (ReserveSnapshotHydrator). This client poll therefore resolves only a
        // SUBSET of Reserves (the ones whose asset mints happen to be in its
        // ledger-hook candidate list) and must NEVER be treated as
        // authoritative -- a clean-but-partial pass would PRUNE the snapshot's
        // full set down to that subset (the "7 -> 1" flip). So on Mainnet the
        // poll is always ADDITIVE: it adds/updates Reserves + holdings but never
        // removes one the snapshot vouched for. DevNet has no snapshot, so it
        // keeps the original authoritative (prune-on-clean-pass) behavior.
        applyDiscoveredReserves(dtrs, !IS_MAINNET && issues.length === 0, navHistory);
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
        if (!cancelled) setChainDiscoveryStatus("error", e instanceof Error ? e.message : `${CLUSTER_LABEL} discovery failed.`);
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
  }, [connection, walletKey, applyDiscoveredReserves, syncRealHolding, setChainDiscoveryStatus, publicKey, candidateAssetMints, mainnetMintMeta]);

  return null;
}
