// Global simulation state for SSR.FUN: fictional wallet, balances, DTR
// catalog (seeded + user-created), and DTR Token holdings. Persisted to
// localStorage so progress survives a refresh.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  DTR,
  Delegate,
  Holding,
  ManagerPermissions,
  OnChainDelegateMeta,
  PricePoint,
  ProfileSocials,
  QuarantinedReserveInfo,
  Trade,
  UserProfile,
  WalletProviderId,
  WalletState,
} from "@/lib/types";
import { emptyPermissions } from "@/lib/types";
import { isManagerOrDelegate, canManageDelegates, canRebalance } from "@/lib/permissions";
import { pickLogoForId } from "@/lib/seed-data";
import { buildPlaceholderRealDTR, mergeOnChainIntoDTR, mergeDiscoveredReserves, REAL_RESERVE_DESCRIPTORS, type AssetPriceInfo } from "@/lib/onChainReserve";
import type { ReserveOnChain, FixtureReserve } from "@ssr/sdk";
import { applyRebalance, appendPricePoint, initialLiquidityForAum } from "@/lib/calculations";
import { IS_MAINNET, SSR_PROGRAM_ID } from "@/lib/solana-config";

/**
 * Migrates a persisted DTR's price history from the old shape (an object keyed by
 * "24H"/"7D"/"30D"/"All") to the new flat, chronological array. Already-flat data
 * (from a version-3+ persisted store) passes through unchanged.
 */
function migratePriceHistory(raw: unknown): PricePoint[] {
  if (Array.isArray(raw)) return raw as PricePoint[];
  if (raw && typeof raw === "object") {
    const merged = new Map<number, PricePoint>();
    for (const points of Object.values(raw as Record<string, PricePoint[]>)) {
      for (const p of points ?? []) merged.set(p.t, p);
    }
    return Array.from(merged.values()).sort((a, b) => a.t - b.t);
  }
  return [];
}

export interface TradeResult {
  success: boolean;
  message: string;
}

export interface ActionResult extends TradeResult {
  dtrId?: string;
}

export interface WalletSyncPayload {
  connected: boolean;
  connecting: boolean;
  address: string | null;
  provider: WalletProviderId | null;
  /** Real lamport balance from chain, or null to leave the previous value in place (e.g. between poll ticks). */
  solLamports: number | null;
}

interface AppState {
  wallet: WalletState;
  holdings: Holding[];
  dtrs: DTR[];
  /**
   * Genuinely-existing on-chain Reserves that fail the canonical public
   * eligibility check (packages/sdk's evaluateReserveEligibility), keyed by
   * DTR id ("devnet-<reserveId>") -- e.g. the pre-fixture-registry Reserves
   * whose registered assets can never resolve against the current DevNet
   * asset registry. Never a full DTR (no fabricated price/AUM/NAV is
   * possible from this shape). Entries accumulate across discovery passes
   * (a transient-issue pass that misses one doesn't make it disappear) and
   * are only ever added or overwritten, never speculatively removed here --
   * see DTRDetail.tsx (direct-link quarantine page) and Portfolio.tsx
   * (unsupported legacy holdings) for the two places this is read.
   */
  quarantinedReserves: Record<string, QuarantinedReserveInfo>;
  profiles: Record<string, UserProfile>;
  /**
   * Coarse status of the canonical on-chain discovery pass (see
   * src/merge/lib/RealReserveSync.tsx and packages/sdk/src/discovery.ts) --
   * distinct from any single DTR's own `chainStatus`. Drives an honest
   * loading/error banner on Discover rather than silently showing stale or
   * placeholder data forever if the DevNet RPC is unreachable.
   */
  chainDiscoveryStatus: "loading" | "ready" | "error";
  chainDiscoveryError: string | null;
  setChainDiscoveryStatus: (status: "loading" | "ready" | "error", error?: string | null) => void;

