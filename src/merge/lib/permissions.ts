// Pure DTR-permission decision logic, split out of useAppStore.ts on purpose
// (see createReserveResume.ts's precedent in this same repo for why): this
// file has zero dependency on zustand/persist, so it's directly offline-
// testable (tests/phase_road_to_mainnet_feedback.ts) without hitting the
// ESM/CJS resolution failure importing the full store module causes under
// this repo's ts-mocha harness. Re-exported from useAppStore.ts so every
// existing `import { isManagerOrDelegate } from "@/store/useAppStore"` call
// site keeps working unchanged.
import type { DTR } from "./types";

/**
 * Root Manager plus any delegate at all may open the manager dashboard.
 * Checks BOTH the local/simulated `delegates` array (the non-onchain
 * sandbox path) AND `onChain.delegatesOnChain` (real, live-verified
 * delegate grants -- see discoverDelegatesForReserve). A real Reserve's
 * `delegates` array is always empty (never populated from an on-chain
 * grant), so checking only the former was the confirmed root cause of a
 * genuinely-granted on-chain delegate never seeing the Reserve on their own
 * manager dashboard -- this was never reflected here at all.
 */
export function isManagerOrDelegate(dtr: DTR, address: string | null): boolean {
  if (!address) return false;
  return (
    dtr.managerAddress === address ||
    dtr.delegates.some((d) => d.address === address) ||
    (dtr.onChain?.delegatesOnChain ?? []).some((d) => d.wallet === address)
  );
}

/** Root Manager and every wallet with `manageDelegates` may edit delegates (local/simulated Reserves only -- a real on-chain Reserve's delegate tab is separately gated by hasOnChainPermission). */
export function canManageDelegates(dtr: DTR, address: string | null): boolean {
  if (!address) return false;
  if (dtr.managerAddress === address) return true;
  return dtr.delegates.some((d) => d.address === address && d.permissions.manageDelegates);
}

/** Root Manager and every wallet with `rebalance` may propose/execute a rebalance (local/simulated Reserves only -- a real on-chain Reserve's rebalance tab is separately gated by hasOnChainPermission/canUpdateTargetsOnChain). */
export function canRebalance(dtr: DTR, address: string | null): boolean {
  if (!address) return false;
  if (dtr.managerAddress === address) return true;
  return dtr.delegates.some((d) => d.address === address && d.permissions.rebalance);
}
