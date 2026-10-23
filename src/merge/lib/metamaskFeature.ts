// Whether this build offers MetaMask as a Solana wallet.
//
// MetaMask registers a Solana wallet through the Wallet Standard and connects
// through wallet-adapter like the others (2026-10-21), but it needs more work
// before ordinary visitors use it, so production holds it back. Rather than
// delete working code, it hides behind one switch -- the same mechanism as
// EVM_ENABLED (src/merge/lib/evmFeature.ts).
//
// Off unless VITE_ENABLE_METAMASK=true at BUILD time; the value is inlined,
// so changing it on a running deployment does nothing until a rebuild.
//
// What it gates:
//   WalletModal.tsx      the MetaMask tile in the Solana wallet picker
//   SolanaProviders.tsx  autoConnect of a returning visitor's saved MetaMask choice
// The EVM (Robinhood Chain) picker is not gated: it is behind EVM_ENABLED.
export const METAMASK_ENABLED = (import.meta.env.VITE_ENABLE_METAMASK as string | undefined) === "true";

/** wallet-adapter's saved wallet name (SolanaProviders' localStorageKey). */
export const WALLET_NAME_STORAGE_KEY = "ssr.fun:walletName";

/** With MetaMask off, forget a saved MetaMask choice so autoConnect does not reconnect it. */
export function forgetDisabledWalletChoice(): void {
  if (METAMASK_ENABLED) return;
  try {
    const saved = window.localStorage.getItem(WALLET_NAME_STORAGE_KEY);
    if (saved && saved.toLowerCase().includes("metamask")) window.localStorage.removeItem(WALLET_NAME_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing saved, nothing to reconnect.
  }
}