  /**
   * Mainnet only: Reserve Asset mints this BROWSER has itself just used to
   * create/seed a Reserve. RealReserveSync.tsx merges this into its
   * discovery candidate-mint list so this browser's own just-created
   * Reserve is discoverable immediately -- without waiting for the
   * ledger-derived api/ledger/known-asset-mints.ts (refreshed by a daily
   * cron) to catch up. Additive only, deliberately never pruned: a mint a
   * Reserve once used stays relevant for the life of that Reserve.
   */
  mainnetKnownAssetMints: string[];
  addKnownAssetMints: (mints: string[]) => void;

  /**
   * True while ANY wallet transaction (Buy, Sell, or a Reserve launch) is
   * being prepared, signed, submitted, confirmed, or reconciled. See
   * src/merge/lib/RealReserveSync.tsx, which checks this before each poll
   * tick and defers rather than racing its own discovery/balance reads
   * against the RPC calls a real trade is making at the same moment (this
   * contention was a real, confirmed cause of Buy transactions hitting 429s
   * -- see docs/project/PROJECT_STATUS.md's RPC-resilience corrective pass).
   */
  txInFlight: boolean;
  setTxInFlight: (inFlight: boolean) => void;

  /** Mirrors real @solana/wallet-adapter-react state into `wallet` -- see src/merge/lib/WalletSync.tsx, the only caller. */
  syncWalletFromChain: (payload: WalletSyncPayload) => void;
  disconnectWallet: () => void;
  /** Latest real wallet-adapter error (connect rejection, disconnect, signing failure, etc.), surfaced by SolanaProviders' onError. */
  walletError: string | null;
  setWalletError: (message: string | null) => void;
  /** Merges a fresh on-chain read (see src/merge/lib/RealReserveSync.tsx) into the matching real DTR entry. */
  mergeOnChainReserve: (dtrId: string, fixture: FixtureReserve, onChain: ReserveOnChain, priceByMint?: Record<string, AssetPriceInfo>, isMainnet?: boolean) => void;
  /**
   * Canonical discovery entry point (see packages/sdk/src/discovery.ts's
   * discoverAllReserves + src/merge/lib/onChainReserve.ts's
   * buildDtrFromDiscoveredReserve). Merges every genuinely-discovered
   * on-chain Reserve into `dtrs`, matched by its real on-chain address (not
   * by localStorage id) -- this is what makes a dynamically created Reserve
   * (e.g. one not in the committed fixtures) show up for any browser/device,
   * not just the one that created it. Preserves session-local price
   * history/trade log for a Reserve already known, rather than resetting it
   * on every poll tick.
   */
  /** `fullyVerified` (default true): pass false only when this discovery pass itself had unresolved per-account issues, so a previously-known on-chain DTR missing from `discovered` isn't assumed closed -- see the implementation for the fail-closed reasoning. Also accumulates any newly-ineligible Reserves into `quarantinedReserves`. */
  applyDiscoveredReserves: (discovered: DTR[], fullyVerified?: boolean) => void;
  /** Registers a newly (really) created Reserve so it shows up in Discover/DTRDetail like any other real DTR. */
  registerRealReserve: (dtr: DTR) => void;
  /** Writes a freshly-resolved on-chain delegate list (see packages/sdk/src/discovery.ts's discoverDelegatesForReserve) onto a real DTR's onChain.delegatesOnChain -- read-only, verified data; never touches the fully-local, simulated `delegates` array. */
  setOnChainDelegates: (dtrId: string, delegates: OnChainDelegateMeta[], delegateCountOnChain: number) => void;
  /** Mirrors the connected wallet's REAL Reserve Token balance for an on-chain DTR into `holdings` -- see RealReserveSync.tsx. */
  syncRealHolding: (dtrId: string, tokenBalanceRaw: string, nav: number) => void;
  /**
   * Appends one genuine post-transaction data point after a Buy/Sell this
   * wallet itself just confirmed -- called once, right after
   * mergeOnChainReserve has already refreshed this DTR's nav/aum from a
   * fresh on-chain read (see DTRDetail.tsx's refreshRealReserveNow). Uses
   * the DTR's own already-updated `nav` as the point's price -- never a
   * synthetic/animated value -- so a Reserve that's genuinely still $1.00
   * NAV (fully proportional backing) correctly logs a new $1.00 point
   * rather than an invented movement. Distinct from mergeOnChainReserve
   * itself (also used by ManageDTR's non-trade composition actions, which
   * must never log a trade).
   */
  recordConfirmedTrade: (dtrId: string, side: "buy" | "sell", tokenAmount: number, usdcAmount: number) => void;

