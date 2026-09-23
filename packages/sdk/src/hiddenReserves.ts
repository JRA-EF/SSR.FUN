// Explicit, address-keyed registry of on-chain Reserves that are excluded
// from every user-facing surface (Discover, Featured Reserves, KPI counts,
// Portfolio, ManageDTR) despite genuinely existing on-chain -- because they
// never reached a real, tradeable state and genuine on-chain closure isn't
// currently possible for them (see each entry's note). This is the
// "supported registry mechanism" referenced in docs/project/PROJECT_STATUS.md's
// corrective pass for hiding a specific abandoned test Reserve: a small,
// explicit, address-verified list, not a structural heuristic -- so it can
// NEVER accidentally match a different, legitimately in-progress Reserve
// that happens to share the same lifecycle status.
//
// Entries here are added only after directly confirming the exact on-chain
// address via a live, read-only discovery lookup (see
// scripts/find_reserve_by_ticker.ts) -- never by name/ticker string alone,
// since two different Reserves can share a ticker (as several already do on
// this DevNet deployment).
export const HIDDEN_RESERVE_ADDRESSES: ReadonlySet<string> = new Set([
  // reserveId 18, ticker "EGAYQQ", name "ozeegay" -- status
  // "assetsInitializing" with reserveTokenSupplyRaw "0": an abandoned
  // Create-a-Reserve attempt whose single registered asset (wrapped SOL)
  // was never seeded, so it never reached Active and holds zero real value.
  // Confirmed via live discovery (2026-07-31). Genuine on-chain closure is
  // not currently possible: initiate_wind_down/close_reserve both require
  // the Reserve's own manager signature (has_one = manager, no admin
  // override) and initiate_wind_down additionally requires status ==
  // Active, which this Reserve never reached -- the same invariant
  // documented for reserveId 12's zero-asset exclusion (DEC-0058). No
  // keypair available in this environment matches this Reserve's manager
  // (6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen) either.
  "GNAvLuTNmccXx5bSAVQeqPSncay7kBNjjHZFKFvKUbo2",
  // Mainnet reserveId 0 -- the DEC-0115 deployment smoke-test Reserve
  // (9KkRx62F...): USDC-only, 0.9015 USDC seeded from the Creator wallet on
  // deployment day purely to prove create/register/seed/mint/redeem worked
  // on Mainnet. It has no Reserve metadata (its metadata_uri points at a
  // JSON file on the old strategic-super-reserve.fun host that no longer
  // exists), so every surface rendered it as "Unnamed Reserve (#0) / RSV0".
  // Hidden at the Creator's request (2026-09-23) rather than wound down
  // on-chain: it is Active and its manager IS the Creator wallet, so a
  // genuine initiate_wind_down/close_reserve remains possible later.
  // Address confirmed from the live Mainnet warm snapshot (reserveId "0",
  // reserveTokenMint H1pBENeKt92iVTviuS2ztnaTDi5icGcA2F5ny8BUxKjT).
  "9KkRx62FwvXvzYZeWqpBdLvokdPjdfqYMZ6vawUFvf4i",
]);

export function isHiddenReserveAddress(reserveAddress: string): boolean {
  return HIDDEN_RESERVE_ADDRESSES.has(reserveAddress);
}
