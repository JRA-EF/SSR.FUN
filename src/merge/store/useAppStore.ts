// Global simulation state for SSR.FUN: fictional wallet, balances, DTR
// catalog (seeded + user-created), and DTR Token holdings. Persisted to
// localStorage so progress survives a refresh.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  CreateDTRInput,
  DTR,
  Delegate,
  Holding,
  ManagerPermissions,
  OnChainDelegateMeta,
  PricePoint,
  ProfileSocials,
  Trade,
  UserProfile,
  WalletProviderId,
  WalletState,
} from "@/lib/types";
import { emptyPermissions } from "@/lib/types";
import { DTRS as SEED_DTRS, pickLogoForId } from "@/lib/seed-data";
import { buildPlaceholderRealDTR, mergeOnChainIntoDTR, REAL_RESERVE_DESCRIPTORS } from "@/lib/onChainReserve";
import type { ReserveOnChain, FixtureReserve } from "@ssr/sdk";
import {
  applyRebalance,
  appendPricePoint,
  calcAvgPurchasePrice,
  calcRecentChanges,
  calcTokensReceived,
  calcUsdcReceived,
  DEFAULT_NEW_DTR_LIQUIDITY_USDC,
  initialLiquidityForAum,
  MIN_LIQUIDITY_USDC as MIN_LIQUIDITY_FLOOR,
  TICKER_MAX_LENGTH,
} from "@/lib/calculations";

const STARTING_BALANCES = {
  usdc: 25_000,
  ssr: 50_000,
  sol: 20,
};

/** Most recent real trades kept per Reserve for the Recent Trades panel. */
const MAX_TRADES = 200;

function generateFictionalAddress(): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 44; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function slugify(ticker: string): string {
  return ticker.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

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

  /** Mirrors real @solana/wallet-adapter-react state into `wallet` -- see src/merge/lib/WalletSync.tsx, the only caller. */
  syncWalletFromChain: (payload: WalletSyncPayload) => void;
  disconnectWallet: () => void;
  /** Latest real wallet-adapter error (connect rejection, disconnect, signing failure, etc.), surfaced by SolanaProviders' onError. */
  walletError: string | null;
  setWalletError: (message: string | null) => void;
  /** Merges a fresh on-chain read (see src/merge/lib/RealReserveSync.tsx) into the matching real DTR entry. */
  mergeOnChainReserve: (dtrId: string, fixture: FixtureReserve, onChain: ReserveOnChain) => void;
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
  applyDiscoveredReserves: (discovered: DTR[]) => void;
  /** Registers a newly (really) created Reserve so it shows up in Discover/DTRDetail like any other real DTR. */
  registerRealReserve: (dtr: DTR) => void;
  /** Writes a freshly-resolved on-chain delegate list (see packages/sdk/src/discovery.ts's discoverDelegatesForReserve) onto a real DTR's onChain.delegatesOnChain -- read-only, verified data; never touches the fully-local, simulated `delegates` array. */
  setOnChainDelegates: (dtrId: string, delegates: OnChainDelegateMeta[], delegateCountOnChain: number) => void;
  /** Mirrors the connected wallet's REAL Reserve Token balance for an on-chain DTR into `holdings` -- see RealReserveSync.tsx. */
  syncRealHolding: (dtrId: string, tokenBalanceRaw: string, nav: number) => void;
  addDemoUSDC: () => void;
  buyDTRToken: (dtrId: string, usdcAmount: number) => TradeResult;
  sellDTRToken: (dtrId: string, tokenAmount: number) => TradeResult;
  resetSimulation: () => void;

  createDTR: (input: CreateDTRInput) => ActionResult;
  addDelegate: (dtrId: string, address: string, permissions: ManagerPermissions) => ActionResult;
  updateDelegatePermissions: (dtrId: string, address: string, permissions: ManagerPermissions) => ActionResult;
  removeDelegate: (dtrId: string, address: string) => ActionResult;
  rebalanceDTR: (dtrId: string, edits: Record<string, number>, adjustRemaining: boolean) => ActionResult;

  updateProfile: (address: string, updates: { displayName: string; bio: string; avatarUrl?: string; socials: ProfileSocials }) => ActionResult;
}

