// Decodes the raw on-chain delegate permission bitmask (see
// programs/ssr_protocol/src/state/delegate.rs's `permission_flags` module)
// into human-readable capability labels for display. This is a read-only
// mirror of the Rust bit values -- it must be kept in sync with that file if
// the flags ever change; it grants nothing on its own.
export const ON_CHAIN_PERMISSION_FLAGS: { bit: number; label: string }[] = [
  { bit: 1 << 0, label: "Update Metadata" },
  { bit: 1 << 1, label: "Update Targets" },
  { bit: 1 << 2, label: "Initiate Rebalance" },
  { bit: 1 << 3, label: "Execute Rebalance" },
  { bit: 1 << 4, label: "Manage Fees" },
  { bit: 1 << 5, label: "Manage Liquidity Config" },
  { bit: 1 << 6, label: "Pause Reserve" },
  { bit: 1 << 7, label: "Unpause Reserve" },
  { bit: 1 << 8, label: "Add Restricted Delegate" },
  { bit: 1 << 9, label: "Remove Restricted Delegate" },
];

/** Human-readable capability labels granted by a raw on-chain permissions bitmask. */
export function decodeOnChainPermissions(bitmask: number): string[] {
  return ON_CHAIN_PERMISSION_FLAGS.filter((f) => (bitmask & f.bit) !== 0).map((f) => f.label);
}
