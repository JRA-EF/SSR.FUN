// CreateDTR.tsx's Reserve Asset picker search predicate -- its own module
// (not defined inline in CreateDTR.tsx) so that page component file only
// exports the component itself.
export interface SelectableAssetLike {
  name: string;
  symbol: string;
  mint: string;
}

/**
 * Pure -- matches on name, ticker, or contract address (mint), all
 * case-insensitive substring matches. An empty/whitespace-only query
 * matches everything. Mint matching is case-insensitive too even though
 * base58 addresses are technically case-sensitive -- a coincidental
 * substring collision across two DIFFERENT real mints in this app's own
 * already-curated/verified catalogue is astronomically unlikely, and the
 * forgiving match is better UX for a pasted/retyped address.
 */
export function matchesAssetSearch(asset: SelectableAssetLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return asset.name.toLowerCase().includes(q) || asset.symbol.toLowerCase().includes(q) || asset.mint.toLowerCase().includes(q);
}
