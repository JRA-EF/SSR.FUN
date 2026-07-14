// Global simulation state for BYOR: fictional wallet, balances, and DTR Token
// holdings. Persisted to localStorage so progress survives a refresh.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Holding, WalletProviderId, WalletState } from "@/lib/types";
import { getDtrById } from "@/lib/seed-data";
import {
  calcAvgPurchasePrice,
  calcTokensReceived,
  calcUsdcReceived,
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

export interface TradeResult {
  success: boolean;
  message: string;
}

interface AppState {
  wallet: WalletState;
  holdings: Holding[];

  connectWallet: (provider: WalletProviderId) => Promise<void>;
  disconnectWallet: () => void;
  addDemoUSDC: () => void;
  buyDTRToken: (dtrId: string, usdcAmount: number) => TradeResult;
  sellDTRToken: (dtrId: string, tokenAmount: number) => TradeResult;
  resetSimulation: () => void;
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

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      wallet: initialWallet,
      holdings: [],

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
        const dtr = getDtrById(dtrId);
        const { wallet, holdings } = get();
        if (!dtr) return { success: false, message: "DTR not found." };
        if (!wallet.connected)
          return { success: false, message: "Connect a wallet first." };
        if (usdcAmount <= 0)
          return { success: false, message: "Enter an amount greater than 0." };
        if (usdcAmount > wallet.usdc)
          return { success: false, message: "Insufficient USDC balance." };

        const { netAmount } = calcTokensReceived(usdcAmount, dtr.tokenPrice);
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

        set({
          wallet: { ...wallet, usdc: wallet.usdc - usdcAmount },
          holdings: nextHoldings,
        });

        return {
          success: true,
          message: `Bought ${netAmount.toFixed(4)} ${dtr.ticker} for ${usdcAmount.toFixed(2)} USDC.`,
        };
      },

      sellDTRToken: (dtrId, tokenAmount) => {
        const dtr = getDtrById(dtrId);
        const { wallet, holdings } = get();
        const existing = holdings.find((h) => h.dtrId === dtrId);
        if (!dtr) return { success: false, message: "DTR not found." };
        if (!wallet.connected)
          return { success: false, message: "Connect a wallet first." };
        if (tokenAmount <= 0)
          return { success: false, message: "Enter an amount greater than 0." };
        if (!existing || tokenAmount > existing.tokenBalance)
          return { success: false, message: "Insufficient DTR Token balance." };

        const { netAmount } = calcUsdcReceived(tokenAmount, dtr.tokenPrice);
        const remainingBalance = existing.tokenBalance - tokenAmount;

        const nextHoldings: Holding[] =
          remainingBalance <= 1e-9
            ? holdings.filter((h) => h.dtrId !== dtrId)
            : holdings.map((h) =>
                h.dtrId === dtrId ? { ...h, tokenBalance: remainingBalance } : h,
              );

        set({
          wallet: { ...wallet, usdc: wallet.usdc + netAmount },
          holdings: nextHoldings,
        });

        return {
          success: true,
          message: `Sold ${tokenAmount.toFixed(4)} ${dtr.ticker} for ${netAmount.toFixed(2)} USDC.`,
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
        });
      },
    }),
    {
      name: "byor-simulation",
    },
  ),
);
