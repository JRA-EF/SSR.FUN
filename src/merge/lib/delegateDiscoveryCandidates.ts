// Builds the candidate-wallet hint list fed to
// packages/sdk/src/discovery.ts's discoverDelegatesForReserve, and the
// local, per-browser registry that keeps it from silently going stale. A
// Delegate account is a PDA seeded by (reserve, wallet) with no on-chain
// reverse index (see programs/ssr_protocol/src/state/delegate.rs), and the
// public DevNet RPC blocks the getProgramAccounts scan that would otherwise
// enumerate them directly -- so a wallet neither hardcoded here nor
// discovered some other way is invisible to every discovery pass forever,
// no matter how many times it's re-run. This was the confirmed root cause
// of a freshly-granted delegate (the overwhelmingly common real case: some
// wallet OTHER than the Root Manager's own connected one) never appearing
// on the Manager Dashboard -- "N delegate(s) reported on-chain, but none
// matched this discovery pass's candidate wallets" -- even immediately
// after granting it, and even after refreshing indefinitely.
//
// The fix: this app already knows a delegate's exact wallet address the
// moment it grants one (typed into ManageDTR.tsx's "Grant a New Delegate"
// form) -- rememberDelegateWallet records that address, locally, the
// instant the grant transaction confirms, so it becomes part of every
// subsequent discovery pass's candidate set on this browser, without
// waiting on luck. This is still only ever a HINT, same as the
// manager/fixture-wallet candidates below: every entry is always
// re-verified against a genuine, decoded on-chain Delegate account (see
// discoverDelegatesForReserve) before ever being displayed or granted any
// permission -- a stale or since-revoked entry here matches nothing and is
// silently dropped, never trusted on its own. The connected wallet's OWN
// delegations are unaffected by any of this and always fully correct
// regardless of registry state, on any browser: buildDelegateCandidateWallets
// always includes it directly, and a PDA lookup for (reserve, that exact
// wallet) is an authoritative direct read, never a guess.
//
// KNOWN LIMITATION, same as delegateLabels.ts's precedent: this registry is
// local to the browser that performed the grant. A delegate wallet granted
// from one browser and first viewed by the Manager from a different one
// still won't be listed there until that delegate wallet itself connects at
// least once (which self-registers it as a candidate for every Reserve it
// visits) or is granted again from that second browser. Delegate
// functionality itself (permission checks, on-chain enforcement) never
// depends on this registry -- only this list's completeness does.
import { PublicKey } from "@solana/web3.js";
import { DEVNET_FIXTURES } from "@ssr/sdk";

const STORAGE_KEY = "ssrfun-known-delegate-wallets";

type Registry = Record<string, string[]>; // reserve address -> wallet[]

function readStore(): Registry {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Registry) : {};
  } catch {
    // Corrupt or inaccessible storage -- fail honest-empty, never throw into the UI.
    return {};
  }
}

function writeStore(store: Registry): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable/full -- the hint simply won't persist; discovery
    // still works via every other candidate source.
  }
}

/** Records `wallet` as worth checking for a delegate grant on `reserve` going forward, on this browser. Call right after a Grant Delegate transaction confirms -- the app already knows this exact address at that moment. */
export function rememberDelegateWallet(reserve: string, wallet: string): void {
  const store = readStore();
  const existing = store[reserve] ?? [];
  if (existing.includes(wallet)) return;
  store[reserve] = [...existing, wallet];
  writeStore(store);
}

/** Drops a wallet from the local hint list -- pure hygiene, never required for correctness: a genuinely revoked Delegate account simply won't be found on-chain either way. Call after a confirmed Remove Delegate. */
export function forgetDelegateWallet(reserve: string, wallet: string): void {
  const store = readStore();
  const existing = store[reserve];
  if (!existing) return;
  const next = existing.filter((w) => w !== wallet);
  if (next.length === existing.length) return;
  store[reserve] = next;
  writeStore(store);
}

/** Every wallet locally known to be worth checking for a delegate grant on `reserve` -- a discovery HINT only, see this file's header. */
export function getKnownDelegateWallets(reserve: string): string[] {
  return readStore()[reserve] ?? [];
}

/**
 * The single, shared candidate-wallet list every delegate-discovery call
 * site (RealReserveSync's background poll, ManageDTR.tsx's/DTRDetail.tsx's
 * manual refresh) must use, so they can never silently diverge. Always
 * includes: the Reserve's manager, the 2 documented DevNet fixture
 * delegates (continuity for the seeded Gate-9 fixtures), every wallet this
 * browser has locally recorded via rememberDelegateWallet for this exact
 * reserve, and -- whenever a wallet is connected -- that wallet itself
 * (a direct, authoritative self-check: the connected delegate wallet always
 * correctly discovers every Reserve it has an active delegation on, on any
 * browser, independent of this registry).
 */
export function buildDelegateCandidateWallets(reserveAddress: string, managerBase58: string, connectedWallet: string | null): PublicKey[] {
  const candidates = new Set([managerBase58, DEVNET_FIXTURES.delegates.updateTargets.wallet, DEVNET_FIXTURES.delegates.pauseUnpause.wallet, ...getKnownDelegateWallets(reserveAddress)]);
  if (connectedWallet) candidates.add(connectedWallet);
  const keys: PublicKey[] = [];
  for (const c of candidates) {
    try {
      keys.push(new PublicKey(c));
    } catch {
      // A malformed locally-stored address (manual localStorage edit, future
      // format change) must never crash discovery -- skip it honestly.
    }
  }
  return keys;
}