  addDelegate: (dtrId: string, address: string, permissions: ManagerPermissions) => ActionResult;
  updateDelegatePermissions: (dtrId: string, address: string, permissions: ManagerPermissions) => ActionResult;
  removeDelegate: (dtrId: string, address: string) => ActionResult;
  rebalanceDTR: (dtrId: string, edits: Record<string, number>, adjustRemaining: boolean) => ActionResult;

  updateProfile: (address: string, updates: { displayName: string; bio: string; avatarUrl?: string; socials: ProfileSocials }) => ActionResult;
}

// buildPlaceholderRealDTR/REAL_RESERVE_DESCRIPTORS are inherently DevNet-only
// (the two named Gate-9 fixture Reserves, hardcoded to DEVNET_FIXTURES.programId
// -- see onChainReserve.ts). Never seed or backfill them on Mainnet: the live
// product must never show a DevNet placeholder, even transiently before
// RealReserveSync's first discovery poll completes (see docs/project/DECISION_LOG.md's
// Mainnet-reserve-purge entry).
const REAL_PLACEHOLDER_DTRS: DTR[] = IS_MAINNET ? [] : REAL_RESERVE_DESCRIPTORS.map(buildPlaceholderRealDTR);

const initialWallet: WalletState = {
  connected: false,
  connecting: false,
  provider: null,
  address: null,
  usdc: 0,
  ssr: 0,
  sol: 0,
};

