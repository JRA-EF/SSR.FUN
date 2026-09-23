// The connected EVM wallet, shared by every Robinhood surface: the header
// chip, the Create form, Portfolio and the reserve page. Connecting once is
// enough everywhere.
//
// Deliberately viem-free at import time -- the Shell header imports this, and
// the Shell is in the main bundle. The EVM stack is dynamic-imported only when
// someone actually connects, so the Solana app never pays for it.
//
// Separate from the Solana wallet adapter on purpose: different chains,
// different wallets, and a user may well connect one and not the other.
import { useSyncExternalStore } from "react";
import type { Address, WalletClient } from "viem";

export interface EvmWalletState {
  wallet: WalletClient | null;
  account: Address | null;
  connecting: boolean;
}

let state: EvmWalletState = { wallet: null, account: null, connecting: false };
/** When the in-flight attempt started, so a prompt the user never answers cannot wedge the button. */
let connectStartedAt = 0;
const CONNECT_STUCK_MS = 60_000;
const listeners = new Set<() => void>();
let listening = false;

function set(next: Partial<EvmWalletState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export async function connectEvmWallet(): Promise<void> {
  // A wallet prompt the user ignores never settles, so a stale "connecting"
  // must not disable the control forever.
  if (state.connecting && Date.now() - connectStartedAt < CONNECT_STUCK_MS) return;
  connectStartedAt = Date.now();
  set({ connecting: true });
  try {
    const [{ ROBINHOOD }, { connectWallet }] = await Promise.all([import("@/lib/evmChain"), import("@/lib/evmReserve")]);
    const { wallet, account } = await connectWallet(ROBINHOOD);
    set({ wallet, account });
    if (!listening) {
      listening = true;
      const provider = (window as unknown as { ethereum?: { on?: (e: string, f: () => void) => void } }).ethereum;
      // A wallet can switch account or network under us; never keep acting on
      // a stale one -- drop the connection and let the user reconnect.
      const reset = () => set({ wallet: null, account: null });
      provider?.on?.("accountsChanged", reset);
      provider?.on?.("chainChanged", reset);
    }
  } finally {
    set({ connecting: false });
  }
}

export function disconnectEvmWallet() {
  set({ wallet: null, account: null });
}

/** True when the browser has any injected EVM wallet at all. */
export function hasInjectedEvmWallet(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;
}

export function useEvmWallet(): EvmWalletState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
