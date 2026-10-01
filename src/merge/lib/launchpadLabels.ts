// User-facing wording and the picker filter for launchpad provenance
// (src/merge/pages/CreateDTR.tsx). Pure, so tests can cover the filter
// without React. The provenance itself comes from the catalogue
// (api/ledger/asset-catalogue.ts <- lib/ledger/launchpadClassification.ts),
// which verified it on-chain; nothing here decides eligibility.
import { LAUNCHPAD_LABELS, LAUNCHPAD_VENUE_LABELS, SUPPORTED_LAUNCHPADS, type LaunchpadId, type LaunchpadStage, type LaunchpadVenue } from "@ssr/sdk";

export interface LaunchpadInfoLike {
  id: LaunchpadId;
  stage: LaunchpadStage;
  venue: LaunchpadVenue | null;
}

export type LaunchpadFilter = "all" | LaunchpadId | "none";

export const LAUNCHPAD_FILTER_OPTIONS: ReadonlyArray<{ value: LaunchpadFilter; label: string }> = [
  { value: "all", label: "Any origin" },
  ...SUPPORTED_LAUNCHPADS.map((id) => ({ value: id as LaunchpadFilter, label: LAUNCHPAD_LABELS[id].name })),
  { value: "none", label: "Not from a launchpad" },
];

/** "Pump.fun · PumpSwap" for a graduated token, "Pump.fun · bonding" while on the curve, "Pump.fun · graduated" when the venue could not be located. */
export function launchpadBadgeText(info: LaunchpadInfoLike): string {
  const name = LAUNCHPAD_LABELS[info.id].name;
  if (info.stage === "bonding") return `${name} · bonding`;
  return `${name} · ${info.venue ? LAUNCHPAD_VENUE_LABELS[info.venue] : "graduated"}`;
}

export function matchesLaunchpadFilter(info: LaunchpadInfoLike | null, filter: LaunchpadFilter): boolean {
  if (filter === "all") return true;
  if (filter === "none") return info === null;
  return info !== null && info.id === filter;
}