// isManagerOrDelegate/canManageDelegates/canRebalance now live in
// permissions.ts (pure logic, no zustand dependency -- see that file's
// header comment) and are re-exported here so existing import sites
// (`import { isManagerOrDelegate } from "@/store/useAppStore"`) keep working
// unchanged.
export { isManagerOrDelegate, canManageDelegates, canRebalance };

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      wallet: initialWallet,
      holdings: [],
      dtrs: [...REAL_PLACEHOLDER_DTRS],
      quarantinedReserves: {},
      profiles: {},
      chainDiscoveryStatus: "loading",
      chainDiscoveryError: null,
      setChainDiscoveryStatus: (status, error) => set({ chainDiscoveryStatus: status, chainDiscoveryError: error ?? null }),
      mainnetKnownAssetMints: [],
      addKnownAssetMints: (mints) =>
        set((state) => {
          const merged = new Set(state.mainnetKnownAssetMints);
          for (const m of mints) merged.add(m);
          return { mainnetKnownAssetMints: [...merged] };
        }),
      txInFlight: false,
      setTxInFlight: (inFlight) => set({ txInFlight: inFlight }),
      walletError: null,
      setWalletError: (message) => set({ walletError: message }),

      mergeOnChainReserve: (dtrId, fixture, onChain, priceByMint = {}, isMainnet = false) => {
        set((state) => ({
          dtrs: state.dtrs.map((d) => (d.id === dtrId ? mergeOnChainIntoDTR(d, fixture, onChain, priceByMint, isMainnet) : d)),
        }));
      },

      // Fail-closed merge logic (drop an on-chain DTR that's genuinely gone
      // from a fully-verified discovery pass) lives in the pure, testable
      // mergeDiscoveredReserves -- see src/merge/lib/onChainReserve.ts.
      applyDiscoveredReserves: (discovered, fullyVerified = true) => {
        set((state) => {
          const { dtrs, quarantined } = mergeDiscoveredReserves(state.dtrs, discovered, fullyVerified);
          const quarantinedReserves = { ...state.quarantinedReserves };
          for (const q of quarantined) quarantinedReserves[q.id] = q;
          return { dtrs, quarantinedReserves };
        });
      },

      registerRealReserve: (dtr) => {
        set((state) => ({
          dtrs: state.dtrs.some((d) => d.id === dtr.id) ? state.dtrs.map((d) => (d.id === dtr.id ? dtr : d)) : [...state.dtrs, dtr],
        }));
      },

      setOnChainDelegates: (dtrId, delegates, delegateCountOnChain) => {
        set((state) => ({
          dtrs: state.dtrs.map((d) =>
            d.id === dtrId && d.onChain ? { ...d, onChain: { ...d.onChain, delegatesOnChain: delegates, delegateCountOnChain } } : d,
          ),
        }));
      },

      syncRealHolding: (dtrId, tokenBalanceRaw, nav) => {
        const RESERVE_TOKEN_DECIMALS = 6;
        const tokenBalance = Number(tokenBalanceRaw) / 10 ** RESERVE_TOKEN_DECIMALS;
        set((state) => {
          const existing = state.holdings.find((h) => h.dtrId === dtrId);
          if (tokenBalance <= 0) {
            return { holdings: state.holdings.filter((h) => h.dtrId !== dtrId) };
          }
          return {
            holdings: existing
              ? state.holdings.map((h) => (h.dtrId === dtrId ? { ...h, tokenBalance, avgPurchasePrice: nav } : h))
              : [...state.holdings, { dtrId, tokenBalance, avgPurchasePrice: nav }],
          };
        });
      },

      recordConfirmedTrade: (dtrId, side, tokenAmount, usdcAmount) => {
        set((state) => ({
          dtrs: state.dtrs.map((d) => {
            if (d.id !== dtrId) return d;
            const now = Date.now();
            const trade: Trade = { id: `${dtrId}-${now}`, t: now, side, price: d.nav, tokenAmount, usdcAmount };
            return {
              ...d,
              priceHistory: appendPricePoint(d.priceHistory, d.nav, now),
              trades: [...d.trades, trade].slice(-500),
            };
          }),
        }));
      },

      syncWalletFromChain: (payload) => {
        set((state) => ({
          wallet: {
            ...state.wallet,
            connected: payload.connected,
            connecting: payload.connecting,
            provider: payload.provider,
            address: payload.address,
            // usdc/ssr no longer auto-seed a fictional balance on connect --
            // this used to grant every newly-connected wallet a fake 25,000
            // USDC / 50,000 SSR balance for the (now-removed) simulated
            // Buy/Sell economy, which is exactly the legacy/mock behavior
            // this corrective pass removes (see
            // docs/project/PROJECT_STATUS.md). Left at 0/whatever they
            // already were; nothing reads them as real balances anymore.
            sol: payload.solLamports !== null ? payload.solLamports / 1_000_000_000 : state.wallet.sol,
          },
        }));
      },

      disconnectWallet: () => {
        set({ wallet: initialWallet, holdings: [] });
      },


      addDelegate: (dtrId, address, permissions) => {
        const { dtrs, wallet } = get();
        const dtr = dtrs.find((d) => d.id === dtrId);
        if (!dtr) return { success: false, message: "Reserve not found." };
        if (!canManageDelegates(dtr, wallet.address))
          return { success: false, message: "You do not have delegate-management permission." };
        if (!address.trim()) return { success: false, message: "Enter a wallet address." };
        if (address === dtr.managerAddress)
          return { success: false, message: "That wallet is already the root Manager." };
        if (dtr.delegates.some((d) => d.address === address))
          return { success: false, message: "That wallet is already a delegate." };

        const delegate: Delegate = { address, permissions, addedAt: Date.now() };
        set({
          dtrs: dtrs.map((d) => (d.id === dtrId ? { ...d, delegates: [...d.delegates, delegate] } : d)),
        });
        return { success: true, message: "Delegate added." };
      },

      updateDelegatePermissions: (dtrId, address, permissions) => {
        const { dtrs, wallet } = get();
        const dtr = dtrs.find((d) => d.id === dtrId);
        if (!dtr) return { success: false, message: "Reserve not found." };
        if (!canManageDelegates(dtr, wallet.address))
          return { success: false, message: "You do not have delegate-management permission." };

        set({
          dtrs: dtrs.map((d) =>
            d.id === dtrId
              ? { ...d, delegates: d.delegates.map((del) => (del.address === address ? { ...del, permissions } : del)) }
              : d,
          ),
        });
        return { success: true, message: "Delegate permissions updated." };
      },

      removeDelegate: (dtrId, address) => {
        const { dtrs, wallet } = get();
        const dtr = dtrs.find((d) => d.id === dtrId);
        if (!dtr) return { success: false, message: "Reserve not found." };
        if (!canManageDelegates(dtr, wallet.address))
          return { success: false, message: "You do not have delegate-management permission." };

        set({
          dtrs: dtrs.map((d) => (d.id === dtrId ? { ...d, delegates: d.delegates.filter((del) => del.address !== address) } : d)),
        });
        return { success: true, message: "Delegate removed." };
      },

      rebalanceDTR: (dtrId, edits, adjustRemaining) => {
        const { dtrs, wallet } = get();
        const dtr = dtrs.find((d) => d.id === dtrId);
        if (!dtr) return { success: false, message: "Reserve not found." };
        if (!canRebalance(dtr, wallet.address))
          return { success: false, message: "You do not have rebalancing permission." };
        if (Object.keys(edits).length === 0)
          return { success: false, message: "Edit at least one target weight." };

        const { composition, unallocatedPct } = applyRebalance(dtr.composition, edits, adjustRemaining);
        set({
          dtrs: dtrs.map((d) => (d.id === dtrId ? { ...d, composition, unallocatedPct } : d)),
        });
        return { success: true, message: "Rebalance executed and vault weights updated." };
      },

      updateProfile: (address, updates) => {
        if (!address) return { success: false, message: "Connect a wallet first." };
        const { profiles } = get();
        const now = Date.now();
        const existing = profiles[address];
        const profile: UserProfile = {
          address,
          displayName: updates.displayName.trim(),
          bio: updates.bio.trim(),
          avatarUrl: updates.avatarUrl,
          socials: updates.socials,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        set({ profiles: { ...profiles, [address]: profile } });
        return { success: true, message: "Profile saved." };
      },
    }),
    {
      name: "ssrfun-simulation",
      version: 6,
      // txInFlight is purely an in-session UI-coordination flag (RealReserveSync
      // pauses its poll while it's true) -- it must never survive a reload as
      // `true`, or a tab closed mid-transaction would permanently wedge
      // background polling on next load with nothing left to ever clear it.
      partialize: (state) => {
        const { txInFlight: _txInFlight, ...rest } = state;
        return rest;
      },
      // Backfill fields added after a user's simulation state was already
      // persisted to localStorage -- e.g. DTRs created before the logo-art
      // pool, the AMM liquidity economy, the buy/sell tax split, the
      // percent-based fee settings, or the flat price-history + trade-log
      // shape existed. Without this, "historic" self-created DTRs would keep
      // showing letter-initial avatars, NaN pricing, stale bps-shaped fee
      // configs, or a chart that can't be re-timeframed, forever.
      migrate: (persisted) => {
        const state = persisted as { dtrs?: DTR[]; profiles?: Record<string, UserProfile>; holdings?: Holding[]; wallet?: WalletState };
        if (state?.dtrs) {
          state.dtrs = state.dtrs.map((d) => {
            const legacyFee = d.feeConfig as unknown as {
              mintFeeBps?: number;
              tvlFeeBps?: number;
              managerTaxBps?: number;
            };
            return {
              ...d,
              logoSeed: d.logoSeed ?? d.id,
              logoUrl: d.logoUrl ?? pickLogoForId(d.id),
              liquidityUsdc: d.liquidityUsdc ?? initialLiquidityForAum(d.aum ?? 0),
              priceHistory: migratePriceHistory(d.priceHistory),
              trades: Array.isArray((d as unknown as { trades?: Trade[] }).trades)
                ? (d as unknown as { trades: Trade[] }).trades
                : [],
              feeConfig: {
                ...d.feeConfig,
                mintFeePct: d.feeConfig.mintFeePct ?? (legacyFee.mintFeeBps ?? 50) / 100,
                tvlFeePct: d.feeConfig.tvlFeePct ?? (legacyFee.tvlFeeBps ?? 100) / 100,
                managerBuyTaxPct: d.feeConfig.managerBuyTaxPct ?? (legacyFee.managerTaxBps ?? 0) / 100,
                managerSellTaxPct: d.feeConfig.managerSellTaxPct ?? (legacyFee.managerTaxBps ?? 0) / 100,
              },
            };
          });
        }
        if (!state?.profiles) {
          state.profiles = {};
        }
        // v4: backfill the real DevNet fixture Reserves for stores persisted
        // before real on-chain integration existed.
        if (state.dtrs) {
          for (const placeholder of REAL_PLACEHOLDER_DTRS) {
            if (!state.dtrs.some((d) => d.id === placeholder.id)) {
              state.dtrs.push(placeholder);
            }
          }
        } else {
          state.dtrs = [...REAL_PLACEHOLDER_DTRS];
        }

        // v5 (corrective DevNet data-integrity pass, see
        // docs/project/PROJECT_STATUS.md): this app now only ever discovers
        // and displays genuine on-chain DevNet Reserves. Strip any
        // fictional/seed/locally-created-simulated DTR still sitting in an
        // existing tester's localStorage from before this pass (e.g.
        // "Solana Blue Chips"/BLUE) -- these never had a real on-chain
        // account and their Buy/Sell was pure client-side arithmetic. Any
        // `holdings` entry pointing at a now-removed DTR is dropped too
        // (it was never anything but a local number). The simulated
        // usdc/ssr wallet balance (previously auto-granted on first
        // connect) is cleared -- it was never real and nothing legitimate
        // reads it anymore.
        if (state.dtrs) {
          const keptDtrs = state.dtrs.filter((d) => Boolean(d.onChain));
          const removedIds = new Set(state.dtrs.filter((d) => !d.onChain).map((d) => d.id));
          state.dtrs = keptDtrs;
          if (state.holdings) {
            state.holdings = state.holdings.filter((h) => !removedIds.has(h.dtrId));
          }
        }
        if (state.wallet) {
          state.wallet = { ...state.wallet, usdc: 0, ssr: 0 };
        }

        // v6 (Mainnet launch, see docs/project/DECISION_LOG.md): strip any
        // persisted DTR whose on-chain programId doesn't match the program
        // this exact deployment actually talks to. strategic-super-reserve.fun
        // served the DevNet build before Mainnet went live, so a returning
        // visitor's localStorage can still hold genuine DevNet Reserves
        // (including the two REAL_PLACEHOLDER_DTRS fixtures) from before this
        // cutover -- those must never appear on the Mainnet site. Runs
        // unconditionally (not just when IS_MAINNET) so the same rule also
        // protects a DevNet deployment from ever showing a stray Mainnet
        // Reserve, e.g. after a local env-var mistake. Any `holdings` entry
        // pointing at a removed DTR is dropped too, matching v5's precedent.
        if (state.dtrs) {
          const currentProgramId = SSR_PROGRAM_ID.toBase58();
          const keptDtrs = state.dtrs.filter((d) => !d.onChain || d.onChain.programId === currentProgramId);
          const removedIds = new Set(state.dtrs.filter((d) => d.onChain && d.onChain.programId !== currentProgramId).map((d) => d.id));
          state.dtrs = keptDtrs;
          if (state.holdings) {
            state.holdings = state.holdings.filter((h) => !removedIds.has(h.dtrId));
          }
        }

        return state as AppState;
      },
    },
  ),
);

export function emptyDelegatePermissions(): ManagerPermissions {
  return emptyPermissions();
}
