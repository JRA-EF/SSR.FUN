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
import type { Address, EIP1193Provider, WalletClient } from "viem";

export interface EvmProviderChoice {
  uuid: string;
  name: string;
  icon?: string;
  rdns: string;
  provider: EIP1193Provider;
}

/**
 * Every injected EVM wallet, via EIP-6963.
 *
 * `window.ethereum` is a single slot that multiple extensions race to claim,
 * so with Phantom AND MetaMask (AND others) installed, "connect" hits whichever
 * won that race -- which is why connecting took several tries and several
 * approaches. EIP-6963 has each wallet announce itself instead, so the person
 * picks. Falls back to window.ethereum for a wallet that does not announce.
 */
export function discoverEvmProviders(waitMs = 120): Promise<EvmProviderChoice[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve([]);
    const found = new Map<string, EvmProviderChoice>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as { info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: EIP1193Provider };
      if (d?.info?.uuid && d.provider) {
        found.set(d.info.uuid, { uuid: d.info.uuid, name: d.info.name ?? "Wallet", icon: d.info.icon, rdns: d.info.rdns ?? "", provider: d.provider });
      }
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()];
      const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
      if (list.length === 0 && legacy) list.push({ uuid: "injected", name: "Browser wallet", rdns: "", provider: legacy });
      resolve(list);
    }, waitMs);
  });
}

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

export async function connectEvmWallet(choice?: EvmProviderChoice): Promise<void> {
  // A wallet prompt the user ignores never settles, so a stale "connecting"
  // must not disable the control forever.
  if (state.connecting && Date.now() - connectStartedAt < CONNECT_STUCK_MS) return;
  connectStartedAt = Date.now();
  set({ connecting: true });
  try {
    const [{ ROBINHOOD }, { connectWallet }] = await Promise.all([import("@/lib/evmChain"), import("@/lib/evmReserve")]);
    // With no explicit choice, use the only announced wallet; if several are
    // installed the caller should have asked first (see EvmWalletChip).
    const provider = choice?.provider ?? (await discoverEvmProviders()).find(Boolean)?.provider;
    const { wallet, account } = await connectWallet(ROBINHOOD, provider);
    set({ wallet, account });
    if (!listening) {
      listening = true;
      // A wallet can switch account or network under us; never keep acting on
      // a stale one -- drop the connection and let the user reconnect.
      const reset = () => set({ wallet: null, account: null });
      const p = provider as unknown as { on?: (e: string, f: () => void) => void } | undefined;
      p?.on?.("accountsChanged", reset);
      p?.on?.("chainChanged", reset);
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
