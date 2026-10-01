// Signer identity guards (2026-09-11 QA, DEC-0200).
//
// A tester created a Reserve with Solflare connected, then Rebalance opened
// PHANTOM and failed. Every signing path in this app already threads the SAME
// `WalletContextState` from `useWallet()` down as a plain parameter and calls
// `wallet.signTransaction` on it -- there is no `window.solana`/`isPhantom`
// access anywhere in the repo, and rebalance is not special (it shares
// managementClient.ts's `signAndSend` with every other management action). So
// the mismatch, if it is real, happens INSIDE wallet-adapter's Wallet-Standard
// resolution, below our code, where we cannot fix it directly.
//
// What we CAN do is refuse to be silent about it. These guards turn an
// invisible wrong-wallet event into a named, actionable error, and give a
// reproduction a hard artifact instead of a screenshot:
//
//   preflight  -- before building anything, assert a usable, connected signer
//                 and (when the caller knows it) that it is still the SAME
//                 account the page was acting for. Catches a wallet swapped
//                 or reconnected mid-flow, which would otherwise sign with a
//                 stale signer.
//   postSign   -- after the wallet returns, assert the transaction actually
//                 carries a signature FROM the connected public key. If some
//                 other provider signed, this is where it is caught, with the
//                 expected and actual keys both named.
//
// Neither guard can move funds or change behaviour on the happy path; they
// only throw earlier and more honestly on a path that was already broken.
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

/** The wallet's own name when the adapter exposes one ("Solflare", "Phantom"), else a neutral label. */
export function connectedWalletLabel(wallet: Pick<WalletContextState, "wallet">): string {
  const name = wallet.wallet?.adapter?.name;
  return typeof name === "string" && name.length > 0 ? name : "the connected wallet";
}

export class SignerMismatchError extends Error {
  readonly expected: string;
  readonly actual: string | null;
  constructor(message: string, expected: string, actual: string | null) {
    super(message);
    this.name = "SignerMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface PreflightParams {
  wallet: WalletContextState;
  /**
   * The account the caller already built its plan for (balances read, entitlements
   * computed). When given and it no longer matches the connected key, the
   * flow is aborted rather than signed by whoever is connected now.
   */
  expectedOwner?: PublicKey | string | null;
  /** What the user asked for, for the error text ("rebalance", "sale", "purchase"). */
  action: string;
}

/**
 * Asserts there is a usable signer and that it is still the expected account.
 * Throws an actionable, wallet-named error instead of letting a transaction be
 * built against a signer that is missing, disconnected, or no longer the one
 * the flow started with.
 */
export function assertSignerReady(p: PreflightParams): PublicKey {
  const label = connectedWalletLabel(p.wallet);
  if (!p.wallet.connected || !p.wallet.publicKey) {
    throw new Error(`No wallet is connected, so this ${p.action} was not built. Connect a wallet and try again -- nothing was submitted.`);
  }
  if (typeof p.wallet.signTransaction !== "function") {
    throw new Error(`${label} cannot sign transactions in this browser, so this ${p.action} was not built. Connect a wallet that supports transaction signing -- nothing was submitted.`);
  }
  const connected = p.wallet.publicKey;
  if (p.expectedOwner) {
    const expected = typeof p.expectedOwner === "string" ? p.expectedOwner : p.expectedOwner.toBase58();
    if (expected !== connected.toBase58()) {
      throw new SignerMismatchError(
        `This ${p.action} was prepared for ${expected} but ${label} is now connected as ${connected.toBase58()}. Nothing was submitted. Reconnect the original account, or start the ${p.action} again with this one.`,
        expected,
        connected.toBase58(),
      );
    }
  }
  return connected;
}

/** True when `tx` carries a non-empty signature attributable to `signer`. */
export function hasSignatureFrom(tx: Transaction | VersionedTransaction, signer: PublicKey): boolean {
  // Legacy Transaction: signatures are {publicKey, signature} pairs.
  const legacy = tx as Transaction;
  if (Array.isArray(legacy.signatures) && legacy.signatures.length > 0 && typeof (legacy.signatures[0] as { publicKey?: unknown })?.publicKey !== "undefined") {
    return legacy.signatures.some((s) => {
      const pair = s as { publicKey?: PublicKey; signature?: Uint8Array | null };
      return Boolean(pair.signature) && Boolean(pair.publicKey?.equals(signer));
    });
  }
  // VersionedTransaction: signatures are positional against the message's
  // static account keys, the signer keys first.
  const versioned = tx as VersionedTransaction;
  const keys = versioned.message?.staticAccountKeys;
  if (!Array.isArray(keys) || !Array.isArray(versioned.signatures)) return false;
  const index = keys.findIndex((k) => k.equals(signer));
  if (index < 0 || index >= versioned.signatures.length) return false;
  const sig = versioned.signatures[index];
  return Boolean(sig) && sig.some((b) => b !== 0);
}

/**
 * Asserts the wallet returned a transaction genuinely signed by the connected
 * key. This is the guard that catches "a different wallet signed it": on a
 * mismatch it names the wallet, the key we expected, and the fact that nothing
 * was submitted.
 *
 * Applied per transaction; `label` distinguishes them in a multi-transaction
 * flow ("the mint", "swap 2 of 5").
 */
export function assertSignedBy(
  signed: Transaction | VersionedTransaction,
  signer: PublicKey,
  wallet: Pick<WalletContextState, "wallet">,
  label: string,
): void {
  if (hasSignatureFrom(signed, signer)) return;
  throw new SignerMismatchError(
    `${connectedWalletLabel(wallet)} returned ${label} without a signature from the connected account ${signer.toBase58()}. This usually means a different wallet extension answered the signing request. Nothing was submitted. Disconnect, reconnect the wallet you intend to use, and try again.`,
    signer.toBase58(),
    null,
  );
}

/** Same assertion across a batch from `signAllTransactions`. */
export function assertAllSignedBy(
  signedTxs: (Transaction | VersionedTransaction)[],
  signer: PublicKey,
  wallet: Pick<WalletContextState, "wallet">,
  labelFor: (index: number) => string = (i) => `transaction ${i + 1}`,
): void {
  signedTxs.forEach((tx, i) => assertSignedBy(tx, signer, wallet, labelFor(i)));
}
