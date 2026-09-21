// The connected EVM wallet, shared by every Robinhood surface (create form,
// reserve page) so connecting once is enough. Separate from the Solana
// wallet adapter on purpose -- they are different wallets on different chains.
import { useSyncExternalStore } from "react";
import type { Address, WalletClient } from "viem";
import { ROBINHOOD } from "@/lib/evmChain";
import { connectWallet } from "@/lib/evmReserve";

interface EvmWallet {
  wallet: WalletClient | null;
  account: Address | null;
}

let state: EvmWallet = { wallet: null, account: null };
const listeners = new Set<() => void>();
let listening = false;

export async function connectEvmWallet() {
  const { wallet, account } = await connectWallet(ROBINHOOD);
  state = { wallet, account };
  listeners.forEach((l) => l());
  if (!listening) {
    listening = true;
    const provider = (window as unknown as { ethereum?: { on?: (e: string, f: () => void) => void } }).ethereum;
    // A wallet can switch account or network under us; never keep acting on
    // a stale one -- drop the connection and let the user reconnect.
    const reset = () => {
      state = { wallet: null, account: null };
      listeners.forEach((l) => l());
    };
    provider?.on?.("accountsChanged", reset);
    provider?.on?.("chainChanged", reset);
  }
}

export function useEvmWallet(): EvmWallet {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
