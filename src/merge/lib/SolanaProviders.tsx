import { useCallback, useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { WalletError } from "@solana/wallet-adapter-base";
import { SOLANA_RPC_URL } from "./solana-config";
import { coalescingRpcFetch } from "./clientRpcCache";
import { useAppStore } from "@/store/useAppStore";

/**
 * Real Solana wallet connectivity for the DevNet testing phase. `wallets={[]}`
 * is deliberate -- Phantom, Solflare, and Backpack all register themselves via
 * the Wallet Standard, so wallet-adapter-react auto-detects them without
 * needing their (heavy, hardware-wallet/WalletConnect-pulling) individual
 * adapter packages. `autoConnect` lets a returning user's previously-selected
 * wallet silently reconnect on page load (standard dapp UX), but never
 * connects on its own without the user having explicitly picked a wallet at
 * least once via WalletModal.
 */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  const setWalletError = useAppStore((s) => s.setWalletError);

  const onError = useCallback(
    (error: WalletError) => {
      setWalletError(error.message || "Wallet connection failed.");
    },
    [setWalletError],
  );

  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL} config={{ commitment: "confirmed", fetch: coalescingRpcFetch }}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