const REAL_PLACEHOLDER_DTRS: DTR[] = REAL_RESERVE_DESCRIPTORS.map(buildPlaceholderRealDTR);

const initialWallet: WalletState = {
  connected: false,
  connecting: false,
  provider: null,
  address: null,
  usdc: 0,
  ssr: 0,
  sol: 0,
};

/** Root Manager and every wallet with `manageDelegates` may edit delegates. */
export function canManageDelegates(dtr: DTR, address: string | null): boolean {
  if (!address) return false;
  if (dtr.managerAddress === address) return true;
  return dtr.delegates.some((d) => d.address === address && d.permissions.manageDelegates);
}

/** Root Manager and every wallet with `rebalance` may propose/execute a rebalance. */
export function canRebalance(dtr: DTR, address: string | null): boolean {
  if (!address) return false;
  if (dtr.managerAddress === address) return true;
  return dtr.delegates.some((d) => d.address === address && d.permissions.rebalance);
}

/** Root Manager plus any delegate at all may open the manager dashboard. */
export function isManagerOrDelegate(dtr: DTR, address: string | null): boolean {
  if (!address) return false;
  return dtr.managerAddress === address || dtr.delegates.some((d) => d.address === address);
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      wallet: initialWallet,
      holdings: [],
      dtrs: [...SEED_DTRS, ...REAL_PLACEHOLDER_DTRS],
      profiles: {},
      chainDiscoveryStatus: "loading",
      chainDiscoveryError: null,
      setChainDiscoveryStatus: (status, error) => set({ chainDiscoveryStatus: status, chainDiscoveryError: error ?? null }),
      walletError: null,
      setWalletError: (message) => set({ walletError: message }),

      mergeOnChainReserve: (dtrId, fixture, onChain) => {
        set((state) => ({
          dtrs: state.dtrs.map((d) => (d.id === dtrId ? mergeOnChainIntoDTR(d, fixture, onChain) : d)),
        }));
      },

      applyDiscoveredReserves: (discovered) => {
        set((state) => {
          const byAddress = new Map(state.dtrs.filter((d) => d.onChain).map((d) => [d.onChain!.reserve, d]));
          const merged = discovered.map((fresh) => {
            const existing = fresh.onChain ? byAddress.get(fresh.onChain.reserve) : undefined;
            if (!existing) return fresh;
            return {
              ...fresh,
              // Preserve session-accumulated history rather than resetting it
              // to a single fresh point on every discovery poll.
              priceHistory: existing.priceHistory.length > 1 ? existing.priceHistory : fresh.priceHistory,
              trades: existing.trades,
              logoUrl: existing.logoUrl ?? fresh.logoUrl,
            };
          });
          const discoveredAddresses = new Set(discovered.map((d) => d.onChain?.reserve).filter(Boolean));
          const untouched = state.dtrs.filter((d) => !d.onChain || !discoveredAddresses.has(d.onChain.reserve));
          return { dtrs: [...untouched, ...merged] };
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

      syncWalletFromChain: (payload) => {
        set((state) => ({
          wallet: {
            ...state.wallet,
            connected: payload.connected,
            connecting: payload.connecting,
            provider: payload.provider,
            address: payload.address,
            // usdc/ssr stay simulation-only (the fully-mocked, non-chain-backed
            // DTRs still run on the fictional AMM economy); a first-time real
            // connection seeds them once so those DTRs remain testable too.
            usdc: state.wallet.usdc === 0 && payload.connected ? STARTING_BALANCES.usdc : state.wallet.usdc,
            ssr: state.wallet.ssr === 0 && payload.connected ? STARTING_BALANCES.ssr : state.wallet.ssr,
            sol: payload.solLamports !== null ? payload.solLamports / 1_000_000_000 : state.wallet.sol,
          },
        }));
      },

      disconnectWallet: () => {
        set({ wallet: initialWallet, holdings: [] });
      },

      addDemoUSDC: () => {
        set((state) => ({
          wallet: { ...state.wallet, usdc: state.wallet.usdc + 10_000 },
        }));
      },

      buyDTRToken: (dtrId, usdcAmount) => {
        const { wallet, holdings, dtrs } = get();
        const dtr = dtrs.find((d) => d.id === dtrId);
        if (!dtr) return { success: false, message: "Reserve not found." };
        if (!wallet.connected)
          return { success: false, message: "Connect a wallet first." };
        if (usdcAmount <= 0)
          return { success: false, message: "Enter an amount greater than 0." };
        if (usdcAmount > wallet.usdc)
          return { success: false, message: "Insufficient USDC balance." };

        const { netAmount, newPrice } = calcTokensReceived(
          usdcAmount,
          dtr.tokenPrice,
          dtr.liquidityUsdc,
          dtr.feeConfig.managerBuyTaxPct,
        );
        const existing = holdings.find((h) => h.dtrId === dtrId);
        const newAvgPrice = calcAvgPurchasePrice(
          existing?.tokenBalance ?? 0,
          existing?.avgPurchasePrice ?? 0,
          netAmount,
          dtr.tokenPrice,
        );

        const nextHoldings: Holding[] = existing
          ? holdings.map((h) =>
              h.dtrId === dtrId
                ? {
                    dtrId,
                    tokenBalance: h.tokenBalance + netAmount,
                    avgPurchasePrice: newAvgPrice,
                  }
                : h,
            )
          : [...holdings, { dtrId, tokenBalance: netAmount, avgPurchasePrice: newAvgPrice }];

        const now = Date.now();
        const nextPriceHistory = appendPricePoint(dtr.priceHistory, newPrice, now);
        const { change24h, change7d } = calcRecentChanges(nextPriceHistory, newPrice);
        const trade: Trade = {
          id: `${dtrId}-${now}-${Math.random().toString(36).slice(2, 9)}`,
          t: nextPriceHistory[nextPriceHistory.length - 1].t,
          side: "buy",
          price: newPrice,
          tokenAmount: netAmount,
          usdcAmount,
        };
        const nextTrades = [...dtr.trades, trade].slice(-MAX_TRADES);

        set({
          wallet: { ...wallet, usdc: wallet.usdc - usdcAmount },
          holdings: nextHoldings,
          dtrs: dtrs.map((d) =>
            d.id === dtrId
              ? {
                  ...d,
                  holders: d.holders + (existing ? 0 : 1),
                  tokenPrice: newPrice,
                  // Buys deepen the pool with the USDC that came in, so the curve gets
                  // sturdier (less slippage-prone) as a DTR attracts more buy volume.
                  liquidityUsdc: d.liquidityUsdc + usdcAmount,
                  priceHistory: nextPriceHistory,
                  trades: nextTrades,
                  change24h,
                  change7d,
                }
              : d,
          ),
        });

        return {
          success: true,
          message: `Bought ${netAmount.toFixed(4)} ${dtr.ticker} for ${usdcAmount.toFixed(2)} USDC. New price: ${newPrice.toFixed(4)}.`,
        };
      },

      sellDTRToken: (dtrId, tokenAmount) => {
        const { wallet, holdings, dtrs } = get();
        const dtr = dtrs.find((d) => d.id === dtrId);
        const existing = holdings.find((h) => h.dtrId === dtrId);
        if (!dtr) return { success: false, message: "Reserve not found." };
        if (!wallet.connected)
          return { success: false, message: "Connect a wallet first." };
        if (tokenAmount <= 0)
          return { success: false, message: "Enter an amount greater than 0." };
        if (!existing || tokenAmount > existing.tokenBalance)
          return { success: false, message: "Insufficient Reserve Token balance." };

        const { netAmount, newPrice } = calcUsdcReceived(
          tokenAmount,
          dtr.tokenPrice,
          dtr.liquidityUsdc,
          dtr.feeConfig.managerSellTaxPct,
        );
        const remainingBalance = existing.tokenBalance - tokenAmount;
        const closedOut = remainingBalance <= 1e-9;

        const nextHoldings: Holding[] = closedOut
          ? holdings.filter((h) => h.dtrId !== dtrId)
          : holdings.map((h) =>
              h.dtrId === dtrId ? { ...h, tokenBalance: remainingBalance } : h,
            );

        const now = Date.now();
        const nextPriceHistory = appendPricePoint(dtr.priceHistory, newPrice, now);
        const { change24h, change7d } = calcRecentChanges(nextPriceHistory, newPrice);
        // Sells drain USDC out of the pool, so the curve gets thinner (more
        // slippage-prone) -- floored so it never fully dries out.
        const nextLiquidity = Math.max(MIN_LIQUIDITY_FLOOR, dtr.liquidityUsdc - netAmount);
        const trade: Trade = {
          id: `${dtrId}-${now}-${Math.random().toString(36).slice(2, 9)}`,
          t: nextPriceHistory[nextPriceHistory.length - 1].t,
          side: "sell",
          price: newPrice,
          tokenAmount,
          usdcAmount: netAmount,
        };
        const nextTrades = [...dtr.trades, trade].slice(-MAX_TRADES);

        set({
          wallet: { ...wallet, usdc: wallet.usdc + netAmount },
          holdings: nextHoldings,
          dtrs: dtrs.map((d) =>
            d.id === dtrId
              ? {
                  ...d,
                  holders: Math.max(0, d.holders - (closedOut ? 1 : 0)),
                  tokenPrice: newPrice,
                  liquidityUsdc: nextLiquidity,
                  priceHistory: nextPriceHistory,
                  trades: nextTrades,
                  change24h,
                  change7d,
                }
              : d,
          ),
        });

        return {
          success: true,
          message: `Sold ${tokenAmount.toFixed(4)} ${dtr.ticker} for ${netAmount.toFixed(2)} USDC. New price: ${newPrice.toFixed(4)}.`,
        };
      },

      resetSimulation: () => {
        const { wallet, dtrs } = get();
        set({
          // `sol` is a real, live-mirrored chain balance (see WalletSync) --
          // resetting the simulation can't and shouldn't touch it.
          wallet: wallet.connected
            ? { ...wallet, usdc: STARTING_BALANCES.usdc, ssr: STARTING_BALANCES.ssr }
            : initialWallet,
          holdings: [],
          // Real, on-chain-backed DTRs (fixtures + any user-created real
          // Reserves) reflect actual DevNet state -- "resetting the
          // simulation" can't undo a real blockchain, so only the fully
          // mocked seed DTRs go back to their defaults.
          dtrs: [...SEED_DTRS, ...dtrs.filter((d) => d.onChain)],
        });
      },

      createDTR: (input) => {
        const { wallet, dtrs } = get();
        if (!wallet.connected || !wallet.address)
          return { success: false, message: "Connect a wallet to deploy a Reserve." };
        if (!input.name.trim() || !input.ticker.trim())
          return { success: false, message: "Name and ticker are required." };
        if (input.ticker.trim().length > TICKER_MAX_LENGTH)
          return { success: false, message: `Ticker must be ${TICKER_MAX_LENGTH} characters or fewer.` };

        const id = slugify(input.ticker) || slugify(input.name);
        if (!id) return { success: false, message: "Enter a valid ticker." };
        if (dtrs.some((d) => d.id === id))
          return { success: false, message: `A Reserve with ticker ${input.ticker.toUpperCase()} already exists.` };
        if (input.composition.length === 0)
          return { success: false, message: "Select at least one asset for the basket." };

        const assignedTotal = input.composition.reduce((s, a) => s + a.weight, 0);
        if (assignedTotal > 1 + 1e-6)
          return { success: false, message: "Assigned weights cannot exceed 100%." };
        if (input.initialSeedUsdc <= 0)
          return { success: false, message: "Enter an initial seed amount." };
        if (input.initialSeedUsdc > wallet.usdc)
          return { success: false, message: "Insufficient USDC to seed this Reserve." };

        const feeRecipients = (input.feeRecipients || []).filter((r) => r.address.trim() && r.pct > 0);
        const feeRecipientTotal = feeRecipients.reduce((sum, r) => sum + r.pct, 0);
        if (feeRecipientTotal > 100 + 1e-6)
          return { success: false, message: "Fee recipient percentages cannot exceed 100% of total fees." };

        const nav = 10; // deterministic initial NAV per share
        const now = Date.now();
        // A freshly deployed Reserve has no trading history yet -- a single flat
        // point at NAV, not an invented multi-point series.
        const initialPriceHistory: PricePoint[] = [{ t: now, price: nav }];

        const newDtr: DTR = {
          id,
          name: input.name.trim(),
          ticker: input.ticker.trim().toUpperCase(),
          description: input.description.trim(),
          category: input.category.trim() || "Custom",
          tags: input.tags,
          logoSeed: id,
          logoUrl: pickLogoForId(id),
          dtrAddress: generateFictionalAddress(),
          managerAddress: wallet.address,
          delegates: Array.from(
            new Set(
              (input.additionalManagers || [])
                .map((a) => a.trim())
                .filter((a) => a && a !== wallet.address),
            ),
          ).map((address) => ({
            address,
            // Additional managers added at deploy time get full operational control,
            // short of managing other delegates -- only the root Manager can do that.
            permissions: { manageDelegates: false, rebalance: true, feeAdmin: true, pause: true, metadata: true },
            addedAt: now,
          })),
          feeConfig: {
            mintFeePct: input.mintFeePct,
            tvlFeePct: input.tvlFeePct,
            managerBuyTaxPct: input.managerBuyTaxPct,
            managerSellTaxPct: input.managerSellTaxPct,
            creatorFeeDestination: input.creatorFeeDestination || wallet.address,
            feeRecipients,
          },
          tokenPrice: nav,
          nav,
          aum: input.initialSeedUsdc,
          liquidityUsdc: Math.max(
            DEFAULT_NEW_DTR_LIQUIDITY_USDC,
            initialLiquidityForAum(input.initialSeedUsdc),
          ),
          change24h: 0,
          change7d: 0,
          holders: 1,
          composition: input.composition.map((a) => ({ symbol: a.symbol, name: a.name, weight: a.weight })),
          unallocatedPct: Math.max(0, 1 - assignedTotal),
          isUserCreated: true,
          priceHistory: initialPriceHistory,
          trades: [],
        };

        set({
          dtrs: [...dtrs, newDtr],
          wallet: { ...wallet, usdc: wallet.usdc - input.initialSeedUsdc },
          holdings: [
            ...get().holdings,
            { dtrId: id, tokenBalance: input.initialSeedUsdc / nav, avgPurchasePrice: nav },
          ],
        });

        return { success: true, message: `${newDtr.ticker} deployed. You are the root Reserve Manager.`, dtrId: id };
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
      version: 4,
      // Backfill fields added after a user's simulation state was already
      // persisted to localStorage -- e.g. DTRs created before the logo-art
      // pool, the AMM liquidity economy, the buy/sell tax split, the
      // percent-based fee settings, or the flat price-history + trade-log
      // shape existed. Without this, "historic" self-created DTRs would keep
      // showing letter-initial avatars, NaN pricing, stale bps-shaped fee
      // configs, or a chart that can't be re-timeframed, forever.
      migrate: (persisted) => {
        const state = persisted as { dtrs?: DTR[]; profiles?: Record<string, UserProfile> };
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
          state.dtrs = [...SEED_DTRS, ...REAL_PLACEHOLDER_DTRS];
        }
        return state as AppState;
      },
    },
  ),
);

export function emptyDelegatePermissions(): ManagerPermissions {
  return emptyPermissions();
}
