// Decodes the raw on-chain delegate permission bitmask (see
// programs/ssr_protocol/src/state/delegate.rs's `permission_flags` module)
// into human-readable capability labels for display. This is a read-only
// mirror of the Rust bit values -- it must be kept in sync with that file if
// the flags ever change; it grants nothing on its own.

/** Named mirror of programs/ssr_protocol/src/state/delegate.rs's permission_flags module, so callers can gate by name instead of a magic bit literal. */
export const PERMISSION_FLAGS = {
  UPDATE_METADATA: 1 << 0,
  UPDATE_TARGETS: 1 << 1,
  INITIATE_REBALANCE: 1 << 2,
  EXECUTE_REBALANCE: 1 << 3,
  MANAGE_FEES: 1 << 4,
  MANAGE_LIQUIDITY_CONFIG: 1 << 5,
  PAUSE_RESERVE: 1 << 6,
  UNPAUSE_RESERVE: 1 << 7,
  ADD_RESTRICTED_DELEGATE: 1 << 8,
  REMOVE_RESTRICTED_DELEGATE: 1 << 9,
} as const;

export const ON_CHAIN_PERMISSION_FLAGS: { bit: number; label: string }[] = [
  { bit: 1 << 0, label: "Update Metadata" },
  { bit: 1 << 1, label: "Update Targets" },
  { bit: 1 << 2, label: "Initiate Rebalance" },
  { bit: 1 << 3, label: "Execute Rebalance" },
  { bit: 1 << 4, label: "Manage Fees" },
  { bit: 1 << 5, label: "Manage Liquidity Config" },
  { bit: 1 << 6, label: "Pause Reserve" },
  { bit: 1 << 7, label: "Unpause Reserve" },
  { bit: 1 << 8, label: "Add Restricted Co-Manager" },
  { bit: 1 << 9, label: "Remove Restricted Co-Manager" },
];

/** Human-readable capability labels granted by a raw on-chain permissions bitmask. */
export function decodeOnChainPermissions(bitmask: number): string[] {
  return ON_CHAIN_PERMISSION_FLAGS.filter((f) => (bitmask & f.bit) !== 0).map((f) => f.label);
}

/**
 * Whether `wallet` may exercise `flag` on this Reserve's real on-chain state
 * -- the root manager always can; otherwise looks up a matching entry in
 * `dtr.onChain.delegatesOnChain` (see onChainReserve.ts's
 * discoverDelegatesForReserve). Deliberately fails CLOSED, not just "no
 * delegates found": that read only resolves delegates from a
 * candidate-wallet hint list (no getProgramAccounts on the public RPC -- see
 * packages/sdk/src/discovery.ts's documented limitation), so a real
 * on-chain delegate this app simply hasn't resolved yet must read as "no
 * permission" rather than being silently treated as equivalent to "not a
 * delegate at all." Callers should disclose that possibility in the UI
 * rather than implying a definitive "no delegates."
 *
 * Only meaningful for a genuinely on-chain Reserve (`dtr.onChain` present)
 * -- a purely local/simulated Reserve has no real Delegate PDAs to check
 * against and should keep using the existing local simulated-permission
 * checks in useAppStore.ts instead.
 */
export function hasOnChainPermission(
  onChain: { manager: string; delegatesOnChain?: { wallet: string; permissions: number }[] } | undefined,
  wallet: string | null,
  flag: number,
): boolean {
  if (!wallet || !onChain) return false;
  if (onChain.manager === wallet) return true;
  const delegate = onChain.delegatesOnChain?.find((d) => d.wallet === wallet);
  if (!delegate) return false;
  return (delegate.permissions & flag) !== 0;
}
