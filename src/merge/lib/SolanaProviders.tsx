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
      {/* localStorageKey is explicit (DEC-0200): wallet-adapter persists the
          chosen wallet's NAME under this key and re-resolves it against the
          Wallet-Standard registry on every mount. Left implicit, the default
          key is shared with any other wallet-adapter app on the same origin,
          and a stale/foreign value is silently re-resolved to whichever
          installed wallet matches first -- the most plausible in-browser
          explanation for the 2026-09-11 "Solflare connected, Phantom opened"
          report, since no code in this repo picks a provider itself. */}
      <WalletProvider wallets={wallets} autoConnect onError={onError} localStorageKey="ssr.fun:walletName">
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
