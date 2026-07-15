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
  WalletProviderId,
  WalletState,
} from "@/lib/types";
import { emptyPermissions } from "@/lib/types";
import { DTRS as SEED_DTRS, pickLogoForId } from "@/lib/seed-data";
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

export interface TradeResult {
  success: boolean;
  message: string;
}

export interface ActionResult extends TradeResult {
  dtrId?: string;
}

interface AppState {
  wallet: WalletState;
  holdings: Holding[];
  dtrs: DTR[];

  connectWallet: (provider: WalletProviderId) => Promise<void>;
  disconnectWallet: () => void;
  addDemoUSDC: () => void;
  buyDTRToken: (dtrId: string, usdcAmount: number) => TradeResult;
  sellDTRToken: (dtrId: string, tokenAmount: number) => TradeResult;
  resetSimulation: () => void;

  createDTR: (input: CreateDTRInput) => ActionResult;
  addDelegate: (dtrId: string, address: string, permissions: ManagerPermissions) => ActionResult;
  updateDelegatePermissions: (dtrId: string, address: string, permissions: ManagerPermissions) => ActionResult;
  removeDelegate: (dtrId: string, address: string) => ActionResult;
  rebalanceDTR: (dtrId: string, edits: Record<string, number>, adjustRemaining: boolean) => ActionResult;
}

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
      dtrs: SEED_DTRS,

      connectWallet: async (provider) => {
        set((state) => ({ wallet: { ...state.wallet, connecting: true } }));
        await new Promise((resolve) => setTimeout(resolve, 1100));
        set({
          wallet: {
            connected: true,
            connecting: false,
            provider,
            address: generateFictionalAddress(),
            usdc: STARTING_BALANCES.usdc,
            ssr: STARTING_BALANCES.ssr,
            sol: STARTING_BALANCES.sol,
          },
        });
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
        if (!dtr) return { success: false, message: "DTR not found." };
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
        if (!dtr) return { success: false, message: "DTR not found." };
        if (!wallet.connected)
          return { success: false, message: "Connect a wallet first." };
        if (tokenAmount <= 0)
          return { success: false, message: "Enter an amount greater than 0." };
        if (!existing || tokenAmount > existing.tokenBalance)
          return { success: false, message: "Insufficient DTR Token balance." };

        const { netAmount, newPrice } = calcUsdcReceived(
          tokenAmount,
          dtr.tokenPrice,
          dtr.liquidityUsdc,
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
        const { wallet } = get();
        set({
          wallet: wallet.connected
            ? {
                ...wallet,
                usdc: STARTING_BALANCES.usdc,
                ssr: STARTING_BALANCES.ssr,
                sol: STARTING_BALANCES.sol,
              }
            : initialWallet,
          holdings: [],
          dtrs: SEED_DTRS,
        });
      },

      createDTR: (input) => {
        const { wallet, dtrs } = get();
        if (!wallet.connected || !wallet.address)
          return { success: false, message: "Connect a wallet to deploy a DTR." };
        if (!input.name.trim() || !input.ticker.trim())
          return { success: false, message: "Name and ticker are required." };
        if (input.ticker.trim().length > TICKER_MAX_LENGTH)
          return { success: false, message: `Ticker must be ${TICKER_MAX_LENGTH} characters or fewer.` };

        const id = slugify(input.ticker) || slugify(input.name);
        if (!id) return { success: false, message: "Enter a valid ticker." };
        if (dtrs.some((d) => d.id === id))
          return { success: false, message: `A DTR with ticker ${input.ticker.toUpperCase()} already exists.` };
        if (input.composition.length === 0)
          return { success: false, message: "Select at least one asset for the basket." };

        const assignedTotal = input.composition.reduce((s, a) => s + a.weight, 0);
        if (assignedTotal > 1 + 1e-6)
          return { success: false, message: "Assigned weights cannot exceed 100%." };
        if (input.initialSeedUsdc <= 0)
          return { success: false, message: "Enter an initial seed amount." };
        if (input.initialSeedUsdc > wallet.usdc)
          return { success: false, message: "Insufficient USDC to seed this DTR." };

        const feeRecipients = (input.feeRecipients || []).filter((r) => r.address.trim() && r.pct > 0);
        const feeRecipientTotal = feeRecipients.reduce((sum, r) => sum + r.pct, 0);
        if (feeRecipientTotal > 100 + 1e-6)
          return { success: false, message: "Fee recipient percentages cannot exceed 100% of total fees." };

        const nav = 10; // deterministic initial NAV per share
        const now = Date.now();
        const flatSeries = (points: number, stepMs: number) =>
          Array.from({ length: points }, (_, i) => ({
            t: now - stepMs * (points - 1 - i),
            price: nav,
          }));

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
            mintFeeBps: input.mintFeeBps,
            tvlFeeBps: input.tvlFeeBps,
            managerTaxBps: input.managerTaxBps,
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
          priceHistory: {
            "24H": flatSeries(24, 60 * 60_000),
            "7D": flatSeries(28, 6 * 60 * 60_000),
            "30D": flatSeries(30, 24 * 60 * 60_000),
            All: flatSeries(12, 7 * 24 * 60 * 60_000),
          },
        };

        set({
          dtrs: [...dtrs, newDtr],
          wallet: { ...wallet, usdc: wallet.usdc - input.initialSeedUsdc },
          holdings: [
            ...get().holdings,
            { dtrId: id, tokenBalance: input.initialSeedUsdc / nav, avgPurchasePrice: nav },
          ],
        });

        return { success: true, message: `${newDtr.ticker} deployed. You are the root DTR Manager.`, dtrId: id };
      },

      addDelegate: (dtrId, address, permissions) => {
        const { dtrs, wallet } = get();
        const dtr = dtrs.find((d) => d.id === dtrId);
        if (!dtr) return { success: false, message: "DTR not found." };
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
        if (!dtr) return { success: false, message: "DTR not found." };
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
        if (!dtr) return { success: false, message: "DTR not found." };
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
        if (!dtr) return { success: false, message: "DTR not found." };
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
    }),
    {
      name: "ssrfun-simulation",
      version: 1,
      // Backfill fields added after a user's simulation state was already
      // persisted to localStorage -- e.g. DTRs created before the logo-art
      // pool or the AMM liquidity economy existed. Without this, "historic"
      // self-created DTRs would keep showing letter-initial avatars and
      // NaN pricing forever, while freshly-created DTRs look fine.
      migrate: (persisted) => {
        const state = persisted as { dtrs?: DTR[] };
        if (state?.dtrs) {
          state.dtrs = state.dtrs.map((d) => ({
            ...d,
            logoSeed: d.logoSeed ?? d.id,
            logoUrl: d.logoUrl ?? pickLogoForId(d.id),
            liquidityUsdc: d.liquidityUsdc ?? initialLiquidityForAum(d.aum ?? 0),
          }));
        }
        return state as AppState;
      },
    },
  ),
);

export function emptyDelegatePermissions(): ManagerPermissions {
  return emptyPermissions();
}
