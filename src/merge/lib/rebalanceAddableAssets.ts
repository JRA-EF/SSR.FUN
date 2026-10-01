// The Manager Dashboard's Rebalance tab "Add a Reserve Asset" list
// (src/merge/pages/ManageDTR.tsx): which assets a Manager may still add to
// the proposed composition, and the one honest empty-state when there are
// none. Pure, so tests cover it without React. The list itself comes from
// the same source as Create Reserve's picker -- the live Mainnet catalogue
// (useMainnetAssetCatalogue) or the DevNet fixtures -- and the search and
// asset-type rules are the same modules that page uses (assetSearch.ts,
// issuerLabels.ts), so the two pickers can never disagree about what is
// offered or how it is found.
import type { TokenIssuerId } from "@ssr/sdk";
import { matchesAssetSearch } from "./assetSearch";
import { matchesIssuerFilter, type IssuerFilter } from "./issuerLabels";

export interface AddableAsset {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  /** Who issued this tokenised asset (xStocks), or null -- the badge and the "Asset type" filter, never eligibility. */
  issuer?: TokenIssuerId | null;
}

export type AddableEmptyState =
  /** Nothing left to add: every offered asset is already in the proposal. */
  | "all-added"
  /** Something is left, but nothing matches the typed search. */
  | "no-match"
  /** Something matches the search, but nothing of the chosen asset type. */
  | "none-for-type"
  | null;

export interface AddableAssetList {
  assets: AddableAsset[];
  emptyState: AddableEmptyState;
}

/**
 * Pure. Assets not already in the proposal, narrowed by the search and the
 * asset-type filter, in the catalogue's own order (organic score, the same
 * order Create Reserve shows). `emptyState` names the FIRST reason the list
 * is empty so the page can say something true and specific rather than the
 * old catch-all "every supported asset is already in your proposed
 * composition", which was also shown when the list had simply been
 * hard-coded empty.
 */
export function addableAssetsForRebalance(
  offered: AddableAsset[],
  proposedMints: Iterable<string>,
  query: string,
  issuerFilter: IssuerFilter,
): AddableAssetList {
  const inProposal = new Set(proposedMints);
  const remaining = offered.filter((a) => !inProposal.has(a.mint));
  if (remaining.length === 0) return { assets: [], emptyState: "all-added" };
  const searched = remaining.filter((a) => matchesAssetSearch(a, query));
  if (searched.length === 0) return { assets: [], emptyState: "no-match" };
  const assets = searched.filter((a) => matchesIssuerFilter(a.issuer ?? null, issuerFilter));
  if (assets.length === 0) return { assets: [], emptyState: "none-for-type" };
  return { assets, emptyState: null };
}
