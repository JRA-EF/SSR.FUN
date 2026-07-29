// Off-chain local labels for delegates -- see
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md item 6/11 for the
// confirmed decision this implements: a delegate's human-readable name is
// NEVER on-chain data (the deployed Delegate account has no name field, see
// programs/ssr_protocol/src/state/delegate.rs, and this file must never
// pretend otherwise). It's purely a local, per-browser convenience label
// keyed by (reserve, delegate wallet), stored in its own localStorage key --
// deliberately separate from useAppStore's simulation state, since a label
// is metadata about a REAL on-chain delegate, not simulation data.
//
// KNOWN LIMITATION, by design (confirmed acceptable for this DevNet
// version): labels do not follow a user across browsers or devices. A
// delegate lacking a locally-stored label must always fall back cleanly to
// its shortened wallet address -- never a blank, an error, or a fabricated
// name -- and delegate functionality (grants, revocation, permission
// checks) must never depend on a label being present.

const STORAGE_KEY = "ssrfun-delegate-labels";

type LabelStore = Record<string, string>; // `${reserve}:${wallet}` -> label

function readStore(): LabelStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as LabelStore) : {};
  } catch {
    // Corrupt or inaccessible storage -- fail honest-empty, never throw into the UI.
    return {};
  }
}

function writeStore(store: LabelStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable/full -- the label simply won't persist; callers
    // already treat "no label" as a normal, fully-supported state.
  }
}

function key(reserve: string, wallet: string): string {
  return `${reserve}:${wallet}`;
}

/** Returns the local label for this (reserve, wallet), or null if none is set on this browser. */
export function getDelegateLabel(reserve: string, wallet: string): string | null {
  const store = readStore();
  const label = store[key(reserve, wallet)];
  return label && label.trim() ? label : null;
}

/** Sets (or clears, if label is empty) the local label for this (reserve, wallet). */
export function setDelegateLabel(reserve: string, wallet: string, label: string): void {
  const store = readStore();
  const trimmed = label.trim();
  if (trimmed) {
    store[key(reserve, wallet)] = trimmed;
  } else {
    delete store[key(reserve, wallet)];
  }
  writeStore(store);
}

/** Shortens a base58 wallet/account address for display -- the universal fallback when no local label exists. */
export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** The display name to show for a delegate: its local label if set, otherwise a shortened address -- never blank, never fabricated. */
export function displayDelegateName(reserve: string, wallet: string): string {
  return getDelegateLabel(reserve, wallet) ?? shortenAddress(wallet);
}
