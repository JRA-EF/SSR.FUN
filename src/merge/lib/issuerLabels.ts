// User-facing wording and the picker filter for tokenised-asset issuers
// (src/merge/pages/CreateDTR.tsx). Pure, so tests can cover the filter
// without React. The provenance itself comes from the catalogue
// (api/ledger/asset-catalogue.ts <- lib/ledger/markIncompatibleMints.ts),
// which proved it on-chain from the mint's permanent delegate; nothing here
// decides eligibility.
//
// Deliberately the same shape as launchpadLabels.ts: the two filters sit side
// by side in the picker and should behave identically.
import { ISSUER_LABELS, SUPPORTED_ISSUERS, type TokenIssuerId } from "@ssr/sdk";

export type IssuerFilter = "all" | TokenIssuerId | "crypto";

export const ISSUER_FILTER_OPTIONS: ReadonlyArray<{ value: IssuerFilter; label: string }> = [
  { value: "all", label: "Any asset type" },
  ...SUPPORTED_ISSUERS.map((id) => ({ value: id as IssuerFilter, label: ISSUER_LABELS[id].name })),
  // Named for what it selects, not for what it excludes: everything without a
  // tokenised-equity issuer is an ordinary crypto asset.
  { value: "crypto", label: "Crypto only" },
];

/** "xStocks" -- the badge beside a tokenised asset in the picker. */
export function issuerBadgeText(issuer: TokenIssuerId): string {
  return ISSUER_LABELS[issuer].name;
}

/** The badge's tooltip: what the token represents and who stands behind it. */
export function issuerBadgeTitle(issuer: TokenIssuerId): string {
  const info = ISSUER_LABELS[issuer];
  return `${info.blurb} (${info.site}). Verified on-chain from the mint's permanent delegate. Not a safety rating.`;
}

export function matchesIssuerFilter(issuer: TokenIssuerId | null | undefined, filter: IssuerFilter): boolean {
  if (filter === "all") return true;
  if (filter === "crypto") return !issuer;
  return issuer === filter;
}
