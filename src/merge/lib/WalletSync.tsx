// Mounted once near the app root (see App.tsx). Bridges the real
// @solana/wallet-adapter-react connection state and live SOL balance into
// useAppStore's `wallet` field, which every existing page (Shell, WalletModal,
// DTRDetail, CreateDTR, Portfolio, Manage) already reads -- so those consumers
// need no shape changes, only their old fake `connectWallet` timeout is gone.
import { useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useAppStore } from "@/store/useAppStore";
import type { WalletProviderId } from "@/lib/types";
import { DEMO_WALLET_ADDRESS, getDemoWalletProvider, isDemoWalletConnected } from "@/lib/designDemo";
import { IS_MAINNET } from "@/lib/solana-config";

const BALANCE_POLL_MS = 20_000;

function normalizeProviderName(name: string | undefined): WalletProviderId | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.includes("phantom")) return "phantom";
  if (lower.includes("solflare")) return "solflare";
  if (lower.includes("backpack")) return "backpack";
  return null;
}

export function WalletSync() {
  const { connection } = useConnection();
  const { publicKey, connected, connecting, wallet } = useWallet();
  const syncWalletFromChain = useAppStore((s) => s.syncWalletFromChain);
  const resetWallet = useAppStore((s) => s.disconnectWallet);

  useEffect(() => {
    if (!connected) {
      // A design-preview simulated connection lives only in the store (the
      // real adapter stays disconnected) -- don't let this mirror wipe it,
      // and re-seed it on a fresh load so the session survives reloads.
      // Never on Mainnet: there the store must only ever mirror the real
      // adapter, even if a stale ?demo=1 flag survives in localStorage.
      if (!IS_MAINNET && isDemoWalletConnected()) {
        syncWalletFromChain({
          connected: true,
          connecting: false,
          address: DEMO_WALLET_ADDRESS,
          provider: (getDemoWalletProvider() ?? "phantom") as WalletProviderId,
          solLamports: 5_000_000_000,
        });
      } else if (!connecting) {
        resetWallet();
      }
      return;
    }
    syncWalletFromChain({
      connected: true,
      connecting: false,
      address: publicKey ? publicKey.toBase58() : null,
      provider: normalizeProviderName(wallet?.adapter.name),
      solLamports: null,
    });
  }, [connected, connecting, publicKey, wallet, syncWalletFromChain, resetWallet]);

  useEffect(() => {
    if (!connected || !publicKey) return;
    let cancelled = false;

    async function refreshBalance() {
      try {
        const lamports = await connection.getBalance(publicKey!, "confirmed");
        if (!cancelled) {
          syncWalletFromChain({
            connected: true,
            connecting: false,
            address: publicKey!.toBase58(),
            provider: normalizeProviderName(wallet?.adapter.name),
            solLamports: lamports,
          });
        }
      } catch {
        // Transient RPC failure (rate limit, etc.) -- keep the last known
        // balance rather than clobbering it with 0; the next poll retries.
      }
    }

    refreshBalance();
    const id = setInterval(refreshBalance, BALANCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected, publicKey, connection, wallet, syncWalletFromChain]);

  return null;
}
